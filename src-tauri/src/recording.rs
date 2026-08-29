//! Continuous pcap recording (SRS_capture.md §7, CP-014..016): while the
//! record switch is armed, every frame the reader classifies is appended to a
//! classic pcap file by a dedicated writer thread. The reader never blocks on
//! disk — the hand-off queue drops oldest and counts what it dropped.

use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::log::{self, Level};

pub const QUEUE_CAPACITY: usize = 8_192;
const FLUSH_INTERVAL: Duration = Duration::from_secs(2);
const WRITE_BUFFER: usize = 256 * 1024;
const EVENT_RECORDING_STATE: &str = "recording:state";
/// Files above this size are listed without a frame count.
const COUNT_LIMIT: u64 = 64 * 1024 * 1024;
const LIST_LIMIT: usize = 50;

#[derive(Default)]
pub struct Counters {
    frames: AtomicU64,
    bytes: AtomicU64,
    dropped: AtomicU64,
}

impl Counters {
    fn snapshot(&self) -> (u64, u64, u64) {
        (
            self.frames.load(Ordering::Relaxed),
            self.bytes.load(Ordering::Relaxed),
            self.dropped.load(Ordering::Relaxed),
        )
    }
}

struct Queue {
    entries: VecDeque<(u64, Vec<u8>)>,
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
    pub fn push(&self, ts_ns: u64, wire: Vec<u8>) {
        let (lock, cv) = &*self.queue;
        if let Ok(mut q) = lock.lock() {
            if q.closed {
                return;
            }
            if q.entries.len() >= self.capacity {
                q.entries.pop_front();
                self.counters.dropped.fetch_add(1, Ordering::Relaxed);
            }
            q.entries.push_back((ts_ns, wire));
            cv.notify_one();
        }
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
    path: PathBuf,
    handle: RecordingHandle,
    started_ms: f64,
    writer: Option<JoinHandle<()>>,
    error: Arc<Mutex<Option<String>>>,
}

/// Facts about the most recent recording, kept after it closes so the UI can
/// show what was written.
#[derive(Clone)]
struct LastRecording {
    path: PathBuf,
    frames: u64,
    bytes: u64,
    dropped: u64,
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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub path: String,
    pub bytes: u64,
    pub frames: Option<u64>,
    pub started_ms: f64,
}

#[derive(Default)]
pub struct RecordingState {
    armed: AtomicBool,
    /// True while a writer is open — the reader checks this before taking
    /// any lock.
    active_flag: AtomicBool,
    dir: Mutex<PathBuf>,
    active: Mutex<Option<Active>>,
    last: Mutex<Option<LastRecording>>,
    last_error: Mutex<Option<String>>,
}

fn set_error(slot: &Mutex<Option<String>>, message: String) {
    if let Ok(mut e) = slot.lock() {
        *e = Some(message);
    }
}

fn run_writer(
    queue: Arc<(Mutex<Queue>, Condvar)>,
    counters: Arc<Counters>,
    error: Arc<Mutex<Option<String>>>,
    file: File,
) {
    let mut writer =
        match radeau_pcap::PcapWriter::new(BufWriter::with_capacity(WRITE_BUFFER, file)) {
            Ok(writer) => writer,
            Err(e) => {
                set_error(&error, format!("write pcap header: {e}"));
                return;
            }
        };
    let mut last_flush = Instant::now();
    let mut pending: Vec<(u64, Vec<u8>)> = Vec::new();
    loop {
        let closed = {
            let (lock, cv) = &*queue;
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
        for (ts_ns, wire) in pending.drain(..) {
            if let Err(e) = writer.write_record(ts_ns, &wire) {
                set_error(&error, format!("write pcap record: {e}"));
                return;
            }
            counters.frames.fetch_add(1, Ordering::Relaxed);
            counters
                .bytes
                .fetch_add(16 + wire.len() as u64, Ordering::Relaxed);
        }
        if closed || last_flush.elapsed() >= FLUSH_INTERVAL {
            if let Err(e) = writer.flush() {
                set_error(&error, format!("flush pcap: {e}"));
                return;
            }
            last_flush = Instant::now();
        }
        if closed {
            return;
        }
    }
}

fn unix_ms(t: SystemTime) -> f64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn file_name(started: SystemTime) -> String {
    let local: chrono::DateTime<chrono::Local> = started.into();
    format!("radeau-{}.pcap", local.format("%Y%m%d-%H%M%S"))
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
        log::log(
            Level::Info,
            "recording",
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

    /// Opens the session's file when armed; a no-op otherwise or while one
    /// is already open.
    pub fn begin(&self, app: &AppHandle, started: SystemTime) -> Result<(), String> {
        if !self.is_armed() {
            return Ok(());
        }
        let mut active = self
            .active
            .lock()
            .map_err(|_| "recording state poisoned".to_string())?;
        if active.is_some() {
            return Ok(());
        }
        let dir = self.dir_path();
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let path = dir.join(file_name(started));
        let file = File::create(&path).map_err(|e| format!("create {}: {e}", path.display()))?;
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
        let writer = std::thread::Builder::new()
            .name("pcap-recorder".into())
            .spawn(move || run_writer(thread_queue, thread_counters, thread_error, file))
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
        log::log(
            Level::Info,
            "recording",
            "recording started",
            serde_json::json!({ "path": path.display().to_string() }),
        );
        self.emit(app);
        Ok(())
    }

    /// Closes the active file (session end or disarm) and keeps its facts.
    pub fn end(&self, app: &AppHandle) {
        let taken = self.active.lock().ok().and_then(|mut a| a.take());
        self.active_flag.store(false, Ordering::Release);
        if let Some(mut active) = taken {
            active.handle.close();
            if let Some(writer) = active.writer.take() {
                let _ = writer.join();
            }
            let error = active.error.lock().ok().and_then(|e| e.clone());
            let (frames, bytes, dropped) = active.handle.counters.snapshot();
            log::log(
                if error.is_some() {
                    Level::Error
                } else {
                    Level::Info
                },
                "recording",
                "recording closed",
                serde_json::json!({
                    "path": active.path.display().to_string(),
                    "frames": frames,
                    "bytes": bytes,
                    "dropped": dropped,
                    "error": error,
                }),
            );
            if let Ok(mut last) = self.last.lock() {
                *last = Some(LastRecording {
                    path: active.path,
                    frames,
                    bytes,
                    dropped,
                });
            }
            if let Some(message) = error {
                set_error_opt(&self.last_error, Some(message));
                self.armed.store(false, Ordering::Release);
            }
        }
        self.emit(app);
    }

    /// 1 Hz from the reader: surfaces writer failures and refreshes the UI.
    pub fn tick(&self, app: &AppHandle) {
        if !self.is_active() {
            return;
        }
        let failed = self.active.lock().ok().and_then(|a| {
            a.as_ref()
                .and_then(|a| a.error.lock().ok().and_then(|e| e.clone()))
        });
        if failed.is_some() {
            self.end(app);
        } else {
            self.emit(app);
        }
    }

    pub fn snapshot(&self) -> RecordingStateDto {
        let active = self.active.lock().ok();
        let active = active.as_ref().and_then(|a| a.as_ref());
        let last = self.last.lock().ok().and_then(|l| l.clone());
        let (path, frames, bytes, dropped) = match (active, last) {
            (Some(a), _) => {
                let (f, b, d) = a.handle.counters.snapshot();
                (Some(a.path.display().to_string()), f, b, d)
            }
            (None, Some(l)) => (
                Some(l.path.display().to_string()),
                l.frames,
                l.bytes,
                l.dropped,
            ),
            (None, None) => (None, 0, 0, 0),
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
    let bytes = fs::read(path).ok()?;
    let mut reader = radeau_pcap::PcapReader::new();
    reader.push(&bytes);
    reader.finish();
    let mut count = 0;
    loop {
        match reader.next() {
            Ok(Some(_)) => count += 1,
            _ => break,
        }
    }
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
    state.armed.store(armed, Ordering::Release);
    if armed {
        if capture.is_running() {
            state.begin(&app, SystemTime::now())?;
        } else {
            state.emit(&app);
        }
    } else {
        state.end(&app);
    }
    log::log(
        Level::Info,
        "recording",
        if armed { "armed" } else { "disarmed" },
        serde_json::Value::Null,
    );
    Ok(state.snapshot())
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
    state.emit(&app);
    Ok(dir.display().to_string())
}

#[tauri::command]
pub fn recording_list(state: State<RecordingState>) -> Vec<RecordingInfo> {
    let dir = state.dir_path();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut files: Vec<(f64, PathBuf, u64)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?;
            if !(name.starts_with("radeau-") && name.ends_with(".pcap")) {
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

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "radeau-rec-{tag}-{}-{}",
            std::process::id(),
            unix_ms(SystemTime::now()) as u64
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn spawn_writer(
        path: &std::path::Path,
        capacity: usize,
    ) -> (RecordingHandle, JoinHandle<()>, Arc<Mutex<Option<String>>>) {
        let file = File::create(path).unwrap();
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
        let writer = std::thread::spawn(move || run_writer(q, c, e, file));
        (handle, writer, error)
    }

    #[test]
    fn writer_round_trips_frames() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("radeau-test.pcap");
        let (handle, writer, error) = spawn_writer(&path, QUEUE_CAPACITY);
        for n in 0..500u64 {
            handle.push(1_700_000_000_000_000_000 + n * 1_000_000, vec![n as u8; 60]);
        }
        handle.close();
        writer.join().unwrap();
        assert!(error.lock().unwrap().is_none());
        let (frames, bytes, dropped) = handle.counters.snapshot();
        assert_eq!((frames, dropped), (500, 0));
        assert_eq!(bytes, 500 * (16 + 60));
        assert_eq!(count_frames(&path), Some(500));
        let data = fs::read(&path).unwrap();
        let mut reader = radeau_pcap::PcapReader::new();
        reader.push(&data);
        reader.finish();
        let first = reader.next().unwrap().unwrap();
        assert_eq!(first.ts_ns, 1_700_000_000_000_000_000);
        assert_eq!(first.wire, vec![0u8; 60]);
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
            handle.push(n, vec![n as u8]);
        }
        assert_eq!(counters.dropped.load(Ordering::Relaxed), 6);
        let (lock, _) = &*handle.queue;
        let q = lock.lock().unwrap();
        assert_eq!(q.entries.len(), 4);
        assert_eq!(q.entries.front().unwrap().0, 6);
        drop(q);
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn file_name_is_timestamped() {
        let name = file_name(SystemTime::now());
        assert!(name.starts_with("radeau-"));
        assert!(name.ends_with(".pcap"));
        assert_eq!(name.len(), "radeau-YYYYMMDD-HHMMSS.pcap".len());
    }

    #[test]
    fn writer_reports_unwritable_target() {
        let dir = temp_dir("unwritable");
        let blocker = dir.join("radeau-blocked.pcap");
        fs::create_dir_all(&blocker).unwrap();
        assert!(File::create(&blocker).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
