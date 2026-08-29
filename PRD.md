# RadEAU — Product Requirements Document

**Product:** RadEAU — a high-performance automotive Ethernet network analysis tool
(SOME/IP, SOME/IP-SD, gPTP).
**Status:** v0.3 draft — foundation phase, Ethernet-first.
**Plan:** [PLAN.md](PLAN.md) (operated via the powerplan MCP server).

This document is the product-level requirements: what RadEAU is, for whom, on
what stack, and under which architectural and methodological constraints.
**Software specifications live in `docs/SRS_<functionality>.md`** — one per
feature area, each opening with a stable-ID requirements table:

| Specification | Covers | ID prefixes |
|---|---|---|
| [docs/SRS_visual_ui.md](docs/SRS_visual_ui.md) | Visual identity, tokens, typography, shell, per-view composition, motion, a11y | VU- |
| [docs/SRS_graphing.md](docs/SRS_graphing.md) | Chart stack, WebGL2 engine, fallback, axes, interaction, autoscale, live loop, multi-pane, FFT | GR-, ZM-, AS-, LM-, MG-, FF- |
| [docs/SRS_streaming.md](docs/SRS_streaming.md) | Batched streaming, backpressure, consumer registry, rings, memory bounds, CI gates | PF- |
| [docs/SRS_protocols.md](docs/SRS_protocols.md) | Frame representations, classification, SOME/IP header, service catalog, dual decoders | SP- |
| [docs/SRS_ecu_netsim.md](docs/SRS_ecu_netsim.md) | Simulator: network model, SOME/IP runtime, SD, gPTP, fusion scenario, faults, links; Network view | SP-, SD-, PT-, NS-, NV- |
| docs/SRS_trace_view.md *(planned)* | Trace view behavior | TR- |

---

## 1. Product overview

RadEAU is a desktop tool for capturing, decoding, visualizing, recording,
replaying, and injecting automotive Ethernet traffic: SOME/IP services over
UDP/IP, SOME/IP-SD service discovery, and gPTP (IEEE 802.1AS) time
synchronization. Frames arrive from a network source, are decoded against a
service catalog into named signals, and are plotted against time. **The plot is
not a feature attached to a frame table; it is the product.**

A network analyzer is an unbounded-input problem wearing a desktop-application
costume: a 100BASE-T1 link does not slow down because the renderer is busy, and a
session that starts on a quiet network can end on a saturated one. RadEAU must
stay smooth while the network pushes thousands of frames per second at it for
hours, and must survive a full working day (and an unattended overnight run)
without leaking, stalling, or lying.

Development is anchored by a companion **ECU Network Simulator** (§7): a
simulated automotive **sensor-fusion network** — camera, radar, lidar,
vehicle-dynamics, and fusion ECUs exchanging SOME/IP services over a virtual
switch, time-synchronized by gPTP — that connects to RadEAU exactly like a
capture source. The whole product is developable, testable, and demonstrable on
a laptop with no automotive network attached.

### 1.1 Core principles

1. **Never decimate.** No LTTB, no min/max bucketing, no envelope reduction, no
   stride sampling, no LOD pyramids anywhere in the rendering path. Degradation
   shall be in frame rate, never in fidelity. The only permitted reduction is
   visible-window materialization — it changes what is uploaded, never what is
   retained or drawn.
2. **Everything is bounded.** Every buffer, queue, accumulator, and cache has an
   explicit capacity and a documented eviction policy. "It will not grow that
   large in practice" is not a policy.
3. **Batch across the process boundary.** The unit of work crossing IPC is a
   batch on a deadline cadence, never a frame.
4. **The core owns state; the UI subscribes.** External automation is a
   first-class peer ("ghost user"): tooling and operator drive the same state
   through the same mechanisms and see the same feedback.
5. **Measure, then gate in CI.** Every performance claim has a number; the
   load-bearing ones have a threshold that fails a build.
6. **Every optimization carries its story** — problem, symptom, fix, numbers —
   next to the code, or the next contributor "simplifies" it away.

### 1.2 Target users

Embedded / automotive engineers analyzing service-oriented vehicle networks:
validating service-discovery behavior, hunting single-event anomalies (a skipped
cyclic notification, a 2 ms sync excursion), checking sensor-fusion latency
against PTP-stamped sensor data, scripting test sequences, and simulating nodes.

### 1.3 Non-goals (v1)

- CAN / CAN FD, LIN, FlexRay. CAN is the first candidate for a second backend
  behind the channel abstraction (§3.5) and sits at the top of the backlog.
- ARXML / FIBEX catalog import (v1 uses the native catalog format; import is a
  backlog item).
- SOME/IP-TP segmentation, SOME/IP over TCP, multicast eventgroups (unicast
  eventgroups only in v1).
- gPTP BMCA — v1 uses a statically configured grandmaster.
- DoIP transmission / tester roles and full UDS decode (v1 *displays* DoIP
  messages and the UDS service-id sub-layer — SRS_protocols §6), SecOC /
  MACsec, TSN traffic shaping beyond 802.1AS time sync.
- IPv6 (v1 is IPv4-only).
- Multi-user collaboration or cloud storage.

---

## 2. Technology stack

| Layer | Choice |
|---|---|
| Application shell | Tauri 2 — single-process hybrid: native core + embedded WebView |
| Native core | Rust (explicitly threaded; async only where it earns its keep) |
| UI | React 19 + TypeScript + Vite |
| UI components | MUI (Material UI), dark theme, themed exclusively from the token source ([SRS_visual_ui.md](docs/SRS_visual_ui.md)) |
| Virtualized tables | react-virtuoso (constant row heights mandatory) |
| Chart engine | Custom WebGL2 renderer (primary); uPlot Canvas2D fallback, wrapped behind the identical engine handle |
| Fonts | Roboto + Roboto Mono, **bundled with the application** |
| ECU Network Simulator | `ecu-netsim` — standalone Rust binary in the same workspace, sharing the protocol codec crates with the core |
| Live capture (later) | Npcap (Windows) / libpcap (Unix) behind the same channel API — backlog |
| Unit tests | Vitest (UI) + cargo test (core); typecheck + full unit suite every iteration |
| E2E harness | Node scripts driving the **built binary** over CDP (Playwright connect-over-CDP) |
| Scripting / tooling | Python 3.10+ |
| Canonical build | Exactly one supported command produces the shipping binary; tests consume it |

Only the WebGL2 chart engine is load-bearing *as a technology* (no-decimation
fidelity at 200k+ points is not achievable with a stock Canvas2D chart library).
Every other row is load-bearing as a *role* — swappable provided the contracts
attached to it survive the swap.

---

## 3. Architecture requirements

### 3.1 Process model

Single-process hybrid desktop application, plus the simulator as a separate
process. The Rust core owns capture links, files, and network surfaces; the
WebView owns all visualization. Exactly two kinds of IPC traffic: **commands**
(UI → core, request/response, may fail) and **events** (core → UI, push). No
other coupling — the UI never touches a file handle, socket, or capture link.

Every command returns one tagged error type (code + human-readable message):
`session running`, `link error`, `IO error`, `catalog error`, `automation error`,
`recorder error`, `protocol error`. Transport status codes are translated into
actionable text at the boundary. No bare string errors.

### 3.2 Thread model

| Thread | Count | Responsibility |
|---|---|---|
| Main | 1 | Windowing and IPC dispatch |
| Capture reader | 1 per session | Owns the RX side of the active channel by move; receives, timestamps, classifies protocols, resolves names, feeds RX snapshot, appends to recording, accumulates the emit batch. Exits when an atomic running flag clears |
| Cyclic transmit | 1 per task | Cyclic event publication / periodic frame injection; re-reads interval from an atomic and payload from a mutex each tick — live edits apply without restart |
| Automation server | 1 + 1/client | JSON-RPC on port 5555 (default) |
| Simulator control client | on demand | JSON-RPC client to `ecu-netsim` control port 5561 |
| Replay worker | 1 while replaying | Paces frames from a recording into the live emit path |
| Blocking pool | as needed | File indexing, bulk analysis decode, catalog and scenario parsing |

Reader loop discipline: polling backends use non-blocking read with adaptive
idle backoff — 1 ms doubling to a 10 ms cap on consecutive empty polls, reset to
1 ms on the first frame. The simulator-link backend reads blocking-with-timeout,
woken by shutdown. In both cases an empty read never forces an early batch
emission. Shared session state is one managed container: atomics for hot-path
flags, mutexes only for human-timescale state.

### 3.3 Timebase

All frame timestamps are **milliseconds since process start, u32**, from a
monotonic instant latched once at startup; the reader stamps every frame at
dequeue. The UI converts to seconds and rebases against a session-start latch. A
jump > 30,000,000 s between consecutive samples is a **timebase switch** (live ↔
replay), not data. u32 wrap (~49.7 days) is a session boundary.

**Network time is a second, parallel time domain.** Frames additionally carry an
optional **network timestamp in nanoseconds** (the simulator's switch time, a
capture backend's hardware stamp, or absent), stored in recordings from format
v1 and preserved through replay. The application never paces itself on network
time; it uses it for display, PTP analysis, and cross-node latency alignment.
Sensor payloads may embed a third stamp (PTP-corrected sampling time); arrival
vs. network vs. payload time is exactly the latency story the tool exists to
tell.

### 3.4 Domain model

Two frame representations — a self-describing **storage frame** (recordings,
history) and a slim **wire frame** (IPC only) — plus one-pass protocol
classification, the normative SOME/IP header, a parse-once service catalog with
an atomic version counter, and a dual-decoder contract (core + UI, locked by
shared test vectors). Normative detail:
[docs/SRS_protocols.md](docs/SRS_protocols.md).

### 3.5 Channel abstraction

One uniform module-level channel API selected at **compile time** (no per-read
virtual dispatch): init/unload, enumerate/count/info, open, configure, link
up/down, read, write (inject), close-on-drop. The status enum distinguishes *no
message*, *transmit buffer full*, *link down*, *access denied*. Channel info
carries a **stable selection identifier** so rescans preserve selection.

| Backend | Platform | Notes |
|---|---|---|
| Simulator link | Any | TCP monitor + inject to `ecu-netsim`. The default developer channel |
| Npcap / libpcap capture | Win / Unix | Backlog: promiscuous capture + injection behind the same API |
| Stub | Any | Every entry point returns "no link available"; keeps driverless CI running |

**Loopback pseudo-channel** (first iteration, not a testing afterthought): a
pseudo-channel always offered alongside real backends — negative channel index,
stable id, in-process bounded queue of 8,192 frames echoing writes back as
reads, drop-oldest at cap, diagnostics. It keeps unit tests and UI development
running with no simulator process at all.

**Privileges:** the application itself never elevates; capture-backend privilege
requirements are detected and surfaced as actionable diagnostics in Settings.
**Transmit-only (inject-only) mode:** no RX path, no reader thread, recording
explicitly rejected.

### 3.6 UI shell

**Visual identity is normative and fully specified in
[docs/SRS_visual_ui.md](docs/SRS_visual_ui.md)** — dark-only theme, token
palette, typography, frameless window, 48 px app bar, 65/240 px nav rail,
per-view composition, motion policy, accessibility, and the VU- requirements.
Structural rules:

- **No router.** A current-view state selects visibility; views mount once and
  hide with `display: none` (keep-alive). Every view implements a **suspend /
  resume contract from its first commit**: release buffers, unsubscribe, drop
  graphics contexts when inactive.
- **Two-phase navigation:** flip the visible shell immediately; activate
  expensive subscriptions only after paint.
- **State placement:** framework context only for human-timescale state. Hot
  state lives in module-scope singletons read imperatively inside animation
  frames: ring buffers, consumer registry, timebase latch, cursor store, name
  lookup.
- **Settings in a real file owned by the core** with schema version + migration
  on load. Browser storage only for disposable view state.
- **One theme token source of truth**; lint against raw color literals.
- Every desktop-API call goes through one thin runtime wrapper — no hot-path
  exceptions — degrading to inert no-ops in a plain browser, so the UI loads in
  a standard browser for component work and E2E without a native build.

### 3.7 Views

| View | Role |
|---|---|
| Trace | Virtualized protocol-aware frame table: arrival + network time, endpoint, protocol, service/method, message type, session, length; sequential + fixed modes, per-column filtering, pause/resume, expandable payload decode |
| Signals | Multi-pane time-domain plotter + shared FFT tab — the primary analysis surface |
| Network | Topology (ECUs, services, subscriptions — derived passively from SD), SD state monitor with trace correlation, PTP sync status |
| Recorder | Recording controls, replay transport: prepare, play, pause, seek, scrub, analysis mode |
| Simulation | SOME/IP transmission authoring: one-shot method invocation, event publication, cyclic tasks, raw frame injection, presets |
| Automation | Server control and script console |
| Settings | Channel selection, refresh-rate policy, transmit-only and low-overhead modes, link diagnostics, memory tools |

Per-view composition (geometry, control inventory):
[docs/SRS_visual_ui.md](docs/SRS_visual_ui.md) §5.

### 3.8 Development data sources (dev mode)

Two seeded, flag-gated generators exist so every data-consuming view is tuned
against *flowing* data long before the simulator lands — and remain checked in
as fixtures afterward:

- **Dev frame generator:** synthesizes basic Ethernet/IPv4/UDP frames — several
  endpoints, mixed sizes, configurable rate with burst patterns — and streams
  them through the exact production path: the single batched event shape, the
  consumer registry, the same Trace ingestion. Flush cadence, virtualization,
  and filter responsiveness are tuned against it at high frame rates, never
  against static mocks.
- **Synthetic signal source:** sine / ramp / step / noise series at configurable
  rates feeding the signal streaming rings, so the chart subsystem is built and
  tuned with zero network dependencies.

Both are deterministic (seeded) and gated behind a dev/diagnostics flag.
`ecu-netsim` supersedes them as the *default* data source — they are never
deleted; they stay the unit/E2E fixtures for view-level behavior.

---

## 4. Streaming and performance

The streaming pipeline is batched, credit-backpressured, and bounded at every
stage; renderer memory is a first-class budget with CI-enforced gates and an
overnight resident-slope release gate from the first release. Normative
protocol, ring-buffer bounds, thread discipline, the consolidated memory-bounds
table, and the CI gate thresholds:
[docs/SRS_streaming.md](docs/SRS_streaming.md).

## 5. Graphing

The chart subsystem — the product's core — renders every visible sample with no
decimation, on a custom WebGL2 engine with a wrapped Canvas2D fallback behind
one identical handle. Normative stack architecture, engine disciplines, axis
math, interaction, autoscale, live loop, multi-pane, FFT, and the GR-/ZM-/AS-/
LM-/MG-/FF- requirements: [docs/SRS_graphing.md](docs/SRS_graphing.md). Pixel
appearance: [docs/SRS_visual_ui.md](docs/SRS_visual_ui.md) §6.

## 6. Recording, replay, analysis

- **Recordings are JSONL** — one storage frame per line (payload as hex up to
  the snap length): append-only, streamable, truncation-tolerant, byte-offset
  addressable. The optional network timestamp (ns) is part of format v1.
  Readers skip malformed lines and ignore unknown fields. Filenames = sortable
  timestamp + sanitized task label. Recording is a sub-state of capture: armed
  at session start, rejected during replay and in transmit-only mode.
- **Replay prepare** (blocking pool): metadata, sorted distinct-timestamp vector
  for the scrub bar, sparse seek index (1 checkpoint / 5,000 frames). Seek =
  binary search to the checkpoint, scan forward, rebuild the RX snapshot
  **without emitting**.
- Replay paces against an **absolute wall-clock schedule** (never accumulated
  per-frame error), caps single sleeps at 50 ms, re-checks its control channel
  between sleeps, emits through the same batched/backpressure path as live with
  a `replay` source label; position events ~10 Hz, immediate on seek.
- **Analysis mode is a single command, not a worker mode:** given a file and a
  signal list, decode the whole recording in one blocking-pool pass and return
  per-signal parallel timestamp/value arrays on their own irregular axes.
  A companion command maps a chart position to the nearest recorded timestamp
  so users jump from analysis into replay. Both paths built in the first
  iteration.
- **The core logs everything, as JSONL.** Beyond frame recordings, the core
  writes a structured event log — session lifecycle, channel/backend
  transitions, node attach/detach, drop and gap counters, fault events,
  command errors — one JSON object per line through the same buffered-writer
  discipline (256 KB / 2 s), size-capped with rotation. JSONL is the one
  on-disk format for frames and events alike: append-only, streamable,
  truncation-tolerant, greppable. (It is deliberately **not** the hot-path IPC
  format — decision D5; JSON stays for command/control IPC only.)

## 7. ECU Network Simulator (`ecu-netsim`)

A standalone Rust binary in the same workspace simulating a small automotive
Ethernet network — virtual switch, simulated ECUs with modeled clocks, SOME/IP
runtimes, service discovery, gPTP — and serving the monitor/inject link RadEAU
consumes as its default channel. Ships with a seeded **sensor-fusion scenario**
(camera / radar / lidar / vehicle-dynamics / fusion ECUs observing one
ground-truth scene) and scriptable fault injection. It is the primary
development data source, the permanent E2E/soak fixture generator, and the
demo. Normative specification and the SP-/SD-/PT-/NS-/NV- requirements:
[docs/SRS_ecu_netsim.md](docs/SRS_ecu_netsim.md).

## 8. Remote interfaces

### 8.1 Automation surface (JSON-RPC / TCP 5555)

Exposes approximately the UI's verb set — load catalog, start/stop capture,
one-shot and cyclic transmit, invoke methods, read/write signals, subscribe to
decoded signals, drive navigation. **Anything the operator can do, a script can
do; a UI-only capability is a defect.** Subscriptions push decoded, named,
physically scaled values, coalesce latest-value-wins per signal, honor a client
minimum interval, and report a dropped-update count.

**Security posture:** bind loopback by default; loopback is the only
configuration needing no credentials. External bind is one explicit opt-in that
*requires* a shared token of meaningful length **and** a non-empty address
allowlist — a config enabling remote access without both is **rejected at
startup**, not warned. Connection caps; unauthenticated clients dropped after a
few failed attempts. The same posture governs the simulator's control channel.

### 8.2 Simulator link

RadEAU's connection to `ecu-netsim` is a channel backend, not a special path:
monitor + inject on 5560 through the channel abstraction, scenario control on
5561 through the simulator control client. External tools may also attach nodes
directly to the simulator; RadEAU observes them like any other traffic.

### 8.3 Node plane (frame-level API, TCP 5562)

External processes act as **additional network nodes through RadEAU's core** —
independent of which channel backend is active, so a node written against this
API works identically over the simulator link, a future physical Ethernet
interface, or replay. (This surface subsumes the earlier SIL API role.)

- Version-checked handshake; each node registers a **node identity** (id +
  display name). Encoding mirrors the simulator monitor link: **JSON for the
  handshake and control messages, length-prefixed binary records for the frame
  stream** — one framing implementation shared with §8.2's link.
- A node **subscribes** to receive live frames and **injects** its own; injected
  frames are tagged `remote` + originating node id and are routed exactly like
  channel traffic — out the active channel's TX when one is up, into the
  pipeline always.
- **Fan-out without echo:** every frame is distributed to all sinks — UI,
  recording, automation subscriptions, and every attached node — **except the
  node that originated it**. Origin tags carry through the pipeline; for
  backends whose physical loopback re-delivers transmitted frames, a
  short-lived **injection-signature window** re-tags the loopback with its true
  origin and suppresses the echo (otherwise two nodes amplify each other).
- Bounded per-node outbound queues with drop counters; node cap; gated on an
  active session with a clear rejection otherwise. Same security posture as
  §8.1.

**Node session state machine.** Every attached node advances through an
explicit, observable state machine — the state exists first for the operator
(§6 connectivity panel shows it per node), second for protocol robustness:

```
CONNECTED ──hello──▶ DECLARED ──subscribe──▶ ACTIVE ──bye / EOF──▶ CLOSED
    │                    │                      │
    │ timeout /          │ timeout              │ protocol violation,
    │ bad version        ▼                      │ queue-overflow policy
    └──────────────▶ REJECTED ◀────────────────┘
```

- `CONNECTED`: TCP accepted; the node must send `hello` (JSON control message:
  protocol version, node id, display name) within the handshake timeout — a
  silent peer can never hold a half-open slot.
- `DECLARED`: identity validated, `welcome` returned (session info, endpoint
  table, capabilities). The node may configure filters, then `subscribe`.
- `ACTIVE`: receiving origin-tagged fan-out; may inject while a session runs
  (injection outside a running session is an error reply, not a drop).
- `REJECTED` / `CLOSED`: terminal; the reason (version mismatch, timeout,
  violation) is part of the state, displayed and logged, never silent.

State transitions are core events (JSONL-logged, §6) and stream to the UI so
the connectivity panel reflects every node's state live.

### 8.4 Script runner

Spawns Python with output buffering disabled; stdout/stderr stream as
rate-limited line events; termination reaps the child and still emits
completion. Scripts reach the application through the automation surface like
any other client — the runner launches and observes, never a privileged path.

---

## 9. Methodology requirements

### 9.1 Plan discipline

A single PLAN.md at the repository root, chronological and append-only, operated
through the **powerplan MCP server as the single writer**. Checklists only;
exactly one active iteration at a time; every iteration follows the four
movements: plan/docs → implementation → tests/validation → release.

### 9.2 Specification system

One specification per feature area in `docs/SRS_<functionality>.md`, each
opening with a requirements table (ID, Requirement, Priority, Status,
Acceptance criteria; Test IDs join as tests land) using stable ID prefixes
(`VU-`, `GR-`, `ZM-`, `AS-`, `LM-`, `MG-`, `FF-`, `TR-`, `PF-`, `SP-`, `SD-`,
`PT-`, `NS-`, `NV-`, …). IDs are never reused or renumbered; superseded
requirements are marked, not deleted. Spec updates land **in the same change
that implements them**. Two supporting documents keep the system auditable: a
changes-summary (symptom → gap → requirements added) and a bidirectional
test↔requirement map. The most valuable requirements are interaction semantics
— which control wins when states disagree — written down with an explicit
priority ordering.

### 9.3 Testing

- **Pure-function rule:** every non-obvious algorithm (batch cadence, backoff,
  viewport math, eviction, FFT, payload decode, SD state machines, PTP servo)
  lives in a pure module, unit-tested without launching the app. Typecheck +
  full unit suite on every iteration.
- **Shared decode vectors** exercised by both decoders (core + UI), checked in
  as data: SOME/IP headers, SD payloads, gPTP messages, and catalog payload
  layouts.
- **E2E harness drives the built binary** with a remote-debugging port, attached
  over CDP. One test = one standalone numbered Node script (`NN-e2e-topic`)
  returning an exit code, teardown in `finally`. Random free debug port per run;
  per-run profile directory; attach-retry with process-exit detection. E2E
  scenarios run `ecu-netsim` in seeded mode. Window-scoped test hooks behind a
  diagnostics flag are documented and treated as a **stable public API**.
  Selection exclusively on stable `data-testid` attributes; semantic wait
  helpers; **raw sleeps banned**.
- **Soak testing:** one parameterized harness with named profiles, scenario
  matrix, per-process memory sampling, and **progress as a first-class
  assertion** (a soak that quietly stops processing frames is worse than a
  crash). Track post-warm-up memory slope in MB/min. Every run persists an
  evidence bundle.
- **Synthetic fixtures, committed as generators:** service-catalog generator,
  seeded scenario recordings, burst scenario profile for `ecu-netsim`.

### 9.4 Release ritual

1. Bump the version in **every** manifest in lockstep.
2. Build with the canonical command only.
3. Regenerate the release info file.
4. Stage and zip a release directory (executable, runtime libs, plan, release info).
5. Tag via a scripted step that fails on existing tags or unbumped versions.

Conventional commit prefixes (`feat:`, `fix:`, `release:` with the version).
Test/plan numbering allocated from one index file; CI fails on duplicates.

### 9.5 Standing agent rules

- Never terminate the running application process — the developer may be
  mid-session with a live setup. Test binaries build under a staged executable
  name that cleanup may kill freely; the production name is untouchable; one
  test asserts a clean unforced exit. The same rule covers a developer-launched
  `ecu-netsim`.
- Always build with the canonical command.
- Always update PLAN.md (via powerplan) and the relevant SRS with any change.
- No unsolicited attribution or signoff trailers in commits.
- Push only to configured remotes, on explicit request.

---

## 10. Design constraints from prior art

Hard-won constraints that shape v1 (each was a measured failure mode, not a
style preference):

- Renderer (WebView) memory growth is the number-one long-run risk even with all
  application buffers provably bounded — budget it from day one, gate the
  overnight slope from the first release, and keep hot data out of the JS heap.
- All heavy processing off the UI main thread (workers / core) before consumers
  multiply.
- Triangle-strip thick lines wired in from the start, not parked as dead code.
- One spectrum compute module serving both docked and detached views.
- Exactly one frame-event shape on the hot path.
- Choose the IPC transport before tuning field encodings (binary framing /
  structured clone over shared memory — one batch, one allocation, one copy).
- Settings in a versioned, migratable file — never scattered browser storage keys.
- One theme token source; lint raw color literals.
- Module inventory generated from the source tree; docs updated in the
  definition of done.
- One canonical document per subject; others link to it.
- Unused-dependency check in CI.

## 11. Decisions to record (docs/decisions/)

Each requires one written decision before the affected subsystem is built:

| # | Decision | Default recommendation |
|---|---|---|
| D1 | Renderer memory strategy (workers + shared buffers vs. non-browser hot-path rendering) | Workers + transferable/shared buffers; revisit if overnight slope gates fail |
| D2 | No-decimation ceiling vs. hybrid envelope for long histories | Keep raw-only in v1 within documented caps; reserve a hybrid as a versioned extension |
| D3 | Timebase | Application arrival timebase as specified; network timestamp (ns) a first-class optional field in the recording format from v1 |
| D4 | Keep-alive views | Keep, with a mandatory suspend/resume contract per view from first commit |
| D5 | IPC transport for frame batches | Decide before first consumer; candidate: binary/structured-clone over shared memory |
| D6 | Network observation model | Monitor link from the simulator's virtual switch first; Npcap/libpcap capture as a later backend behind the same channel API |
| D7 | Service catalog format | Native versioned YAML first; ARXML/FIBEX import later, targeting the same in-memory model |
| D8 | PTP simulation depth | gPTP two-step with modeled clocks and a simple servo; static grandmaster; no BMCA or TSN shaping in v1 |
| D9 | Simulator delivery | Rust crate + standalone binary in the same workspace, sharing protocol codec crates with the core |
