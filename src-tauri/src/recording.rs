//! Continuous pcapng recording (SRS_capture.md §7, CP-014..019): while the
//! record switch is armed, every frame the reader classifies is appended to a
//! pcapng file by a dedicated writer thread. The reader never blocks on
//! disk — the hand-off queue drops oldest and counts what it dropped.

use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{BufWriter, Read};
use std::path::PathBuf;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(not(test))]
use crate::log;
use crate::log::Level;

pub const QUEUE_CAPACITY: usize = 8_192;
const FLUSH_INTERVAL: Duration = Duration::from_secs(2);
const WRITE_BUFFER: usize = 256 * 1024;
const EVENT_RECORDING_STATE: &str = "recording:state";
/// Files above this size are listed without a frame count.
const COUNT_LIMIT: u64 = 64 * 1024 * 1024;
const LIST_LIMIT: usize = 50;
const DEFAULT_ROTATE_MIB: u32 = 512;
const MIB: u64 = 1024 * 1024;

#[derive(Default)]
pub struct Counters {
    frames: AtomicU64,
    bytes: AtomicU64,
    dropped: AtomicU64,
    files: AtomicU64,
}

impl Counters {
    fn snapshot(&self) -> (u64, u64, u64) {
        (
            self.frames.load(Ordering::Relaxed),
            self.bytes.load(Ordering::Relaxed),
            self.dropped.load(Ordering::Relaxed),
        )
    }

    fn files(&self) -> u64 {
        self.files.load(Ordering::Relaxed)
    }
}

struct QueuedFrame {
    ts_ns: u64,
    dir: u8,
    wire: Vec<u8>,
}

struct Queue {
    entries: VecDeque<QueuedFrame>,
    closed: bool,
}

/// Producer side of the writer queue; `push` never blocks.
#[derive(Clone)]
pub struct RecordingHandle {
    queue: Arc<(Mutex<Queue>, Condvar)>,
    counters: Arc<Counters>,
    capacity: usize,
}

impl RecordingHandle {
    pub fn push(&self, ts_ns: u64, dir: u8, wire: Vec<u8>) {
        let (lock, cv) = &*self.queue;
        if let Ok(mut q) = lock.lock() {
            if q.closed {
                return;
            }
            if q.entries.len() >= self.capacity {
                q.entries.pop_front();
                self.counters.dropped.fetch_add(1, Ordering::Relaxed);
            }
            q.entries.push_back(QueuedFrame { ts_ns, dir, wire });
            cv.notify_one();
        }
    }

    pub fn push_with_dir(&self, ts_ns: u64, dir: u8, wire: Vec<u8>) {
        self.push(ts_ns, dir, wire);
    }

    fn close(&self) {
        let (lock, cv) = &*self.queue;
        if let Ok(mut q) = lock.lock() {
            q.closed = true;
        }
        cv.notify_all();
    }
}

struct Active {
    path: Arc<Mutex<PathBuf>>,
    handle: RecordingHandle,
    started_ms: f64,
    writer: Option<JoinHandle<()>>,
    error: Arc<Mutex<Option<String>>>,
}

struct WriterRun {
    queue: Arc<(Mutex<Queue>, Condvar)>,
    counters: Arc<Counters>,
    error: Arc<Mutex<Option<String>>>,
    dir: PathBuf,
    started: SystemTime,
    rotate_bytes: u64,
    meta: RecordingMeta,
    current_path: Arc<Mutex<PathBuf>>,
}

/// Facts about the most recent recording, kept after it closes so the UI can
/// show what was written.
#[derive(Clone)]
struct LastRecording {
    path: PathBuf,
    frames: u64,
    bytes: u64,
    dropped: u64,
    files: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStateDto {
    pub armed: bool,
    pub active: bool,
    pub path: Option<String>,
    pub frames: u64,
    pub bytes: u64,
    pub dropped: u64,
    pub error: Option<String>,
    pub dir: String,
    /// Wall-clock start of the active recording (ms since the Unix epoch).
    pub started_ms: Option<f64>,
    pub rotate_mib: u32,
    pub files: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub path: String,
    pub bytes: u64,
    pub frames: Option<u64>,
    pub started_ms: f64,
}

pub struct RecordingState {
    armed: AtomicBool,
    /// True while a writer is open — the reader checks this before taking
    /// any lock.
    active_flag: AtomicBool,
    dir: Mutex<PathBuf>,
    active: Mutex<Option<Active>>,
    last: Mutex<Option<LastRecording>>,
    last_error: Mutex<Option<String>>,
    rotate_mib: AtomicU32,
    /// The running session's metadata, so a recording armed mid-session
    /// carries the same source description as one armed before the start.
    session_meta: Mutex<Option<RecordingMeta>>,
}

impl Default for RecordingState {
    fn default() -> Self {
        Self {
            armed: AtomicBool::new(false),
            active_flag: AtomicBool::new(false),
            dir: Mutex::new(PathBuf::new()),
            active: Mutex::new(None),
            last: Mutex::new(None),
            last_error: Mutex::new(None),
            rotate_mib: AtomicU32::new(DEFAULT_ROTATE_MIB),
            session_meta: Mutex::new(None),
        }
    }
}

#[derive(Clone, Debug)]
pub struct RecordingMeta {
    pub source_kind: String,
    pub source_detail: String,
    pub timestamp_source: String,
    pub scenario: Option<String>,
    pub started: SystemTime,
}

impl RecordingMeta {
    fn fallback(started: SystemTime) -> Self {
        Self {
            source_kind: "unknown".into(),
            source_detail: "capture".into(),
            timestamp_source: "reader-ts-ns".into(),
            scenario: None,
            started,
        }
    }

    fn comment(&self) -> String {
        format!(
            "source_kind={}; source_detail={}; timestamp_source={}; scenario={}; started_ms={}",
            self.source_kind,
            self.source_detail,
            self.timestamp_source,
            self.scenario.as_deref().unwrap_or(""),
            unix_ms(self.started)
        )
    }
}

fn set_error(slot: &Mutex<Option<String>>, message: String) {
    if let Ok(mut e) = slot.lock() {
        *e = Some(message);
    }
}

#[cfg(not(test))]
fn recording_log(level: Level, msg: &str, fields: serde_json::Value) {
    log::log(level, "recording", msg, fields);
}

#[cfg(test)]
fn recording_log(_level: Level, _msg: &str, _fields: serde_json::Value) {}

fn run_writer(run: WriterRun) {
    let mut part = 0_u32;
    let mut writer = match open_writer(
        &run.dir,
        run.started,
        part,
        &run.meta,
        &run.current_path,
        &run.counters,
    ) {
        Ok(writer) => writer,
        Err(e) => {
            set_error(&run.error, e);
            return;
        }
    };
    let mut last_flush = Instant::now();
    let mut part_frames = 0_u64;
    let mut pending: Vec<QueuedFrame> = Vec::new();
    loop {
        let closed = {
            let (lock, cv) = &*run.queue;
            let mut q = match lock.lock() {
                Ok(q) => q,
                Err(_) => return,
            };
            while q.entries.is_empty() && !q.closed {
                let (guard, _) = match cv.wait_timeout(q, FLUSH_INTERVAL) {
                    Ok(r) => r,
                    Err(_) => return,
                };
                q = guard;
                if q.entries.is_empty() && !q.closed && last_flush.elapsed() >= FLUSH_INTERVAL {
                    break;
                }
            }
            pending.extend(q.entries.drain(..));
            q.closed
        };
        for frame in pending.drain(..) {
            let projected = writer
                .bytes_written()
                .saturating_add(estimated_epb_len(frame.wire.len(), frame.dir));
            if part_frames > 0 && projected > run.rotate_bytes {
                if let Err(e) = writer.flush() {
                    set_error(&run.error, format!("flush pcapng before rotate: {e}"));
                    return;
                }
                part = part.saturating_add(1);
                recording_log(
                    Level::Info,
                    "recording rotate",
                    serde_json::json!({ "part": part, "rotateBytes": run.rotate_bytes }),
                );
                writer = match open_writer(
                    &run.dir,
                    run.started,
                    part,
                    &run.meta,
                    &run.current_path,
                    &run.counters,
                ) {
                    Ok(writer) => writer,
                    Err(e) => {
                        set_error(&run.error, e);
                        return;
                    }
                };
                part_frames = 0;
            }
            if let Err(e) = writer.write_record(frame.ts_ns, frame.dir, &frame.wire) {
                set_error(&run.error, format!("write pcapng record: {e}"));
                return;
            }
            part_frames += 1;
            run.counters.frames.fetch_add(1, Ordering::Relaxed);
            run.counters.bytes.fetch_add(
                estimated_epb_len(frame.wire.len(), frame.dir),
                Ordering::Relaxed,
            );
        }
        if closed || last_flush.elapsed() >= FLUSH_INTERVAL {
            if let Err(e) = writer.flush() {
                set_error(&run.error, format!("flush pcapng: {e}"));
                return;
            }
            last_flush = Instant::now();
        }
        if closed {
            return;
        }
    }

    fn open_writer(
        dir: &std::path::Path,
        started: SystemTime,
        part: u32,
        meta: &RecordingMeta,
        current_path: &Arc<Mutex<PathBuf>>,
        counters: &Arc<Counters>,
    ) -> Result<radeau_pcap::PcapngWriter<BufWriter<File>>, String> {
        let path = dir.join(file_name(started, part));
        let file = File::create(&path).map_err(|e| format!("create {}: {e}", path.display()))?;
        let writer = radeau_pcap::PcapngWriter::with_comment(
            BufWriter::with_capacity(WRITE_BUFFER, file),
            Some(&meta.comment()),
        )
        .map_err(|e| format!("write pcapng header: {e}"))?;
        if let Ok(mut current) = current_path.lock() {
            *current = path.clone();
        }
        counters.files.fetch_add(1, Ordering::Relaxed);
        recording_log(
            Level::Info,
            "recording file opened",
            serde_json::json!({ "path": path.display().to_string(), "part": part }),
        );
        Ok(writer)
    }
}

fn unix_ms(t: SystemTime) -> f64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn file_name(started: SystemTime, part: u32) -> String {
    // CP-017: session-start timestamp in radeau-yyyyMMdd-HHmmss.pcapng with rotated parts.
    let local: chrono::DateTime<chrono::Local> = started.into();
    if part == 0 {
        format!("radeau-{}.pcapng", local.format("%Y%m%d-%H%M%S"))
    } else {
        format!("radeau-{}-{part:03}.pcapng", local.format("%Y%m%d-%H%M%S"))
    }
}

fn estimated_epb_len(wire_len: usize, dir: u8) -> u64 {
    let data = ((wire_len + 3) & !3) as u64;
    let options = match dir {
        radeau_pcap::DIR_RX | radeau_pcap::DIR_TX => 12_u64,
        _ => 4_u64,
    };
    12 + 20 + data + options
}

impl RecordingState {
    /// Resolves the default recordings directory once the app paths exist.
    pub fn init_dir(&self, app: &AppHandle) {
        let default = app
            .path()
            .document_dir()
            .map(|d| d.join("RadEAU").join("recordings"))
            .unwrap_or_else(|_| PathBuf::from("recordings"));
        if let Ok(mut dir) = self.dir.lock() {
            if dir.as_os_str().is_empty() {
                *dir = default;
            }
        }
        recording_log(
            Level::Info,
            "recordings directory",
            serde_json::json!({ "dir": self.dir_path().display().to_string() }),
        );
    }

    pub fn is_armed(&self) -> bool {
        self.armed.load(Ordering::Acquire)
    }

    pub fn is_active(&self) -> bool {
        self.active_flag.load(Ordering::Acquire)
    }

    pub fn handle(&self) -> Option<RecordingHandle> {
        self.active.lock().ok()?.as_ref().map(|a| a.handle.clone())
    }

    /// (frames, bytes, dropped) of the active recording, zeros otherwise.
    pub fn counters(&self) -> (u64, u64, u64) {
        self.active
            .lock()
            .ok()
            .and_then(|a| a.as_ref().map(|a| a.handle.counters.snapshot()))
            .unwrap_or((0, 0, 0))
    }

    fn dir_path(&self) -> PathBuf {
        self.dir.lock().map(|d| d.clone()).unwrap_or_default()
    }

    pub fn begin_with_meta(&self, app: &AppHandle, meta: RecordingMeta) -> Result<(), String> {
        if let Ok(mut slot) = self.session_meta.lock() {
            *slot = Some(meta.clone());
        }
        if self.begin_inner(meta)? {
            self.emit(app);
        }
        Ok(())
    }

    fn begin_inner(&self, meta: RecordingMeta) -> Result<bool, String> {
        // CP-015: arming while stopped stores intent; begin opens when the next session starts.
        if !self.is_armed() {
            return Ok(false);
        }
        let mut active = self
            .active
            .lock()
            .map_err(|_| "recording state poisoned".to_string())?;
        if active.is_some() {
            return Ok(false);
        }
        let dir = self.dir_path();
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let started = meta.started;
        let path = Arc::new(Mutex::new(dir.join(file_name(started, 0))));
        let queue = Arc::new((
            Mutex::new(Queue {
                entries: VecDeque::with_capacity(QUEUE_CAPACITY),
                closed: false,
            }),
            Condvar::new(),
        ));
        let counters = Arc::new(Counters::default());
        let error = Arc::new(Mutex::new(None));
        let handle = RecordingHandle {
            queue: Arc::clone(&queue),
            counters: Arc::clone(&counters),
            capacity: QUEUE_CAPACITY,
        };
        let (thread_queue, thread_counters, thread_error) = (
            Arc::clone(&queue),
            Arc::clone(&counters),
            Arc::clone(&error),
        );
        let thread_path = Arc::clone(&path);
        let rotate_bytes = u64::from(self.rotate_mib.load(Ordering::Acquire)).saturating_mul(MIB);
        let thread_dir = dir.clone();
        let writer = std::thread::Builder::new()
            .name("pcap-recorder".into())
            .spawn(move || {
                run_writer(WriterRun {
                    queue: thread_queue,
                    counters: thread_counters,
                    error: thread_error,
                    dir: thread_dir,
                    started,
                    rotate_bytes,
                    meta,
                    current_path: thread_path,
                })
            })
            .map_err(|e| format!("spawn recorder: {e}"))?;
        *active = Some(Active {
            path: path.clone(),
            handle,
            started_ms: unix_ms(started),
            writer: Some(writer),
            error,
        });
        drop(active);
        self.active_flag.store(true, Ordering::Release);
        set_error_opt(&self.last_error, None);
        recording_log(
            Level::Info,
            "recording started",
            serde_json::json!({
                "path": path.lock().ok().map(|p| p.display().to_string()),
                "rotateBytes": rotate_bytes
            }),
        );
        Ok(true)
    }

    /// Closes the active file (session end or disarm) and keeps its facts.
    pub fn end(&self, app: &AppHandle) {
        self.end_inner();
        self.emit(app);
    }

    fn end_inner(&self) {
        let taken = self.active.lock().ok().and_then(|mut a| a.take());
        self.active_flag.store(false, Ordering::Release);
        if let Some(mut active) = taken {
            active.handle.close();
            if let Some(writer) = active.writer.take() {
                let _ = writer.join();
            }
            let error = active.error.lock().ok().and_then(|e| e.clone());
            let (frames, bytes, dropped) = active.handle.counters.snapshot();
            let files = active.handle.counters.files();
            let path = active
                .path
                .lock()
                .map(|p| p.clone())
                .unwrap_or_else(|_| PathBuf::new());
            recording_log(
                if error.is_some() {
                    Level::Error
                } else {
                    Level::Info
                },
                "recording closed",
                serde_json::json!({
                    "path": path.display().to_string(),
                    "frames": frames,
                    "bytes": bytes,
                    "dropped": dropped,
                    "files": files,
                    "error": error,
                }),
            );
            if let Ok(mut last) = self.last.lock() {
                *last = Some(LastRecording {
                    path,
                    frames,
                    bytes,
                    dropped,
                    files,
                });
            }
            if let Some(message) = error {
                set_error_opt(&self.last_error, Some(message));
                self.armed.store(false, Ordering::Release);
            }
        }
    }

    /// 1 Hz from the reader: surfaces writer failures and refreshes the UI.
    pub fn tick(&self, app: &AppHandle) {
        if self.tick_inner() {
            self.emit(app);
        }
    }

    fn tick_inner(&self) -> bool {
        if !self.is_active() {
            return false;
        }
        let failed = self.active.lock().ok().and_then(|a| {
            a.as_ref()
                .and_then(|a| a.error.lock().ok().and_then(|e| e.clone()))
        });
        if failed.is_some() {
            self.end_inner();
        }
        true
    }

    pub fn snapshot(&self) -> RecordingStateDto {
        // CP-016: live recording path, frame, byte, and drop counters for the Recorder panel.
        let active = self.active.lock().ok();
        let active = active.as_ref().and_then(|a| a.as_ref());
        let last = self.last.lock().ok().and_then(|l| l.clone());
        let (path, frames, bytes, dropped, files) = match (active, last) {
            (Some(a), _) => {
                let (f, b, d) = a.handle.counters.snapshot();
                (
                    a.path.lock().ok().map(|p| p.display().to_string()),
                    f,
                    b,
                    d,
                    a.handle.counters.files(),
                )
            }
            (None, Some(l)) => (
                Some(l.path.display().to_string()),
                l.frames,
                l.bytes,
                l.dropped,
                l.files,
            ),
            (None, None) => (None, 0, 0, 0, 0),
        };
        RecordingStateDto {
            armed: self.is_armed(),
            active: self.is_active(),
            path,
            frames,
            bytes,
            dropped,
            error: self.last_error.lock().ok().and_then(|e| e.clone()),
            dir: self.dir_path().display().to_string(),
            started_ms: active.map(|a| a.started_ms),
            rotate_mib: self.rotate_mib.load(Ordering::Acquire),
            files,
        }
    }

    pub fn emit(&self, app: &AppHandle) {
        let _ = app.emit(EVENT_RECORDING_STATE, self.snapshot());
    }
}

fn set_error_opt(slot: &Mutex<Option<String>>, value: Option<String>) {
    if let Ok(mut e) = slot.lock() {
        *e = value;
    }
}

fn count_frames(path: &std::path::Path) -> Option<u64> {
    let mut file = File::open(path).ok()?;
    let mut reader = radeau_pcap::PcapReader::new();
    let mut count = 0;
    let mut buffer = [0_u8; 64 * 1024];
    let mut drain = |reader: &mut radeau_pcap::PcapReader| {
        while let Ok(Some(_)) = reader.next_record() {
            count += 1;
        }
    };
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        reader.push(&buffer[..read]);
        drain(&mut reader);
    }
    reader.finish();
    drain(&mut reader);
    Some(count)
}

#[tauri::command]
pub fn recording_state(state: State<RecordingState>) -> RecordingStateDto {
    state.snapshot()
}

#[tauri::command]
pub fn recording_arm(
    state: State<RecordingState>,
    capture: State<crate::capture::CaptureState>,
    app: AppHandle,
    armed: bool,
) -> Result<RecordingStateDto, String> {
    set_recording_armed(&state, capture.is_running(), &app, armed)
}

pub(crate) fn set_recording_armed(
    state: &RecordingState,
    capture_running: bool,
    app: &AppHandle,
    armed: bool,
) -> Result<RecordingStateDto, String> {
    let (dto, should_emit) = set_recording_armed_inner(state, capture_running, armed)?;
    if should_emit {
        state.emit(app);
    }
    Ok(dto)
}

fn set_recording_armed_inner(
    state: &RecordingState,
    capture_running: bool,
    armed: bool,
) -> Result<(RecordingStateDto, bool), String> {
    // CP-015: recording is a sub-state of the running capture session.
    state.armed.store(armed, Ordering::Release);
    let should_emit = if armed {
        if capture_running {
            // CP-018: arming mid-session opens a file now, described by the
            // running session's metadata.
            let meta = state
                .session_meta
                .lock()
                .ok()
                .and_then(|m| m.clone())
                .map_or_else(
                    || RecordingMeta::fallback(SystemTime::now()),
                    |m| RecordingMeta {
                        started: SystemTime::now(),
                        ..m
                    },
                );
            state.begin_inner(meta)?
        } else {
            true
        }
    } else {
        state.end_inner();
        true
    };
    recording_log(
        Level::Info,
        if armed { "armed" } else { "disarmed" },
        serde_json::Value::Null,
    );
    Ok((state.snapshot(), should_emit))
}

#[tauri::command]
pub fn recording_dir_get(state: State<RecordingState>) -> String {
    state.dir_path().display().to_string()
}

#[tauri::command]
pub fn recording_dir_set(
    state: State<RecordingState>,
    app: AppHandle,
    path: String,
) -> Result<String, String> {
    set_recording_dir(&state, &app, path)
}

fn set_recording_dir(
    state: &RecordingState,
    app: &AppHandle,
    path: String,
) -> Result<String, String> {
    let dir = set_recording_dir_inner(state, path)?;
    state.emit(app);
    Ok(dir)
}

fn set_recording_dir_inner(state: &RecordingState, path: String) -> Result<String, String> {
    if state.is_active() {
        return Err("cannot change the directory while a recording is active".into());
    }
    let dir = PathBuf::from(path.trim());
    if dir.as_os_str().is_empty() {
        return Err("directory path is empty".into());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    if let Ok(mut current) = state.dir.lock() {
        *current = dir.clone();
    }
    Ok(dir.display().to_string())
}

#[tauri::command]
pub fn recording_rotate_set(
    state: State<RecordingState>,
    app: AppHandle,
    mib: u32,
) -> Result<RecordingStateDto, String> {
    if mib == 0 {
        return Err("rotation size must be at least 1 MiB".into());
    }
    state.rotate_mib.store(mib, Ordering::Release);
    recording_log(
        Level::Info,
        "recording rotation size set",
        serde_json::json!({ "rotateMib": mib }),
    );
    state.emit(&app);
    Ok(state.snapshot())
}

#[tauri::command]
pub fn recording_list(state: State<RecordingState>) -> Vec<RecordingInfo> {
    list_recordings(&state)
}

pub(crate) fn list_recordings(state: &RecordingState) -> Vec<RecordingInfo> {
    let dir = state.dir_path();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut files: Vec<(f64, PathBuf, u64)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?;
            if !(name.starts_with("radeau-")
                && (name.ends_with(".pcap") || name.ends_with(".pcapng")))
            {
                return None;
            }
            let meta = e.metadata().ok()?;
            let started = meta
                .created()
                .or_else(|_| meta.modified())
                .map(unix_ms)
                .unwrap_or(0.0);
            Some((started, path, meta.len()))
        })
        .collect();
    files.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    files
        .into_iter()
        .take(LIST_LIMIT)
        .map(|(started_ms, path, bytes)| RecordingInfo {
            frames: (bytes < COUNT_LIMIT).then(|| count_frames(&path)).flatten(),
            path: path.display().to_string(),
            bytes,
            started_ms,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    type WriterHarness = (
        RecordingHandle,
        JoinHandle<()>,
        Arc<Mutex<Option<String>>>,
        Arc<Mutex<PathBuf>>,
    );

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "radeau-rec-{tag}-{}-{}",
            std::process::id(),
            unix_ms(SystemTime::now()) as u64
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn spawn_writer(dir: &std::path::Path, capacity: usize) -> WriterHarness {
        let started = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let queue = Arc::new((
            Mutex::new(Queue {
                entries: VecDeque::new(),
                closed: false,
            }),
            Condvar::new(),
        ));
        let counters = Arc::new(Counters::default());
        let error = Arc::new(Mutex::new(None));
        let handle = RecordingHandle {
            queue: Arc::clone(&queue),
            counters: Arc::clone(&counters),
            capacity,
        };
        let (q, c, e) = (
            Arc::clone(&queue),
            Arc::clone(&counters),
            Arc::clone(&error),
        );
        let current_path = Arc::new(Mutex::new(dir.join(file_name(started, 0))));
        let thread_path = Arc::clone(&current_path);
        let dir = dir.to_path_buf();
        let writer = std::thread::spawn(move || {
            run_writer(WriterRun {
                queue: q,
                counters: c,
                error: e,
                dir,
                started,
                rotate_bytes: u64::from(DEFAULT_ROTATE_MIB) * MIB,
                meta: RecordingMeta::fallback(started),
                current_path: thread_path,
            })
        });
        (handle, writer, error, current_path)
    }

    #[test]
    fn writer_round_trips_frames() {
        let dir = temp_dir("roundtrip");
        let (handle, writer, error, current_path) = spawn_writer(&dir, QUEUE_CAPACITY);
        for n in 0..500u64 {
            let dir = if n % 2 == 0 {
                radeau_pcap::DIR_RX
            } else {
                radeau_pcap::DIR_TX
            };
            handle.push_with_dir(
                1_700_000_000_000_000_000 + n * 1_000_000,
                dir,
                vec![n as u8; 60],
            );
        }
        handle.close();
        writer.join().unwrap();
        assert!(error.lock().unwrap().is_none());
        let (frames, bytes, dropped) = handle.counters.snapshot();
        assert_eq!((frames, dropped), (500, 0));
        assert_eq!(bytes, 500 * estimated_epb_len(60, radeau_pcap::DIR_RX));
        let path = current_path.lock().unwrap().clone();
        assert_eq!(count_frames(&path), Some(500));
        let data = fs::read(&path).unwrap();
        let mut reader = radeau_pcap::PcapReader::new();
        reader.push(&data);
        reader.finish();
        let first = reader.next_record().unwrap().unwrap();
        assert_eq!(first.ts_ns, 1_700_000_000_000_000_000);
        assert_eq!(first.wire, vec![0u8; 60]);
        assert_eq!(first.dir, radeau_pcap::DIR_RX);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cp_017_rotation_writes_complete_pcapng_parts() {
        // CP-017: rotation happens between records and every part is a complete pcapng file.
        let dir = temp_dir("rotate");
        let state = RecordingState::default();
        *state.dir.lock().unwrap() = dir.clone();
        state.rotate_mib.store(1, Ordering::Release);
        state.armed.store(true, Ordering::Release);
        state
            .begin_inner(RecordingMeta::fallback(SystemTime::now()))
            .unwrap();
        let handle = state.handle().unwrap();
        for n in 0..8u64 {
            handle.push_with_dir(n, radeau_pcap::DIR_RX, vec![n as u8; 160 * 1024]);
        }
        state.end_inner();

        let snapshot = state.snapshot();
        assert!(snapshot.files > 1);
        let mut total_frames = 0_u64;
        for entry in fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("pcapng") {
                total_frames += count_frames(&path).unwrap();
            }
        }
        assert_eq!(total_frames, 8);
        assert_eq!(snapshot.files, list_recordings(&state).len() as u64);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn count_frames_streams_a_multi_chunk_file() {
        let dir = temp_dir("count-multi-chunk");
        let path = dir.join("radeau-multi-chunk.pcapng");
        let file = File::create(&path).unwrap();
        let mut writer = radeau_pcap::PcapngWriter::new(BufWriter::new(file)).unwrap();
        for n in 0..2_000u64 {
            writer
                .write_record(n, radeau_pcap::DIR_UNKNOWN, &[n as u8; 60])
                .unwrap();
        }
        writer.flush().unwrap();

        assert!(fs::metadata(&path).unwrap().len() > 2 * 64 * 1024);
        assert_eq!(count_frames(&path), Some(2_000));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn queue_drops_oldest_and_counts() {
        let dir = temp_dir("drop");
        let path = dir.join("radeau-drop.pcap");
        // A writer that never runs: fill a tiny queue directly.
        let queue = Arc::new((
            Mutex::new(Queue {
                entries: VecDeque::new(),
                closed: false,
            }),
            Condvar::new(),
        ));
        let counters = Arc::new(Counters::default());
        let handle = RecordingHandle {
            queue,
            counters: Arc::clone(&counters),
            capacity: 4,
        };
        for n in 0..10u64 {
            handle.push(n, radeau_pcap::DIR_UNKNOWN, vec![n as u8]);
        }
        assert_eq!(counters.dropped.load(Ordering::Relaxed), 6);
        let (lock, _) = &*handle.queue;
        let q = lock.lock().unwrap();
        assert_eq!(q.entries.len(), 4);
        assert_eq!(q.entries.front().unwrap().ts_ns, 6);
        drop(q);
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn file_name_is_timestamped() {
        let name = file_name(SystemTime::now(), 0);
        assert!(name.starts_with("radeau-"));
        assert!(name.ends_with(".pcapng"));
        assert_eq!(name.len(), "radeau-YYYYMMDD-HHMMSS.pcapng".len());
        let rotated = file_name(SystemTime::now(), 12);
        assert!(rotated.ends_with("-012.pcapng"));
    }

    #[test]
    fn writer_reports_unwritable_target() {
        let dir = temp_dir("unwritable");
        let blocker = dir.join("radeau-blocked.pcap");
        fs::create_dir_all(&blocker).unwrap();
        assert!(File::create(&blocker).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cp_015_arm_begin_write_end_records_to_temp_dir() {
        // CP-015/CP-016: an armed session opens a pcap writer and reports final counters.
        let dir = temp_dir("begin-end");
        let state = RecordingState::default();
        *state.dir.lock().unwrap() = dir.clone();

        let (armed, emitted) = set_recording_armed_inner(&state, true, true).unwrap();
        assert!(armed.armed);
        assert!(armed.active);
        assert!(emitted);
        assert!(state.is_active());
        let handle = state.handle().expect("active handle");
        handle.push(
            1_700_000_000_000_000_000,
            radeau_pcap::DIR_UNKNOWN,
            vec![0x11; 60],
        );
        handle.push(
            1_700_000_000_001_000_000,
            radeau_pcap::DIR_UNKNOWN,
            vec![0x22; 64],
        );
        state.end_inner();

        let snapshot = state.snapshot();
        assert!(snapshot.armed);
        assert!(!snapshot.active);
        assert_eq!(snapshot.frames, 2);
        assert_eq!(snapshot.dropped, 0);
        assert_eq!(
            snapshot.bytes,
            estimated_epb_len(60, radeau_pcap::DIR_UNKNOWN)
                + estimated_epb_len(64, radeau_pcap::DIR_UNKNOWN)
        );
        assert_eq!(snapshot.files, 1);
        let path = PathBuf::from(snapshot.path.unwrap());
        assert_eq!(path.parent(), Some(dir.as_path()));
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("pcapng"));
        assert_eq!(count_frames(&path), Some(2));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cp_015_disarm_closes_active_recording() {
        // CP-015: disarming while active closes the writer and clears the armed flag.
        let dir = temp_dir("disarm");
        let state = RecordingState::default();
        *state.dir.lock().unwrap() = dir.clone();
        set_recording_armed_inner(&state, true, true).unwrap();
        let handle = state.handle().unwrap();
        handle.push(1, radeau_pcap::DIR_UNKNOWN, vec![0x44; 60]);

        let (dto, emitted) = set_recording_armed_inner(&state, true, false).unwrap();
        assert!(emitted);
        assert!(!dto.armed);
        assert!(!dto.active);
        assert_eq!(dto.frames, 1);
        assert_eq!(state.counters(), (0, 0, 0));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cp_016_dir_set_validates_empty_active_and_create_errors() {
        let state = RecordingState::default();
        assert_eq!(
            set_recording_dir_inner(&state, "   ".into()).unwrap_err(),
            "directory path is empty"
        );
        state.active_flag.store(true, Ordering::Release);
        assert_eq!(
            set_recording_dir_inner(&state, temp_dir("active").display().to_string()).unwrap_err(),
            "cannot change the directory while a recording is active"
        );
        state.active_flag.store(false, Ordering::Release);

        let dir = temp_dir("dir-errors");
        let file = dir.join("not-a-dir");
        fs::write(&file, b"blocker").unwrap();
        let blocked_child = file.join("child");
        let err = set_recording_dir_inner(&state, blocked_child.display().to_string()).unwrap_err();
        assert!(err.starts_with("create "));
        assert!(err.contains("not-a-dir"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cp_016_snapshot_surfaces_writer_failure_and_disarms() {
        // CP-016: writer-thread errors are surfaced through tick/end and stop recording.
        let dir = temp_dir("write-failure");
        let state = RecordingState::default();
        *state.dir.lock().unwrap() = dir.clone();
        state.armed.store(true, Ordering::Release);
        state
            .begin_inner(RecordingMeta::fallback(SystemTime::now()))
            .unwrap();
        state.handle().unwrap().push(
            1,
            radeau_pcap::DIR_UNKNOWN,
            vec![0; radeau_pcap::MAX_RECORD_LEN + 1],
        );

        for _ in 0..100 {
            state.tick_inner();
            if !state.is_active() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        let snapshot = state.snapshot();
        assert!(!snapshot.armed);
        assert!(!snapshot.active);
        let error = snapshot.error.expect("writer error");
        assert!(error.starts_with("write pcapng record:"));
        assert_eq!(snapshot.frames, 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn writer_reports_oversized_record_write_failure() {
        let dir = temp_dir("oversized");
        let (handle, writer, error, _) = spawn_writer(&dir, QUEUE_CAPACITY);
        handle.push(
            1,
            radeau_pcap::DIR_UNKNOWN,
            vec![0; radeau_pcap::MAX_RECORD_LEN + 1],
        );
        handle.close();
        writer.join().unwrap();
        assert!(error
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|e| e.starts_with("write pcapng record:")));
        assert_eq!(handle.counters.snapshot(), (0, 0, 0));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cp_016_recording_list_filters_basenames_counts_and_sorts() {
        // CP-016/CP-017: the UI list exposes radeau-*.pcap and radeau-*.pcapng metadata.
        let dir = temp_dir("list");
        let ignored = dir.join("other.pcap");
        fs::write(&ignored, b"ignored").unwrap();
        let newest = dir.join("radeau-newest.pcapng");
        let oldest = dir.join("radeau-oldest.pcap");
        for (path, frames, pcapng) in [(&oldest, 1_u64, false), (&newest, 3_u64, true)] {
            let file = File::create(path).unwrap();
            if pcapng {
                let mut writer = radeau_pcap::PcapngWriter::new(BufWriter::new(file)).unwrap();
                for n in 0..frames {
                    writer
                        .write_record(n, radeau_pcap::DIR_UNKNOWN, &[n as u8; 60])
                        .unwrap();
                }
                writer.flush().unwrap();
            } else {
                let mut writer = radeau_pcap::PcapWriter::new(BufWriter::new(file)).unwrap();
                for n in 0..frames {
                    writer.write_record(n, &[n as u8; 60]).unwrap();
                }
                writer.flush().unwrap();
            }
            std::thread::sleep(Duration::from_millis(5));
        }

        let state = RecordingState::default();
        *state.dir.lock().unwrap() = dir.clone();
        let list = list_recordings(&state);
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|info| {
            PathBuf::from(&info.path)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("radeau-")
                        && (name.ends_with(".pcap") || name.ends_with(".pcapng"))
                })
        }));
        assert_eq!(
            list.iter().map(|info| info.frames).sum::<Option<u64>>(),
            Some(4)
        );
        let _ = fs::remove_dir_all(dir);
    }
}
