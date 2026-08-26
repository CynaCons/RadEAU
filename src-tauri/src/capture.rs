//! Capture session + the streaming pipeline slice (SRS_streaming.md §1):
//! deadline-batched emission, bounded drop-oldest accumulator, credit-based
//! backpressure — one event shape (`frames:batch`) from the first commit.
//! The dev generator is the interim source, wired directly here until the
//! channel abstraction lands (v0.3.1) and it becomes one backend among many
//! behind the single capture reader (docs/ARCHITECTURE.md §2).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::devgen::{DevGen, GenFrame, RateProfile};

/// Batch cadence (SRS §1): one event per deadline interval, 16 ms default.
pub const BATCH_INTERVAL_MS: u64 = 16;
/// Bounded accumulator (SRS §1): drop oldest past this many frames.
pub const ACCUMULATOR_CAP: usize = 4_000;
/// Credit-based backpressure (SRS §1): stop emitting at this many outstanding
/// unacknowledged batches; UI acks exactly once per animation frame.
pub const MAX_CREDITS: u32 = 3;
const TICK_MS: u64 = 2;

/// Pure deadline cadence: due when a full `interval_ms` has passed since the
/// last emit. Testable without a network.
pub fn deadline_due(elapsed_ms: u64, interval_ms: u64, last_emit_ms: u64) -> bool {
    elapsed_ms.saturating_sub(last_emit_ms) >= interval_ms
}

/// Columnar batch payload — arrays of primitives, never row objects, so one
/// user-visible update is one allocation-heavy structure at most.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FrameBatch {
    seq: u64,
    /// Global frame index.
    i: Vec<u64>,
    /// Seconds since session start.
    t: Vec<f64>,
    /// Direction: 1 rx, 0 tx.
    d: Vec<u8>,
    /// Endpoint index into the shared endpoint table.
    s: Vec<u8>,
    /// Protocol class (0 SOME/IP, 1 SD, 2 gPTP).
    p: Vec<u8>,
    sv: Vec<u16>,
    m: Vec<u16>,
    /// Message-type code (0 Event, 1 Offer, 2 Sync).
    ty: Vec<u8>,
    /// Session id, -1 when absent.
    se: Vec<i32>,
    /// Full wire length incl. Ethernet header.
    l: Vec<u32>,
    /// Payload preview bytes.
    pb: Vec<[u8; crate::devgen::SNAP_LEN]>,
}

impl FrameBatch {
    fn with_capacity(cap: usize) -> Self {
        Self {
            seq: 0,
            i: Vec::with_capacity(cap),
            t: Vec::with_capacity(cap),
            d: Vec::with_capacity(cap),
            s: Vec::with_capacity(cap),
            p: Vec::with_capacity(cap),
            sv: Vec::with_capacity(cap),
            m: Vec::with_capacity(cap),
            ty: Vec::with_capacity(cap),
            se: Vec::with_capacity(cap),
            l: Vec::with_capacity(cap),
            pb: Vec::with_capacity(cap),
        }
    }

    fn push(&mut self, f: &GenFrame) {
        self.i.push(f.idx);
        self.t.push(f.t_s);
        self.d.push(u8::from(f.rx));
        self.s.push(f.src_ep as u8);
        self.p.push(f.proto);
        self.sv.push(f.svc);
        self.m.push(f.method);
        self.ty.push(f.msg_type);
        self.se.push(f.session);
        self.l.push(f.wire_len);
        self.pb.push(f.snap);
    }
}

struct Session {
    stop: Arc<AtomicBool>,
    credits: Arc<AtomicU32>,
    accumulator: Arc<Mutex<VecDeque<GenFrame>>>,
    thread: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct CaptureState(Mutex<Option<Session>>);

impl CaptureState {
    fn take(&self) -> Option<Session> {
        self.0.lock().ok()?.take()
    }
}

fn take_credit(credits: &Arc<AtomicU32>) -> bool {
    credits
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |c| {
            if c > 0 { Some(c - 1) } else { None }
        })
        .is_ok()
}

fn emitter_loop(
    app: AppHandle,
    stop: Arc<AtomicBool>,
    credits: Arc<AtomicU32>,
    accumulator: Arc<Mutex<VecDeque<GenFrame>>>,
    profile: RateProfile,
) {
    let mut gen = DevGen::new(0x5eed_2026_0001);
    let mut scratch_out: Vec<GenFrame> = Vec::new();
    let start = Instant::now();
    let mut last_gen = start;
    let mut carry = 0.0f64;
    let mut last_emit_ms: u64 = 0;
    let mut seq: u64 = 0;

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        std::thread::sleep(Duration::from_millis(TICK_MS));
        let now = Instant::now();
        let elapsed_s = now.duration_since(start).as_secs_f64();
        let rate = profile.rate_at(elapsed_s);

        let dt = now.duration_since(last_gen).as_secs_f64();
        last_gen = now;
        carry += rate * dt;
        let n = carry.floor() as usize;
        carry -= n as f64;

        if n > 0 {
            scratch_out.clear();
            gen.gen_frames(n, rate, &mut scratch_out);
            if let Ok(mut acc) = accumulator.lock() {
                for f in scratch_out.drain(..) {
                    if acc.len() >= ACCUMULATOR_CAP {
                        acc.pop_front();
                    }
                    acc.push_back(f);
                }
            }
        }

        let elapsed_ms = now.duration_since(start).as_millis() as u64;
        // An empty read never flushes a waiting batch; no credit pauses emission.
        let pending = accumulator.lock().map(|a| !a.is_empty()).unwrap_or(false);
        if pending
            && deadline_due(elapsed_ms, BATCH_INTERVAL_MS, last_emit_ms)
            && take_credit(&credits)
        {
            let mut batch = FrameBatch::with_capacity(ACCUMULATOR_CAP.min(256));
            if let Ok(mut acc) = accumulator.lock() {
                for f in acc.drain(..) {
                    batch.push(&f);
                }
            }
            batch.seq = seq;
            seq += 1;
            last_emit_ms = elapsed_ms;
            let _ = app.emit("frames:batch", &batch);
        }
    }
}

fn start_session(
    state: &CaptureState,
    app: AppHandle,
    profile: RateProfile,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "capture state poisoned")?;
    if guard.is_some() {
        return Err("capture already active".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let credits = Arc::new(AtomicU32::new(MAX_CREDITS));
    let accumulator = Arc::new(Mutex::new(VecDeque::with_capacity(ACCUMULATOR_CAP)));
    let thread_stop = Arc::clone(&stop);
    let thread_credits = Arc::clone(&credits);
    let thread_acc = Arc::clone(&accumulator);
    let handle = std::thread::Builder::new()
        .name("devgen-emitter".into())
        .spawn(move || {
            emitter_loop(app, thread_stop, thread_credits, thread_acc, profile);
        })
        .map_err(|e| format!("failed to spawn emitter: {e}"))?;
    *guard = Some(Session {
        stop,
        credits,
        accumulator,
        thread: Some(handle),
    });
    Ok(())
}

fn stop_session(state: &CaptureState) -> Result<(), String> {
    let mut session = state.take().ok_or("no active capture")?;
    session.stop.store(true, Ordering::Relaxed);
    if let Some(h) = session.thread.take() {
        let _ = h.join();
    }
    if let Ok(mut acc) = session.accumulator.lock() {
        acc.clear(); // cleared per stop (SRS §1); credits reset below
    }
    session
        .credits
        .store(MAX_CREDITS, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn capture_start(
    state: State<CaptureState>,
    app: AppHandle,
    profile: String,
) -> Result<(), String> {
    let profile =
        RateProfile::parse(&profile).ok_or_else(|| format!("unknown profile '{profile}'"))?;
    start_session(&state, app, profile)
}

#[tauri::command]
pub fn capture_stop(state: State<CaptureState>) -> Result<(), String> {
    stop_session(&state)
}

/// Exactly one ack per animation frame from the UI; each restores one credit
/// up to the cap. Also what keeps Stop reachable when the renderer starves.
#[tauri::command]
pub fn ack_frames(state: State<CaptureState>, n: u32) -> Result<(), String> {
    // Read the live session without taking it; if none, acks are stale no-ops.
    let guard = state.0.lock().map_err(|_| "capture state poisoned")?;
    if let Some(session) = guard.as_ref() {
        for _ in 0..n.min(MAX_CREDITS) {
            let _ = session.credits.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |c| {
                if c < MAX_CREDITS { Some(c + 1) } else { None }
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cadence_ceilings_sparse_and_bursty() {
        // Simulate arrivals at 100/33/17 ms intervals over 10 s of elapsed
        // time; emitted events must stay within the SRS ceilings.
        for (interval, ceiling) in [(100u64, 10usize), (33, 30), (17, 58)] {
            let mut count = 0;
            let mut last_emit = u64::MAX - interval;
            for ms in 0..=10_000u64 {
                if deadline_due(ms, interval, last_emit) {
                    count += 1;
                    last_emit = ms;
                }
            }
            assert!(count <= ceiling, "interval {interval}: {count} > {ceiling}");
        }
    }

    #[test]
    fn cadence_boundary_cases() {
        assert!(!deadline_due(0, 16, 0)); // no time has passed since the last emit
        assert!(!deadline_due(15, 16, 0));
        assert!(deadline_due(16, 16, 0)); // exactly at boundary
        // Saturating, no panic on huge values.
        assert!(deadline_due(u64::MAX, 16, u64::MAX - 100));
    }

    #[test]
    fn batch_columns_stay_parallel() {
        let mut gen = DevGen::new(99);
        let mut frames = Vec::new();
        gen.gen_frames(50, 800.0, &mut frames);
        let mut batch = FrameBatch::with_capacity(64);
        for f in &frames {
            batch.push(f);
        }
        assert_eq!(batch.i.len(), 50);
        assert_eq!(batch.t.len(), 50);
        assert_eq!(batch.d.len(), 50);
        assert_eq!(batch.s.len(), 50);
        assert_eq!(batch.p.len(), 50);
        assert_eq!(batch.sv.len(), 50);
        assert_eq!(batch.m.len(), 50);
        assert_eq!(batch.ty.len(), 50);
        assert_eq!(batch.se.len(), 50);
        assert_eq!(batch.l.len(), 50);
        assert_eq!(batch.pb.len(), 50);
    }

    #[test]
    fn accumulator_evicts_oldest_at_cap() {
        let mut acc: VecDeque<GenFrame> = VecDeque::new();
        let mut gen = DevGen::new(3);
        let mut frames = Vec::new();
        gen.gen_frames(ACCUMULATOR_CAP + 500, 800.0, &mut frames);
        for f in frames {
            if acc.len() >= ACCUMULATOR_CAP {
                acc.pop_front();
            }
            acc.push_back(f);
        }
        assert_eq!(acc.len(), ACCUMULATOR_CAP);
        assert_eq!(acc.front().unwrap().idx as usize, 500); // oldest 500 dropped
    }
}
