# SRS — Streaming and Performance

**Scope:** The core→UI streaming pipeline — batching, backpressure, consumer
registry, ring buffers, UI-thread and native-core discipline, consolidated
memory bounds, and CI performance gates. Product context: [PRD.md](../PRD.md)
§4. ID prefix: `PF-`; the normative bounds and gates below are the source the
rows cite.

## 0. Requirements

| ID | Requirement | Status | Test |
|---|---|---|---|
| PF-001 | Exactly one batched frame event (`frames:batch`) exists on the frame path; payloads are columnar arrays of primitives, never row objects. | Implemented (dev generator path) | `cargo test --workspace` (`capture::tests`) |
| PF-002 | Deadline-based batch cadence as a pure function `(elapsed, interval) → bool`, default 16 ms; emit ceilings hold for sparse and bursty arrivals. | Implemented | `capture::tests::cadence_*` |
| PF-003 | Credit-based backpressure: emission pauses at 3 unacked batches; the UI acks exactly once per animation frame; credits reset on session start/stop. | Implemented | `capture::tests` + UI ack loop (`TraceView.tsx`) |
| PF-004 | Bounded accumulator: 4,000 frames, drop oldest; cleared per session stop; an empty read never flushes a waiting batch. | Implemented | `capture::tests::accumulator_evicts_oldest_at_cap` |

---

## 1. Batched streaming protocol

Frames reach the UI as **one event carrying an array of frames** per deadline
interval. Default 16 ms, runtime-configurable, hard-clamped 5–2000 ms; UI exposes
presets (16 / 33 / 100 ms foreground, 1000 ms background), not a free-form field.

- **Deadline-based cadence** as a pure function `(elapsed, interval) → bool`,
  testable without a network, with emit-count ceiling tests (≤10/30/58 events/s at
  100/33/17 ms for sparse and bursty arrivals; boundary cases asserted directly).
  An empty read never flushes a waiting batch.
- **Credit-based backpressure:** the core stops emitting at **3** outstanding
  unacknowledged batches. The UI sends **exactly one acknowledgment per animation
  frame** regardless of batches received (per-batch acks burst credits and
  measured ~96 Hz effective rate against a 60 Hz target). Backpressure is also
  what keeps Stop/Close reachable when the renderer starves.
- **Bounded accumulator:** 4,000 frames, drop oldest. Cleared per tick when
  emission is disabled. Credits reset on session start/stop/re-enable.
- **Single event shape.** Exactly one (batched) frame event exists on the frame
  path, from the first commit. A producer that can only emit single frames is
  adapted at the boundary into a one-element batch.

## 2. Consumer registry

A UI-side arbiter refcounts data consumers and maps count → emission tier:
zero consumers → emission disabled (accumulator cleared); background-only → 1 Hz;
any foreground → full rate. Disabling emission never disables capture, recording,
automation, or transmission. Transition rules: enable flushes immediately;
disable/downgrade debounce 25 ms; changes during an in-flight call coalesce;
last-sent guards suppress no-op calls. Renderer memory hints follow the registry
(low / normal), tracked in an atomic, skipped when unchanged.

## 3. Decode and per-frame caches

Identity-keyed per-frame caches per (service id, method id): subscribed signal
indices, preallocated typed-array scratch, touched-index list. Once warm,
**decoding allocates nothing per frame — asserted in a test**. Unsubscribed keys
exit after one map lookup.

## 4. Ring buffers everywhere

Any structure taking high-rate appends under a cap is a ring (a plain-array
`shift()` variant measured ~640 MB/s of useless pointer writes at 800 fps and an
OOM crash in 1–2 h in prior art). Evicted slots are explicitly nulled.

- **Frame history ring:** lean raw frames, 100,000 cap **and a 256 MB payload
  byte budget** (Ethernet payloads are up to ~1.5 KB, not 64 bytes — count alone
  is not a bound), plus a time window (30 s / 1 / 2 / 5 min / off; default
  1 min); eviction on a 5 s timer and on snapshot; cleared on simulation start,
  replay start, manual reset. Registers as a *background* consumer.
- **Signal streaming ring:** typed arrays only — one shared `Float64Array` time
  axis, one per series, plus a last-value vector (zero-order hold gives every
  series a value at every timestamp; no ragged arrays). Capacity
  `min(user depth, 200,000, 1,000,000 absolute)`.
- **Pane projections:** incremental — `copyWithin` head drop, wrap-aware
  two-segment tail append, reusable per-pane scratch via `subarray`; full rebuild
  only on capacity / revision / write-cursor mismatch. View-array identity changes
  only when the projected count changes (stable identity feeds memoization).

## 5. UI-thread discipline

- Per-frame values live in refs / external stores; re-renders driven by coarse
  revision counters at perceptible rates. Cursor motion repaints exactly two
  memoized leaf components (time chip, value cell) — never the chart shell.
- **Adaptive table flush:** 50 ms when batches ≥ 64 frames, else 100 ms; swap the
  pending buffer (don't copy), concatenate (don't double-spread), interval timer
  (not rAF — rAF stops in background exactly when long captures run).
- Chunked rehydration for table rebuilds: 1,000 rows per chunk, yield between
  chunks, gate live inflow into staging during rebuild.
- Every table over a screenful is virtualized; filtering memoized inside the
  memoized table; search input deferred over a prebuilt lowercased/hex index.
- Live numeric readouts at 10 Hz, gated on visibility.

## 6. Native core discipline

- Per-reader-thread name caches invalidated by the catalog version atomic.
- Recording: 256 KB buffered writer, flushed every 2 s (crash resilience) and on stop.
- Telemetry: lazily initialized system-info singleton refreshed in place (a fresh
  handle per poll grew the heap 300–400 MB over hours in prior art).
- TCP fan-out: short-circuit on zero subscribers (lock-free size counter first);
  hand-built JSON into a preallocated string (generic value trees cost ~21
  allocations/frame); coalesced socket writes (drain up to 512 lines into one
  reused 8 KB string); bounded per-client outbound queues (16,384, try-send,
  drop + count — a slow client never backpressures the reader); amortized map
  cleanup (every 256th insert). Command side: 256-command queue drained in 5 ms
  micro-batches, explicit rejection when full.

## 7. Consolidated memory bounds

| Resource | Bound | Policy |
|---|---|---|
| Core batch accumulator | 4,000 frames | Drop oldest |
| Unacked batches in flight | 3 | Emission pauses |
| Recording write buffer | 256 KB / 2 s | Flush; also on stop |
| Per-client outbound TCP queue | 16,384 msgs | Try-send; drop and count |
| Inbound command queue | 256 | Reject with error; never block |
| Replay seek index | 1 checkpoint / 5,000 frames | Sparse by construction |
| Frame snap length | 1,522 bytes | Truncate; flag truncation |
| Frame history ring | 100,000 frames | Overwrite and wrap |
| Frame history payload budget | 256 MB | Byte-budget eviction alongside count/time caps |
| Frame history time window | 30 s–5 min / off | Timed eviction every 5 s |
| Frame table rows | 200,000 | Oldest dropped at flush |
| Signal streaming points | 200,000 (1,000,000 abs) | Ring overwrite |
| GPU geometry per series | 50,000,000 floats (~200 MB) | Clamp; log once |
| Renderer resident memory watchdog | 2,048 MB default | Notify, then soft reset renderer |
| Script console log | 200 entries | Drop oldest |
| Diagnostic timeline | 4 sessions × 1,200 entries | Drop oldest; flush ≤ every 30 s |

## 8. Performance gates (CI-enforced baseline script)

The baseline is a script driving the real application through fixed phases,
exiting non-zero past any threshold:

| Gate | Threshold |
|---|---|
| Batched-event rate, active frame table | ≤ 31 events/s |
| Batched-event rate, data views hidden | ≤ 1.2 events/s |
| Navigation input-to-paint p95 (accelerated) | ≤ 200 ms |
| Navigation p95 (software rendering, evidence required) | ≤ 400 ms |
| Post-warm-up resident memory slope | ≤ 80 MB/min |
| Post-warm-up JS heap slope | ≤ 40 MB/min |
| Low-frame-rate sample ratio (< 10 fps) | ≤ 75% |
| Warm-up / phase / sampling | 30 s / 30 s / 5 s; 20 navigation iterations |

**Overnight resident-set slope is a release gate from the first release** — while
a regression is still one commit wide. Renderer memory is a first-class budget:
keep frame data out of the JS heap where practical (workers over
transferable/shared buffers; coalesce at the producer so one user-visible update
is one allocation), and push decoding, projection, and signal processing off the
UI main thread — cheap before there are consumers, expensive after.
