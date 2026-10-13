//! Replay transport (SRS_capture §9, CP-020..023): file prepare with a sparse
//! seek index, and the shared control a running file replay reads from.
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

const EVENT_REPLAY_PREPARE: &str = "replay:prepare";
const PREPARE_PROGRESS_THRESHOLD: u64 = 16 * 1024 * 1024;
const PREPARE_CHUNK: usize = 64 * 1024;
const CHECKPOINT_FRAMES: u64 = 5_000;
pub const POSITION_INTERVAL: Duration = Duration::from_millis(100);
pub const SLEEP_CAP: Duration = Duration::from_millis(50);

const STATE_PLAYING: u8 = 0;
const STATE_PAUSED: u8 = 1;
const STATE_ENDED: u8 = 2;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayInfo {
    pub path: String,
    pub frames: u64,
    pub first_ts_ns: u64,
    pub last_ts_ns: u64,
    pub duration_ns: u64,
    pub interfaces: Vec<String>,
    pub comment: Option<String>,
    pub cut: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPosition {
    pub state: &'static str,
    pub t_ns: u64,
    pub frame: u64,
    pub frames: u64,
    pub duration_ns: u64,
    pub speed: Option<f64>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySeek {
    pub t_ns: u64,
    pub frame: u64,
}

#[derive(Clone, Debug, Serialize)]
struct PrepareProgress {
    done: u64,
    total: u64,
}

/// One resume point every `CHECKPOINT_FRAMES` frames (CP-020): the index is
/// O(frames / 5,000), never a per-frame table.
#[derive(Clone, Debug)]
pub struct ReplayCheckpoint {
    pub frame: u64,
    pub ts_ns: u64,
    /// Stream offset of the checkpoint frame's record / block.
    pub byte_offset: u64,
    /// Length of `ReplayIndex::header` valid at this frame.
    pub header_len: usize,
}

#[derive(Clone, Debug)]
pub struct ReplayIndex {
    pub info: ReplayInfo,
    pub checkpoints: Vec<ReplayCheckpoint>,
    /// Classic file header or pcapng SHB + IDB blocks — fed to a fresh reader
    /// before resuming at a checkpoint offset.
    pub header: Vec<u8>,
}

#[derive(Default)]
pub struct ReplayState {
    prepared: Mutex<HashMap<String, Arc<ReplayIndex>>>,
    last_opened: Mutex<Option<String>>,
    /// The running replay's control. Weak: it lapses by itself when the
    /// session's source (the only strong owner) is dropped at session end.
    live: Mutex<Option<Weak<ReplayControl>>>,
    last_position: Mutex<Option<ReplayPosition>>,
}

impl ReplayState {
    pub fn prepared_for_path(
        &self,
        path: &str,
        pace: &str,
    ) -> Result<(Arc<ReplayIndex>, Arc<ReplayControl>), String> {
        let index = {
            let mut prepared = self.prepared.lock().map_err(|_| "replay state poisoned")?;
            if let Some(index) = prepared.get(path) {
                Arc::clone(index)
            } else {
                let (_, index) = prepare(path, None)?;
                let index = Arc::new(index);
                prepared.insert(path.to_string(), Arc::clone(&index));
                index
            }
        };
        let control = ReplayControl::new(index.info.clone(), pace_to_speed(pace)?);
        *self.live.lock().map_err(|_| "replay state poisoned")? = Some(Arc::downgrade(&control));
        Ok((index, control))
    }

    fn live(&self) -> Result<Arc<ReplayControl>, String> {
        self.live
            .lock()
            .map_err(|_| "replay state poisoned")?
            .as_ref()
            .and_then(Weak::upgrade)
            .ok_or_else(|| "no replay session".to_string())
    }

    pub(crate) fn automation_status(&self) -> ReplayStatus {
        let info = self
            .last_opened
            .lock()
            .ok()
            .and_then(|path| path.clone())
            .and_then(|path| {
                self.prepared
                    .lock()
                    .ok()
                    .and_then(|prepared| prepared.get(&path).map(|index| index.info.clone()))
            });
        let position = self
            .live()
            .ok()
            .map(|control| control.position())
            .or_else(|| self.last_position.lock().ok().and_then(|p| p.clone()));
        ReplayStatus { info, position }
    }

    /// Remembers the last emitted position so `replay_status` still answers
    /// (e.g. `ended`) after the replay session and its control are gone.
    pub(crate) fn remember_position(&self, position: &ReplayPosition) {
        if let Ok(mut last) = self.last_position.lock() {
            *last = Some(position.clone());
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStatus {
    pub info: Option<ReplayInfo>,
    pub position: Option<ReplayPosition>,
}

#[derive(Clone, Copy, Debug)]
struct Anchor {
    wall: Instant,
    ts_ns: u64,
}

#[derive(Debug)]
pub struct ReplayControl {
    info: ReplayInfo,
    state: AtomicU8,
    speed_bits: AtomicU64,
    pending_seek: Mutex<Option<u64>>,
    pending_step: AtomicBool,
    anchor: Mutex<Anchor>,
    current_t_ns: AtomicU64,
    current_frame: AtomicU64,
}

impl ReplayControl {
    pub fn new(info: ReplayInfo, speed: Option<f64>) -> Arc<Self> {
        Arc::new(Self {
            info,
            state: AtomicU8::new(STATE_PLAYING),
            speed_bits: AtomicU64::new(speed_to_bits(speed)),
            pending_seek: Mutex::new(None),
            pending_step: AtomicBool::new(false),
            anchor: Mutex::new(Anchor {
                wall: Instant::now(),
                ts_ns: 0,
            }),
            current_t_ns: AtomicU64::new(0),
            current_frame: AtomicU64::new(0),
        })
    }

    pub fn info(&self) -> &ReplayInfo {
        &self.info
    }

    pub fn play(&self) {
        self.state.store(STATE_PLAYING, Ordering::Release);
        self.reanchor(self.current_t_ns.load(Ordering::Acquire));
    }

    pub fn pause(&self) {
        self.state.store(STATE_PAUSED, Ordering::Release);
        self.reanchor(self.current_t_ns.load(Ordering::Acquire));
    }

    pub fn step(&self) {
        self.pending_step.store(true, Ordering::Release);
        self.state.store(STATE_PLAYING, Ordering::Release);
        self.reanchor(self.current_t_ns.load(Ordering::Acquire));
    }

    pub fn seek(&self, relative_t_ns: u64) {
        let clamped = relative_t_ns.min(self.info.duration_ns);
        if let Ok(mut pending) = self.pending_seek.lock() {
            *pending = Some(clamped);
        }
        self.reanchor(clamped);
        self.current_t_ns.store(clamped, Ordering::Release);
    }

    pub fn set_speed(&self, speed: Option<f64>) -> Result<(), String> {
        validate_speed(speed)?;
        self.speed_bits
            .store(speed_to_bits(speed), Ordering::Release);
        self.reanchor(self.current_t_ns.load(Ordering::Acquire));
        Ok(())
    }

    pub fn speed(&self) -> Option<f64> {
        bits_to_speed(self.speed_bits.load(Ordering::Acquire))
    }

    pub fn state_name(&self) -> &'static str {
        match self.state.load(Ordering::Acquire) {
            STATE_PLAYING => "playing",
            STATE_PAUSED => "paused",
            _ => "ended",
        }
    }

    pub fn has_pending_seek(&self) -> bool {
        self.pending_seek
            .lock()
            .is_ok_and(|pending| pending.is_some())
    }

    pub fn is_paused_without_step(&self) -> bool {
        self.state.load(Ordering::Acquire) == STATE_PAUSED
            && !self.pending_step.load(Ordering::Acquire)
    }

    pub fn take_step(&self) -> bool {
        self.pending_step.swap(false, Ordering::AcqRel)
    }

    pub fn finish_step(&self) {
        self.state.store(STATE_PAUSED, Ordering::Release);
        self.reanchor(self.current_t_ns.load(Ordering::Acquire));
    }

    pub fn mark_ended(&self) {
        self.state.store(STATE_ENDED, Ordering::Release);
        self.current_t_ns
            .store(self.info.duration_ns, Ordering::Release);
        self.current_frame
            .store(self.info.frames, Ordering::Release);
    }

    pub fn take_seek(&self) -> Option<u64> {
        self.pending_seek.lock().ok()?.take()
    }

    pub fn observe_frame(&self, absolute_ts_ns: u64, frame: u64) {
        let relative = absolute_ts_ns.saturating_sub(self.info.first_ts_ns);
        self.current_t_ns.store(relative, Ordering::Release);
        self.current_frame.store(frame, Ordering::Release);
    }

    pub fn position(&self) -> ReplayPosition {
        ReplayPosition {
            state: self.state_name(),
            t_ns: self
                .current_t_ns
                .load(Ordering::Acquire)
                .min(self.info.duration_ns),
            frame: self
                .current_frame
                .load(Ordering::Acquire)
                .min(self.info.frames),
            frames: self.info.frames,
            duration_ns: self.info.duration_ns,
            speed: self.speed(),
        }
    }

    pub fn sleep_until_due(&self, frame_relative_ts_ns: u64) -> Option<Duration> {
        self.speed().and_then(|speed| {
            let anchor = *self.anchor.lock().ok()?;
            schedule_sleep(
                anchor.wall,
                anchor.ts_ns,
                frame_relative_ts_ns,
                speed,
                Instant::now(),
            )
        })
    }

    fn reanchor(&self, ts_ns: u64) {
        if let Ok(mut anchor) = self.anchor.lock() {
            *anchor = Anchor {
                wall: Instant::now(),
                ts_ns,
            };
        }
    }
}

fn speed_to_bits(speed: Option<f64>) -> u64 {
    speed.map(f64::to_bits).unwrap_or(0)
}

fn bits_to_speed(bits: u64) -> Option<f64> {
    (bits != 0).then(|| f64::from_bits(bits))
}

fn pace_to_speed(pace: &str) -> Result<Option<f64>, String> {
    match pace {
        "realtime" => Ok(Some(1.0)),
        "fast" => Ok(None),
        _ => Err(format!("unknown pcap pace '{pace}'")),
    }
}

pub fn validate_speed(speed: Option<f64>) -> Result<(), String> {
    const ALLOWED: [f64; 7] = [0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0];
    if speed.is_none() || speed.is_some_and(|s| ALLOWED.contains(&s)) {
        Ok(())
    } else {
        Err("replay speed must be one of 0.1, 0.25, 0.5, 1, 2, 5, 10, or null".into())
    }
}

pub fn schedule_sleep(
    anchor_wall: Instant,
    anchor_t_ns: u64,
    frame_t_ns: u64,
    speed: f64,
    now: Instant,
) -> Option<Duration> {
    if speed <= 0.0 || !speed.is_finite() {
        return None;
    }
    let delta = frame_t_ns.saturating_sub(anchor_t_ns);
    let due = anchor_wall + Duration::from_secs_f64(delta as f64 / 1_000_000_000.0 / speed);
    due.checked_duration_since(now)
        .filter(|remaining| !remaining.is_zero())
        .map(|remaining| remaining.min(SLEEP_CAP))
}

/// A reader positioned at a seek target (CP-022).
pub struct SeekResult {
    pub file: File,
    pub reader: radeau_pcap::PcapReader,
    /// The first record at or after the target; `None` past the end.
    pub pending: Option<radeau_pcap::Record>,
    /// Frame number of `pending` (or the frame count past the end).
    pub frame: u64,
    pub previous_ts: Option<u64>,
}

/// CP-022: opens `path` at the checkpoint at or before the target and skips
/// forward — at most `CHECKPOINT_FRAMES` records, never emitted — to the first
/// record at or after `relative_t_ns` (relative to the file's first frame).
pub fn open_at(path: &str, index: &ReplayIndex, relative_t_ns: u64) -> Result<SeekResult, String> {
    let target = index
        .info
        .first_ts_ns
        .saturating_add(relative_t_ns.min(index.info.duration_ns));
    let at = index
        .checkpoints
        .partition_point(|cp| cp.ts_ns <= target)
        .saturating_sub(1);
    let (mut frame, offset, header_len) = index
        .checkpoints
        .get(at)
        .map_or((0, 0, 0), |cp| (cp.frame, cp.byte_offset, cp.header_len));
    let mut file = File::open(Path::new(path)).map_err(|error| format!("open {path}: {error}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("seek {path}: {error}"))?;
    let mut reader = radeau_pcap::PcapReader::new();
    reader.push(&index.header[..header_len.min(index.header.len())]);
    let mut previous_ts = None;
    let mut scratch = vec![0u8; PREPARE_CHUNK];
    let mut eof = false;
    loop {
        match reader.next_record() {
            Ok(Some(record)) if record.ts_ns >= target => {
                return Ok(SeekResult {
                    file,
                    reader,
                    pending: Some(record),
                    frame,
                    previous_ts,
                });
            }
            Ok(Some(record)) => {
                previous_ts = Some(record.ts_ns);
                frame += 1;
            }
            Ok(None) if eof => break,
            Ok(None) => match file.read(&mut scratch) {
                Ok(0) => {
                    reader.finish();
                    eof = true;
                }
                Ok(count) => reader.push(&scratch[..count]),
                Err(error) => return Err(format!("read {path}: {error}")),
            },
            Err(radeau_pcap::PcapError::Ended { .. }) => break,
            Err(error) => return Err(format!("{path}: {error}")),
        }
    }
    Ok(SeekResult {
        file,
        reader,
        pending: None,
        frame,
        previous_ts,
    })
}

/// CP-020: one streaming pass through the shared pcap/pcapng reader — bounded
/// memory (a 64 KiB read buffer plus one checkpoint per 5,000 frames),
/// progress at most every 250 ms for files above 16 MiB.
pub fn prepare(path: &str, app: Option<&AppHandle>) -> Result<(ReplayInfo, ReplayIndex), String> {
    let path_ref = Path::new(path);
    let total = std::fs::metadata(path_ref)
        .map_err(|error| format!("stat {path}: {error}"))?
        .len();
    let mut file = File::open(path_ref).map_err(|error| format!("open {path}: {error}"))?;
    let mut reader = radeau_pcap::PcapReader::new();
    let mut scratch = vec![0u8; PREPARE_CHUNK];
    let mut checkpoints = Vec::new();
    let (mut frames, mut first, mut last) = (0u64, None::<u64>, 0u64);
    let (mut done, mut eof, mut cut) = (0u64, false, false);
    let mut last_progress: Option<Instant> = None;
    loop {
        match reader.next_record() {
            Ok(Some(record)) => {
                if frames.is_multiple_of(CHECKPOINT_FRAMES) {
                    checkpoints.push(ReplayCheckpoint {
                        frame: frames,
                        ts_ns: record.ts_ns,
                        byte_offset: reader.last_record_offset(),
                        header_len: reader.header_bytes().len(),
                    });
                }
                first.get_or_insert(record.ts_ns);
                last = last.max(record.ts_ns);
                frames += 1;
            }
            Ok(None) if eof => break,
            Ok(None) => {
                let count = file
                    .read(&mut scratch)
                    .map_err(|error| format!("read {path}: {error}"))?;
                if count == 0 {
                    reader.finish();
                    eof = true;
                    continue;
                }
                reader.push(&scratch[..count]);
                done += count as u64;
                if let Some(app) = app.filter(|_| total > PREPARE_PROGRESS_THRESHOLD) {
                    if last_progress.is_none_or(|t| t.elapsed() >= Duration::from_millis(250)) {
                        let _ = app.emit(EVENT_REPLAY_PREPARE, PrepareProgress { done, total });
                        last_progress = Some(Instant::now());
                    }
                }
            }
            Err(radeau_pcap::PcapError::Ended { cut: c }) => {
                cut = c;
                break;
            }
            Err(error) => return Err(format!("{path}: {error}")),
        }
    }
    let first = first.unwrap_or(0);
    let last = last.max(first);
    let info = ReplayInfo {
        path: path.to_string(),
        frames,
        first_ts_ns: first,
        last_ts_ns: last,
        duration_ns: last - first,
        interfaces: reader.interface_names(),
        comment: reader.section_comment().map(str::to_string),
        cut,
    };
    let index = ReplayIndex {
        info: info.clone(),
        checkpoints,
        header: reader.header_bytes().to_vec(),
    };
    Ok((info, index))
}

/// CP-020: prepares on the blocking pool — never on the main thread.
#[tauri::command]
pub async fn replay_open(
    state: State<'_, ReplayState>,
    app: AppHandle,
    path: String,
) -> Result<ReplayInfo, String> {
    let task_app = app.clone();
    let task_path = path.clone();
    let (info, index) =
        tauri::async_runtime::spawn_blocking(move || prepare(&task_path, Some(&task_app)))
            .await
            .map_err(|e| format!("replay prepare failed: {e}"))??;
    state
        .prepared
        .lock()
        .map_err(|_| "replay state poisoned")?
        .insert(path.clone(), Arc::new(index));
    *state
        .last_opened
        .lock()
        .map_err(|_| "replay state poisoned")? = Some(path);
    crate::automation::emit_replay_opened(&app, &info);
    Ok(info)
}

pub(crate) fn replay_open_blocking(
    state: &ReplayState,
    app: &AppHandle,
    path: String,
) -> Result<ReplayInfo, String> {
    let (info, index) = prepare(&path, Some(app))?;
    state
        .prepared
        .lock()
        .map_err(|_| "replay state poisoned")?
        .insert(path.clone(), Arc::new(index));
    *state
        .last_opened
        .lock()
        .map_err(|_| "replay state poisoned")? = Some(path);
    crate::automation::emit_replay_opened(app, &info);
    Ok(info)
}

#[tauri::command]
pub fn replay_play(
    state: State<ReplayState>,
    capture: State<crate::capture::CaptureState>,
    app: AppHandle,
) -> Result<ReplayPosition, String> {
    replay_play_inner(&state, &capture, &app)
}

pub(crate) fn replay_play_inner(
    state: &ReplayState,
    capture: &crate::capture::CaptureState,
    app: &AppHandle,
) -> Result<ReplayPosition, String> {
    let control = match state.live() {
        Ok(control) => control,
        Err(_) => {
            let path = state
                .last_opened
                .lock()
                .map_err(|_| "replay state poisoned")?
                .clone()
                .ok_or_else(|| "no replay file opened".to_string())?;
            crate::capture::start_session(
                capture,
                app.clone(),
                crate::capture::SourceSpec::Pcap {
                    path,
                    pace: "realtime".into(),
                },
            )?;
            state.live()?
        }
    };
    control.play();
    emit_position(app, &control);
    Ok(control.position())
}

#[tauri::command]
pub fn replay_pause(state: State<ReplayState>, app: AppHandle) -> Result<ReplayPosition, String> {
    replay_pause_inner(&state, &app)
}

pub(crate) fn replay_pause_inner(
    state: &ReplayState,
    app: &AppHandle,
) -> Result<ReplayPosition, String> {
    let control = state.live()?;
    control.pause();
    emit_position(app, &control);
    Ok(control.position())
}

#[tauri::command]
pub fn replay_step(state: State<ReplayState>, app: AppHandle) -> Result<ReplayPosition, String> {
    replay_step_inner(&state, &app)
}

pub(crate) fn replay_step_inner(
    state: &ReplayState,
    app: &AppHandle,
) -> Result<ReplayPosition, String> {
    let control = state.live()?;
    control.step();
    emit_position(app, &control);
    Ok(control.position())
}

#[tauri::command]
pub fn replay_seek(
    state: State<ReplayState>,
    app: AppHandle,
    t_ns: u64,
) -> Result<ReplayPosition, String> {
    replay_seek_inner(&state, &app, t_ns)
}

pub(crate) fn replay_seek_inner(
    state: &ReplayState,
    app: &AppHandle,
    t_ns: u64,
) -> Result<ReplayPosition, String> {
    let control = state.live()?;
    control.seek(t_ns);
    emit_position(app, &control);
    Ok(control.position())
}

#[tauri::command]
pub fn replay_set_speed(
    state: State<ReplayState>,
    app: AppHandle,
    speed: Option<f64>,
) -> Result<ReplayPosition, String> {
    replay_set_speed_inner(&state, &app, speed)
}

pub(crate) fn replay_set_speed_inner(
    state: &ReplayState,
    app: &AppHandle,
    speed: Option<f64>,
) -> Result<ReplayPosition, String> {
    let control = state.live()?;
    control.set_speed(speed)?;
    emit_position(app, &control);
    Ok(control.position())
}

#[tauri::command]
pub fn replay_status(state: State<ReplayState>) -> ReplayStatus {
    state.automation_status()
}

pub fn emit_position(app: &AppHandle, control: &ReplayControl) {
    let position = control.position();
    // CP-007: every transport command lands in the core event log.
    crate::log::log(
        crate::log::Level::Info,
        "replay",
        "transport",
        serde_json::json!({
            "state": position.state,
            "tNs": position.t_ns,
            "frame": position.frame,
            "speed": position.speed,
        }),
    );
    crate::capture::emit_replay_position_from_app(app, position);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcap_bytes(count: usize) -> Vec<u8> {
        let mut writer = radeau_pcap::PcapWriter::new(Vec::new()).unwrap();
        for index in 0..count {
            writer
                .write_record(1_000_000_000 + index as u64 * 1_000_000, &[index as u8; 60])
                .unwrap();
        }
        writer.into_inner()
    }

    fn temp_pcap(name: &str, count: usize) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "radeau-replay-{name}-{}-{}.pcap",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        std::fs::write(&path, pcap_bytes(count)).unwrap();
        path
    }

    #[test]
    fn cp_020_prepare_counts_fixture_and_checkpoints() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("fixtures")
            .join("pcap")
            .join("sensor-fusion-5s.pcap");
        let (info, index) = prepare(path.to_str().unwrap(), None).unwrap();
        assert!(info.frames > 0);
        assert_eq!(
            index.checkpoints.len() as u64,
            info.frames.div_ceil(CHECKPOINT_FRAMES)
        );
        assert!(info.last_ts_ns >= info.first_ts_ns);
        assert_eq!(info.duration_ns, info.last_ts_ns - info.first_ts_ns);
        assert_eq!(index.checkpoints.first().unwrap().frame, 0);
        assert_eq!(info.interfaces, vec!["pcap"]);
    }

    #[test]
    fn cp_020_prepare_adds_every_5000_frame_checkpoint() {
        let path = temp_pcap("checkpoints", 10_001);
        let (_, index) = prepare(path.to_str().unwrap(), None).unwrap();
        assert_eq!(
            index
                .checkpoints
                .iter()
                .map(|cp| cp.frame)
                .collect::<Vec<_>>(),
            vec![0, 5_000, 10_000]
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cp_021_schedule_speed_change_reanchors_without_drift() {
        let wall = Instant::now();
        let anchor_t_ns = 5_000_000_000;
        let due = schedule_sleep(wall, anchor_t_ns, 5_010_000_000, 2.0, wall).unwrap();
        assert_eq!(due, Duration::from_millis(5));
        let mut now = wall;
        let mut frame_t = anchor_t_ns;
        for _ in 0..10_000 {
            frame_t += 1_000_000;
            now += Duration::from_millis(1);
            assert!(
                schedule_sleep(wall, anchor_t_ns, frame_t, 1.0, now).unwrap_or(Duration::ZERO)
                    <= SLEEP_CAP
            );
        }
    }

    #[test]
    fn cp_021_pause_holds_and_step_is_one_frame() {
        let info = ReplayInfo {
            path: "x.pcap".into(),
            frames: 2,
            first_ts_ns: 100,
            last_ts_ns: 200,
            duration_ns: 100,
            interfaces: vec!["pcap".into()],
            comment: None,
            cut: false,
        };
        let control = ReplayControl::new(info, Some(1.0));
        control.pause();
        assert!(control.is_paused_without_step());
        control.step();
        assert!(!control.is_paused_without_step());
        assert!(control.take_step());
        control.observe_frame(100, 0);
        control.finish_step();
        assert!(control.is_paused_without_step());
        assert!(!control.take_step());
    }

    #[test]
    fn cp_022_seek_lands_on_first_frame_at_or_after_target() {
        let path = temp_pcap("seek", 5);
        let (_, index) = prepare(path.to_str().unwrap(), None).unwrap();
        let seek = open_at(path.to_str().unwrap(), &index, 2_500_000).unwrap();
        assert_eq!(seek.frame, 3);
        assert_eq!(seek.pending.unwrap().ts_ns, 1_003_000_000);
        assert_eq!(seek.previous_ts, Some(1_002_000_000));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cp_022_seek_resumes_from_a_checkpoint_far_into_the_file() {
        // 12,001 frames → checkpoints at 0, 5,000, 10,000; landing past the
        // last checkpoint proves the reader resumed mid-file, not from byte 0.
        let path = temp_pcap("seek-far", 12_001);
        let (_, index) = prepare(path.to_str().unwrap(), None).unwrap();
        assert_eq!(index.checkpoints.len(), 3);
        for target_frame in [0u64, 4_999, 5_000, 10_000, 11_234, 12_000] {
            let seek = open_at(path.to_str().unwrap(), &index, target_frame * 1_000_000).unwrap();
            assert_eq!(seek.frame, target_frame);
            let record = seek.pending.unwrap();
            assert_eq!(record.ts_ns, 1_000_000_000 + target_frame * 1_000_000);
            assert_eq!(record.wire, vec![target_frame as u8; 60]);
        }
        let past = open_at(path.to_str().unwrap(), &index, u64::MAX).unwrap();
        assert_eq!(past.frame, 12_000);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn transport_commands_lapse_when_the_replay_source_is_dropped() {
        let path = temp_pcap("live", 3);
        let state = ReplayState::default();
        let (_, control) = state
            .prepared_for_path(path.to_str().unwrap(), "realtime")
            .unwrap();
        assert!(state.live().is_ok());
        drop(control);
        assert_eq!(state.live().err().as_deref(), Some("no replay session"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cp_004_max_speed_never_sleeps() {
        let info = ReplayInfo {
            path: "x.pcap".into(),
            frames: 1,
            first_ts_ns: 0,
            last_ts_ns: 1_000_000,
            duration_ns: 1_000_000,
            interfaces: vec!["pcap".into()],
            comment: None,
            cut: false,
        };
        let control = ReplayControl::new(info, None);
        assert_eq!(control.sleep_until_due(1_000_000), None);
    }
}
