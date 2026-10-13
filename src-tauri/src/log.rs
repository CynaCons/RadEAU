//! Buffered JSONL application log for diagnostics (CP-007).

#![allow(dead_code)]

use serde_json::{Map, Value};
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const QUEUE_CAPACITY: usize = 4_096;
const BUFFER_CAPACITY: usize = 256 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_secs(2);
const ROTATE_BYTES: u64 = 5 * 1024 * 1024;
const RECENT_READ_BYTES: u64 = 256 * 1024;

#[derive(Clone, Copy)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

struct WriterState {
    path: PathBuf,
    queue: Mutex<VecDeque<String>>,
    wake: Condvar,
    dropped: AtomicU64,
    stop: AtomicBool,
}

struct OpenLog {
    writer: BufWriter<File>,
    len: u64,
}

static LOGGER: OnceLock<Mutex<Option<Arc<WriterState>>>> = OnceLock::new();

fn logger_slot() -> &'static Mutex<Option<Arc<WriterState>>> {
    LOGGER.get_or_init(|| Mutex::new(None))
}

pub fn init(app_log_dir: PathBuf) {
    let _ = fs::create_dir_all(&app_log_dir);
    let state = Arc::new(WriterState {
        path: app_log_dir.join("radeau.log"),
        queue: Mutex::new(VecDeque::with_capacity(QUEUE_CAPACITY)),
        wake: Condvar::new(),
        dropped: AtomicU64::new(0),
        stop: AtomicBool::new(false),
    });

    if let Ok(mut slot) = logger_slot().lock() {
        if let Some(previous) = slot.replace(Arc::clone(&state)) {
            previous.stop.store(true, Ordering::Release);
            previous.wake.notify_one();
        }
    }

    let _ = std::thread::Builder::new()
        .name("radeau-log-writer".into())
        .spawn(move || writer_loop(state));
}

pub fn path() -> Option<PathBuf> {
    logger_slot()
        .try_lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|state| state.path.clone()))
}

pub fn log(level: Level, area: &str, msg: &str, fields: Value) {
    // CP-007: drop-oldest bounded hand-off keeps capture readers from blocking on disk.
    let Some(state) = logger_slot()
        .try_lock()
        .ok()
        .and_then(|slot| slot.as_ref().cloned())
    else {
        return;
    };
    let line = make_line(level, area, msg, fields);
    let Ok(mut queue) = state.queue.try_lock() else {
        state.dropped.fetch_add(1, Ordering::Relaxed);
        return;
    };
    if queue.len() == QUEUE_CAPACITY {
        queue.pop_front();
        state.dropped.fetch_add(1, Ordering::Relaxed);
    }
    queue.push_back(line);
    drop(queue);
    state.wake.notify_one();
}

pub fn log_startup(version: &str, os: &str) {
    log(
        Level::Info,
        "session",
        "startup",
        serde_json::json!({
            "version": version,
            "os": os,
            "logPath": path().map(|p| p.display().to_string()),
        }),
    );
}

pub fn recent_warnings(n: usize) -> Vec<String> {
    if n == 0 {
        return Vec::new();
    }
    let Some(path) = path() else {
        return Vec::new();
    };
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        return Vec::new();
    };
    let start = len.saturating_sub(RECENT_READ_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::with_capacity((len - start) as usize);
    if file.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    if start != 0 {
        if let Some(newline) = bytes.iter().position(|b| *b == b'\n') {
            bytes.drain(..=newline);
        } else {
            return Vec::new();
        }
    }
    let mut matches: Vec<String> = bytes
        .split(|b| *b == b'\n')
        .filter_map(|raw| {
            let line = std::str::from_utf8(raw).ok()?;
            let value: Value = serde_json::from_str(line).ok()?;
            matches!(value.get("level")?.as_str()?, "warn" | "error").then(|| line.to_owned())
        })
        .collect();
    if matches.len() > n {
        matches.drain(..matches.len() - n);
    }
    matches
}

fn make_line(level: Level, area: &str, msg: &str, fields: Value) -> String {
    let mut object = Map::new();
    object.insert("ts".into(), Value::String(rfc3339_ms(SystemTime::now())));
    object.insert("level".into(), Value::String(level.as_str().into()));
    object.insert("area".into(), Value::String(area.into()));
    object.insert("msg".into(), Value::String(msg.into()));
    if let Value::Object(extra) = fields {
        for (key, value) in extra {
            object.entry(key).or_insert(value);
        }
    }
    Value::Object(object).to_string()
}

fn dropped_line(count: u64) -> String {
    make_line(
        Level::Warn,
        "log",
        "log lines dropped",
        serde_json::json!({ "dropped": count }),
    )
}

fn writer_loop(state: Arc<WriterState>) {
    // CP-007: dedicated buffered writer thread flushes periodically and rotates logs.
    let mut writer: Option<OpenLog> = None;
    loop {
        let (batch, stopping) = {
            let Ok(queue) = state.queue.lock() else {
                return;
            };
            let (mut queue, _) = state
                .wake
                .wait_timeout_while(queue, FLUSH_INTERVAL, |queue| {
                    queue.is_empty() && !state.stop.load(Ordering::Acquire)
                })
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let batch = queue.drain(..).collect::<Vec<_>>();
            (batch, state.stop.load(Ordering::Acquire))
        };

        if !batch.is_empty() {
            for line in batch {
                write_line(&state.path, &mut writer, &line);
            }
            let dropped = state.dropped.swap(0, Ordering::AcqRel);
            if dropped != 0 {
                write_line(&state.path, &mut writer, &dropped_line(dropped));
            }
        }
        if let Some(open) = writer.as_mut() {
            let _ = open.writer.flush();
        }
        if stopping {
            return;
        }
    }
}

fn write_line(path: &Path, writer: &mut Option<OpenLog>, line: &str) {
    let bytes_needed = line.len() as u64 + 1;
    let current_len = writer
        .as_ref()
        .map(|open| open.len)
        .or_else(|| fs::metadata(path).ok().map(|m| m.len()))
        .unwrap_or(0);
    if current_len.saturating_add(bytes_needed) > ROTATE_BYTES {
        if let Some(mut open) = writer.take() {
            let _ = open.writer.flush();
        }
        rotate(path);
    }
    if writer.is_none() {
        *writer = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()
            .and_then(|file| {
                let len = file.metadata().ok()?.len();
                Some(OpenLog {
                    writer: BufWriter::with_capacity(BUFFER_CAPACITY, file),
                    len,
                })
            });
    }
    if let Some(open) = writer.as_mut() {
        if open.writer.write_all(line.as_bytes()).is_ok() && open.writer.write_all(b"\n").is_ok() {
            open.len = open.len.saturating_add(bytes_needed);
        }
    }
}

fn rotate(path: &Path) {
    for index in (1..=3).rev() {
        let target = sibling(path, index);
        if index == 3 {
            let _ = fs::remove_file(&target);
        }
        let source = if index == 1 {
            path.to_path_buf()
        } else {
            sibling(path, index - 1)
        };
        if source.exists() {
            let _ = fs::rename(source, target);
        }
    }
}

fn sibling(path: &Path, index: usize) -> PathBuf {
    PathBuf::from(format!("{}.{}", path.display(), index))
}

fn rfc3339_ms(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = duration.as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        day_seconds / 3_600,
        day_seconds % 3_600 / 60,
        day_seconds % 60,
        duration.subsec_millis()
    )
}

// Howard Hinnant's proleptic-Gregorian civil-from-days algorithm.
fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += (month <= 2) as i64;
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::sync::MutexGuard;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn test_guard() -> MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "radeau-log-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn wait_for_lines(path: &Path, count: usize) {
        for _ in 0..100 {
            let actual = File::open(path)
                .ok()
                .map(|file| BufReader::new(file).lines().count())
                .unwrap_or(0);
            if actual >= count {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for {count} log lines");
    }

    #[test]
    fn lines_are_valid_json_with_fields() {
        // CP-007: application log entries are JSONL objects with lifecycle fields.
        let _guard = test_guard();
        let dir = temp_dir("json");
        init(dir.clone());
        log(
            Level::Info,
            "catalog",
            "loaded",
            serde_json::json!({"services": 3}),
        );
        wait_for_lines(&dir.join("radeau.log"), 1);
        let line = fs::read_to_string(dir.join("radeau.log")).unwrap();
        let value: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(value["level"], "info");
        assert_eq!(value["area"], "catalog");
        assert_eq!(value["msg"], "loaded");
        assert_eq!(value["services"], 3);
        assert!(value["ts"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn cp_007_lifecycle_lines_are_jsonl() {
        let _guard = test_guard();
        let dir = temp_dir("lifecycle");
        let path = dir.join("radeau.log");
        let mut writer = None;
        let lines = [
            make_line(
                Level::Info,
                "session",
                "startup",
                serde_json::json!({"version": "0.1.test", "os": "TestOS"}),
            ),
            make_line(
                Level::Info,
                "link",
                "source ended",
                serde_json::json!({"detail": "end of file · 2 frames"}),
            ),
            make_line(
                Level::Info,
                "stats",
                "session final stats",
                serde_json::json!({"received": 2, "dropped": 0}),
            ),
        ];
        for line in lines {
            write_line(&path, &mut writer, &line);
        }
        writer.as_mut().unwrap().writer.flush().unwrap();

        let lines = BufReader::new(File::open(path).unwrap())
            .lines()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let values = lines
            .iter()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let startup = values
            .iter()
            .find(|value| value["msg"] == "startup")
            .unwrap();
        let ended = values
            .iter()
            .find(|value| value["msg"] == "source ended")
            .unwrap();
        let stats = values
            .iter()
            .find(|value| value["msg"] == "session final stats")
            .unwrap();
        assert_eq!(startup["area"], "session");
        assert_eq!(startup["version"], "0.1.test");
        assert_eq!(ended["area"], "link");
        assert_eq!(ended["detail"], "end of file · 2 frames");
        assert_eq!(stats["area"], "stats");
        assert_eq!(stats["received"], 2);
        assert!(values
            .iter()
            .all(|value| value["ts"].as_str().is_some_and(|ts| ts.ends_with('Z'))));
    }

    #[test]
    fn rotation_triggers_at_size_cap() {
        // CP-007: rotation happens before appending a line that would exceed the cap.
        let _guard = test_guard();
        let dir = temp_dir("rotation");
        let path = dir.join("radeau.log");
        fs::write(&path, vec![b'x'; ROTATE_BYTES as usize]).unwrap();
        let mut writer = None;
        write_line(&path, &mut writer, "next");
        writer.as_mut().unwrap().writer.flush().unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "next\n");
        assert_eq!(fs::metadata(sibling(&path, 1)).unwrap().len(), ROTATE_BYTES);
    }

    #[test]
    fn writer_survives_queue_overflow() {
        let _guard = test_guard();
        let dir = temp_dir("overflow");
        init(dir.clone());
        for index in 0..(QUEUE_CAPACITY * 3) {
            log(
                Level::Info,
                "stats",
                "sample",
                serde_json::json!({"index": index}),
            );
        }
        wait_for_lines(&dir.join("radeau.log"), 1);
        // The writer flushes on a 2 s cadence; allow three cycles under load.
        for _ in 0..300 {
            log(Level::Error, "cmd", "sentinel", Value::Null);
            if fs::read_to_string(dir.join("radeau.log"))
                .unwrap_or_default()
                .contains("sentinel")
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("writer did not process a post-overflow line");
    }

    #[test]
    fn recent_warnings_filters_and_tails() {
        let _guard = test_guard();
        let dir = temp_dir("warnings");
        init(dir.clone());
        log(Level::Info, "session", "ok", Value::Null);
        log(Level::Warn, "link", "slow", Value::Null);
        log(Level::Error, "cmd", "failed", Value::Null);
        wait_for_lines(&dir.join("radeau.log"), 3);
        let warnings = recent_warnings(10);
        assert_eq!(warnings.len(), 2);
        assert!(warnings[0].contains("slow"));
        assert!(warnings[1].contains("failed"));
    }

    #[test]
    fn timestamp_epoch_is_utc_rfc3339() {
        assert_eq!(rfc3339_ms(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }
}
