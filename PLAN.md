# RadEAU — Implementation Plan

**Goal:** Build RadEAU, a high-performance automotive Ethernet network analysis
tool (SOME/IP, SOME/IP-SD, gPTP), per [PRD.md](PRD.md). Native Rust core + WebView
UI (Tauri 2), custom WebGL2 chart engine with Canvas2D fallback, no-decimation
rendering, bounded-everything streaming, and a companion ECU Network Simulator
(`ecu-netsim`) — a simulated sensor-fusion network (camera / radar / lidar /
vehicle-dynamics / fusion ECUs) that is the default data source, the fixture
generator, and the demo.

**Philosophy:** Plan before code. Everything bounded. Batch across IPC. Measure,
then gate in CI. Visual identity first: the shell, the views, and the chart
subsystem are reproduced to the established design before protocol work begins —
charts develop against a synthetic signal source, and live data is wired into
finished views, not the other way around. This PLAN.md is operated via the
powerplan MCP server as the single writer; append-only, one active iteration at
a time.

**Stack:** Tauri 2 (Rust core), React + TypeScript + Vite, custom WebGL2 engine +
wrapped Canvas2D fallback, `ecu-netsim` Rust simulator sharing protocol codec
crates with the core, Node/Playwright-over-CDP E2E harness, Python 3.10+ tooling.

---

## v0.1 — Foundation and visual identity

**Goal:** Repo scaffold, documentation backbone, canonical build, CI skeleton,
and the complete visual identity of the application — frameless shell, theme,
and every view — reproduced with static mock data before any protocol work.

### v0.1.0 — Project initiation (COMPLETE)
- [x] Write PRD.md (product requirements, architecture, performance bounds, methodology)
- [x] Write PLAN.md (this file) in powerplan-compatible format
- [x] Register the powerplan MCP server in project `.mcp.json`
- [x] Rework PRD.md Ethernet-first: SOME/IP + SD + gPTP domain model, ECU Network Simulator (PRD §7), Network view, CAN demoted to backlog
- [x] `git init`; `.gitignore`, `LICENSE`, `README.md` skeleton with the canonical build command
- [x] Record decisions D1–D9 from PRD §11 in `docs/decisions/`
- [x] Scaffold Tauri 2 + React + TypeScript + Vite shell and the Rust workspace (app core, `ecu-netsim`, shared protocol codec crates)
- [x] CI skeleton: typecheck, unit suite, unused-dependency check, duplicate-ID check
- [x] Create the requirement-ID index file for docs/SRS_*.md (single allocator for requirement/plan/test numbering; CI fails on duplicates)
- [x] Smoke test: `npm run tauri dev` launches without console errors
- [x] Restructure documentation: PRD slimmed to product level; software specifications split into docs/SRS_<functionality>.md (visual_ui, graphing, streaming, protocols, ecu_netsim)

### v0.1.1 — App shell + visual identity (COMPLETE)
- [x] Write `docs/SRS_visual_ui.md`: complete visual identity contract — tokens, typography, shell geometry, per-view composition, motion policy, a11y, VU-001..026
- [x] Theme token source of truth per SRS_visual_ui.md §2 (dark-only) generated into the MUI theme + CSS custom properties; raw-color-literal lint (VU-001, VU-002)
- [x] Frameless window with custom titlebar via the thin desktop-API wrapper; UI loads in a plain browser (inert no-ops, valid unsubscribe handles, bounded startup-race retries)
- [x] Docked navigation + current-view state: no router, mount-once keep-alive, two-phase navigation, suspend/resume contract scaffold for every view
- [x] Static view skeletons with representative mock data: Trace, Network, Signals, Recorder, Simulation, Automation, Settings (PRD §3.7)
- [x] Smoke test: navigate all views with zero console errors

### v0.1.2 — View visuals to parity (static + dev data) (current) (ACTIVE)
- [x] Trace view visual: virtualized protocol-aware table (arrival + network time, endpoint, protocol, service/method, message type, session, return code), column filtering UI, pause/resume, expandable payload decode rows — mock frames
- [x] Network view: Connection panel with TRUE data only (active source, link state, counters from the session store; attached node-plane clients with session states once §8.3 lands) + honest empty states for topology/SD/PTP panels until live decode feeds them (v0.5) — no mock states (SRS_visual_ui §1.5)
- [ ] Recorder, Simulation, Automation, Settings visual pass to parity with the established design
- [ ] Per-view screenshot baseline (browser mode) committed as the visual-identity reference
- [x] Dev frame generator (PRD §3.8): seeded basic Ethernet/IPv4/UDP frames, configurable rate + bursts, streamed through the single batched event shape into the Trace view — landed early with the full streaming slice: `radeau-proto` framing codecs (Ethernet II/IPv4/UDP build + bounded parse, round-trip vectors), Rust `devgen` source (seeded, idle/normal/stress/burst profiles up to 5,000 fps, compiled out of release builds), deadline cadence + 4,000-frame drop-oldest accumulator + 3-credit backpressure (PF-001..004 in SRS_streaming.md §0), columnar `frames:batch` event, browser-mode TS mirror of the generator, and the Trace view wired live via a bounded trace store (200k-row ring, adaptive 50/100 ms flush, real paused-buffered count). Mock frames removed.
- [x] Tune Trace under load with the dev generator: flush cadence, virtualization, filter responsiveness at high frame rates — first pass done: E2E smoke harness (`scripts/e2e-smoke.mjs`, `npm run test:e2e`) launches the real binary hidden on a random CDP port + per-run profile and asserts shell visibility, trace navigation, live capture start, and rows streaming (27+ rendered); binary is windowed-subsystem in all profiles (no console pop); adaptive 50/100 ms flush verified under the 800 fps normal profile. Stress/burst-profile soak tuning remains for v0.3.1 perf-gate work.
- [x] Product mark: real RadEAU logo (R + wave + raft emblem) cropped/masked from the original, wired into app bar, startup overlay, About dialog, and the full Tauri icon set; original kept in design-reference/ (untracked)
- [x] Trace table modes per SRS_visual_ui §5.2: Fixed (default — rewrite-in-place per (service,method) key, (protocol,source) for SD/gPTP; pinned-first ordering; pin column; per-key delta as live cycle time) + Sequential (append, follow tail); mode + history window in the display-settings popover [delegated: Grok]
- [x] Global run gate per SRS_visual_ui §4.3: the app-bar run control owns the capture session (starts reading from the selected interface, stops it everywhere); Trace rail capture button becomes a mirror; source selection shared session config editable only while stopped; nothing renders dynamically while stopped (browser devgen mirror included); E2E asserts the stopped-state stillness [delegated: Grok]
- [x] Frame dissection, core side (SRS_protocols §3b): bounded raw-frame buffer in the capture reader (both sources), frame_detail command returning the ordered layer tree + full bytes via radeau-proto codecs [delegated: Codex]
- [x] Trace row expansion = Wireshark-style layer dissection (SRS_visual_ui §5.2): collapsible per-protocol sections with field rows, hex payload with offsets, on-demand fetch, honest evicted/browser states [delegated: Grok]

## v0.2 — Graphing

**Goal:** The chart subsystem per PRD §5 — the product's core — developed against
a synthetic in-app signal source, zero network dependencies.

### v0.2.0 — Chart stack + WebGL2 engine
- [ ] Synthetic signal source (PRD §3.8: sine/ramp/step/noise at configurable rates) + signal streaming ring (shared Float64Array time axis, zero-order hold, min(user, 200k, 1M) capacity) feeding charts
- [ ] Renderer-neutral layout/tick pure-function modules (PRD §5.4)
- [ ] Engine handle contract + chart host with probe, fallback resolution, error boundary (retry / switch / copy logs)
- [ ] WebGL2 engine: bounds-uniform projection, scissor clip, geometry cache with ±15% guard band, sampled signature + dirty flag
- [ ] Allocation policy (64-float start, doubling, 50M cap, hysteresis shrink) + bufferSubData upload discipline
- [ ] Triangle-strip thick lines with miter caps — wired in, not parked
- [ ] Context-loss machinery: loss/restore handlers, 10 s re-init, 30 s watchdog, 3-cycle budget with 60 s decay
- [ ] Point markers below 2 samples/px reusing the line buffer
- [ ] Canvas2D fallback wrapped behind the identical handle (series diffing, redraw guard, reshaping fast path)
- [ ] Engine conformance suite passing against both engines unmodified
- [ ] Early plot spike: single-pane line chart on the wrapped fallback engine fed by the synthetic source — tune the Signals view look before the WebGL2 engine lands

### v0.2.1 — Interaction, autoscale, live loop
- [ ] Plot-rect interaction math: wheel zoom 0.85/1.15 cursor-anchored, X/Y/XY modes, drag pan, Fit All
- [ ] Clamp pipeline in fixed order (translate-not-compress); no-op gestures fire nothing
- [ ] Three-stage hover throttling with snapped-index dedup
- [ ] Window-auto autoscale: binary-search scan, 10% zero-snapped pad, deadband, single-entry memo; manual-locked mode
- [ ] Single rAF loop reading refs; 16→33 ms budget at 200k; push dedup with recorded skip reasons; windowed fetch + empty-window recovery
- [ ] E2E harness bootstrap: launch built binary, random CDP port, per-run profile, first smoke test *(bootstrap landed early in v0.1.2 — `scripts/e2e-smoke.mjs`; remaining: move from dev-server mode to the built release binary)*
- [ ] Requirements GR-/ZM-/AS-/LM- wired into E2E tests per the PRD §5.10 table

### v0.2.2 — Multi-pane + cursor sync
- [ ] Two stacked panes, draggable divider, drag-and-drop signal assignment, merge-on-collapse
- [ ] Shared X range + cursor sync via external store (origin tag + applying guard)
- [ ] Readout isolation (time chip + value cells only re-render)
- [ ] Shared ring buffers with incremental pane projections (copyWithin, stable identity)
- [ ] Layout persistence on 500 ms debounce behind restore-complete gate
- [ ] CSV export of the visible window
- [ ] SRS upkeep: extend `docs/SRS_graphing.md` (seeded) with implementation learnings in the same changes; set requirement Status/Test columns as GR-/ZM-/AS-/LM-/MG- tests land

### v0.2.3 — FFT view
- [ ] One compute module: median-delta fs estimate, ZOH resample, Hann, radix-2 FFT, one-sided scaling with 1e-20 floor
- [ ] 100 ms recompute timer gated on visibility; N selector 256–4096 with resolution/span display
- [ ] Asymmetric dB axis hold (instant expand, ~3%/s decay) with reset rules
- [ ] Detachable PiP panel via root portal with persisted clamped geometry — second thin mount over the same module
- [ ] FF- requirements wired into E2E tests

## v0.3 — Protocol codecs + streaming

**Goal:** Wire-format codecs and the bounded core→UI streaming pipeline.

### v0.3.0 — Protocol codec core
- [ ] Ethernet II / 802.1Q / IPv4 / UDP parse + build with valid checksums; bounded, panic-free on malformed input *(Ethernet II / IPv4 / UDP already landed early with the dev frame generator — remaining: 802.1Q)*
- [ ] SOME/IP header codec + protocol classification (SOME/IP / SD / gPTP / ARP / other) per PRD §3.4 (SP-001..003)
- [ ] SOME/IP-SD payload codec: flags, entries, options (wire format only)
- [ ] gPTP message codec: Sync, Follow_Up, Pdelay set, Announce (PT-001 wire format)
- [ ] Shared test-vector corpus checked in as data; codec round-trips byte-identical
- [ ] SRS upkeep: extend `docs/SRS_protocols.md` (seeded) with codec implementation detail; wire SP- Status/Test columns as vectors land

### v0.3.1 — Channel abstraction + streaming pipeline
- [ ] Uniform channel API with compile-time backend selection, status enum, stable selection identifiers (PRD §3.5)
- [ ] Stub backend (driverless CI) + in-process loopback pseudo-channel (8192-frame bounded echo queue, drop-oldest, diagnostics)
- [ ] Timebase: u32 ms monotonic latch, session rebase, timebase-switch detection; optional network timestamp (ns) carried through (PRD §3.3)
- [ ] Reader thread with adaptive idle backoff (1→10 ms) as a pure tested module
- [ ] Deadline-based batch cadence as pure function `(elapsed, interval) → bool` + emit-ceiling tests
- [ ] Credit-based backpressure: 3 in-flight cap, one ack per animation frame, 4,000-frame drop-oldest accumulator
- [ ] Wire-frame projection (storage vs wire split per PRD §3.4)
- [ ] Consumer registry with emission tiers (off / 1 Hz background / full) and 25 ms disable debounce
- [ ] SRS upkeep: enumerate PF- requirement rows in `docs/SRS_streaming.md` (seeded) as the pipeline lands, citing its bounds and gates

## v0.4 — ECU Network Simulator

**Goal:** `ecu-netsim` — virtual switch, SOME/IP runtime with service discovery,
gPTP sync, and the sensor-fusion scenario; RadEAU consumes its monitor stream as
the default channel (PRD §7).

### v0.4.0 — Virtual network + monitor link
- [ ] Virtual switch: per-port bounded queues with drop counters, store-and-forward latency/jitter, fully serialized Ethernet/IPv4/UDP frames (NS-001, NS-003)
- [ ] Event scheduler: real-time pacing + accelerated deterministic mode, one seeded RNG, no wall-clock reads in behavior models (NS-002)
- [ ] Monitor/inject data plane (TCP 5560): version handshake, length-prefixed records with ns switch timestamps, gap records on overflow
- [ ] Control channel (JSON-RPC, TCP 5561): scenario load/start/stop/status, node and service listing
- [ ] Simulator-link channel backend in RadEAU; frames visible end to end through a debug frame log
- [ ] Scenario config: versioned seeded YAML with field-level validation errors (NS-006)

### v0.4.1 — SOME/IP runtime + service discovery
- [ ] Server/client runtimes: cyclic events with jitter, request/response with latency model, session-id discipline (SP-003)
- [ ] SD server lifecycle: initial delay → doubling repetition → cyclic offers, TTL, StopOffer, reboot flag (SD-001, SD-002)
- [ ] SD client: find, subscribe/ack before events, TTL renewal, Nack handling (SD-003)
- [ ] E2E: two simulated nodes discover, subscribe, and exchange events observable on the monitor stream

### v0.4.2 — gPTP + sensor-fusion scenario + fault injection
- [ ] Per-node clock model (initial offset, drift ppm) + two-step sync + pdelay + servo convergence (PT-001, PT-002)
- [ ] Ground-truth kinematic scene shared by all sensor models, seeded (PRD §7.6)
- [ ] Camera/radar/lidar/vehicle-dynamics ECU models + fusion ECU (PTP-aligned association + alpha-beta filter, fused tracks + stats, SetFusionMode method)
- [ ] Fault-injection verbs on the control channel, one E2E per verb (NS-005; PRD §7.7)
- [ ] CLI polish (`--scenario --seed --accelerated --monitor-port --control-port`); default sensor-fusion scenario checked in

## v0.5 — Decode and live data

**Goal:** Service catalog, dual decoders locked by shared vectors, and live
traffic wired into the already-built views.

### v0.5.0 — Service catalog + dual decoders
- [ ] Catalog YAML: services, methods, events, eventgroups, payload layouts, scaling, units; parse-once lookups + atomic version counter (PRD §3.4)
- [ ] Core payload decoder: fixed offsets, byte-order override, bit slices, missing-on-truncation (SP-004, SP-005)
- [ ] UI payload decoder: plain-number path ≤ 53 bits, identity-keyed per-(service,method) caches, zero-alloc-when-warm assertion
- [ ] Shared payload vector corpus; both decoders green against it
- [ ] Synthetic catalog generator committed as a fixture generator
- [ ] AUTOSAR Ethernet Communication Extract: author the sensor-fusion network as a real ARXML extract (SOME/IP service-interface deployment, sockets, PDU triggering) checked into the repo; importer maps it into the same in-memory catalog model as native YAML; ecu-netsim and the app consume one shared definition

### v0.5.1 — Live wiring: trace, network, signals
- [ ] Frame history ring: 100,000 cap + 256 MB payload byte budget + time-window eviction on 5 s timer; background consumer
- [ ] Trace view wired live: adaptive 50/100 ms flush, 200,000-row cap, chunked rehydration, filtering over a prebuilt lowercased/hex live index
- [ ] Network view wired live: passive SD observer (state machines, subscription edges, TTL, reboot detection — SD-004, SD-005) + PTP status (NV-001..003)
- [ ] Signals view wired live: catalog signal picker; decoded events feed the signal rings, replacing the synthetic source
- [ ] Keep-alive suspend/resume verified under live data for Trace, Network, Signals
- [ ] Specs: write `docs/SRS_trace_view.md` (TR-); set NV- Status/Test columns in `docs/SRS_ecu_netsim.md` as Network-view tests land

## v0.6 — Recording, replay, analysis

**Goal:** JSONL recording with network timestamps, paced replay, and one-pass
bulk analysis.

### v0.6.0 — Recording + replay
- [ ] JSONL recording with 256 KB / 2 s buffered writer; sanitized timestamped filenames; recording as a sub-state of capture
- [ ] Network timestamp (ns) as a first-class optional field in format v1, populated from switch time (decision D3, PT-004)
- [ ] Replay prepare on blocking pool: metadata, scrub timestamps, sparse seek index (1/5,000 frames)
- [ ] Replay worker: absolute-schedule pacing, 50 ms sleep cap, responsive control channel, same batched path with `replay` label
- [ ] Seek rebuilds RX snapshot without emitting; 10 Hz position events, immediate on seek
- [ ] Seeded scenario-recording fixtures via `ecu-netsim` accelerated mode (sine/ramp/step/noise profiles + large-file variant)
- [ ] Core event log (JSONL): session lifecycle, channel transitions, node attach/detach, drop/gap counters, faults — buffered writer, size-capped rotation (PRD §6)

### v0.6.1 — Analysis mode
- [ ] Bulk-analysis command: one blocking-pool pass, per-signal parallel timestamp/value arrays, irregular axes
- [ ] Nearest-timestamp companion command; jump from analysis into replay
- [ ] E2E: analysis of a multi-hundred-MB synthetic recording within budget

## v0.7 — Transmission and automation

**Goal:** SOME/IP transmission authoring and the ghost-user automation surface.

### v0.7.0 — Simulation + transmission
- [ ] One-shot method invocation, event publication, raw frame injection; cyclic tasks (atomic interval, mutex payload, live edits)
- [ ] Simulation view wired live: frame/signal authoring, cyclic task management, presets
- [ ] Transmit-only (inject-only) mode: no reader, recording rejected

### v0.7.1 — Automation surface
- [ ] JSON-RPC TCP server (5555, loopback default); UI-verb parity; ghost-user event mirroring
- [ ] Decoded signal subscriptions: coalesced latest-wins, client min interval, drop counters, zero-subscriber short-circuit
- [ ] External bind opt-in requiring token + allowlist, rejected at startup otherwise (also governs the simulator control channel)
- [ ] Hot-path fan-out discipline: preallocated serialization, coalesced writes, bounded queues (PRD §4.6)
- [ ] Script runner: unbuffered Python spawn, rate-limited output events, clean reaping

### v0.7.2 — Node plane (frame-level API)
**Goal:** External nodes attach to the core (TCP 5562), inject and receive frames over any channel backend, with origin-tagged fan-out and no echo to the originator (PRD §8.3).
- [ ] Node plane server (TCP 5562): version handshake, node identity registry, subscribe + inject with `remote` + node-id tagging routed like channel traffic
- [ ] Fan-out without echo: origin-tag routing to every sink except the originator; injection-signature window re-tags physical loopbacks — pure module with unit tests
- [ ] Bounded per-node outbound queues with drop counters; node cap; active-session gating with clear rejection; §8.1 security posture on external bind
- [ ] Source attribution end to end: Trace shows the originating node per frame; Network view node registry reflects live attach/detach
- [ ] E2E: two API nodes exchange frames through the core with zero echo, over both the loopback and simulator-link backends
- [ ] Node session state machine (PRD §8.3): hello/welcome/subscribe/bye JSON control messages, handshake timeout, CONNECTED→DECLARED→ACTIVE→CLOSED with REJECTED reasons; transitions as core events (JSONL + UI stream) feeding the Network connectivity panel

## v0.8 — Hardening and release

**Goal:** CI performance gates, soak evidence, settings, and the first tagged
release.

### v0.8.0 — Performance gates + soak
- [ ] Performance baseline script with CI enforcement (PRD §4.8 thresholds)
- [ ] Parameterized soak harness with named profiles + scenario matrix; progress assertion; evidence bundles
- [ ] Overnight resident-slope release gate active
- [ ] Burst scenario profile for `ecu-netsim` (traffic bursts + micro-burst modes) as the stress injector

### v0.8.1 — Settings + release ritual
- [ ] Versioned settings file owned by the core with migration on load; localStorage only for disposable view state
- [ ] Scripted release: lockstep version bump, canonical build, release info, staged zip, tag-or-fail
- [ ] First tagged release with full evidence bundle

---

### v0.1.3 — Functional prototype — simulator node streams to Trace (COMPLETE)
> Pulled forward on user direction (2026-08-26): visual tailoring needs a live simulator node in Trace, not the dev generator. First even-split Codex/Grok delegation wave; Claude coordinates, pins contracts, integrates.
**Goal:** A user can start ecu-netsim, connect the app to it over the monitor link (TCP 5560), and watch the simulated sensor-fusion network stream live in the Trace view — the functional substrate the v0.1.2 visual-tailoring work resumes on. Minimal vertical cut of v0.3.x/v0.4.0; those iterations later formalize what this one pins.
- [x] radeau-proto codecs: SOME/IP header (SP-001..003 cut), minimal SOME/IP-SD payload (OfferService entries + TTL), gPTP Sync/FollowUp — bounded, panic-free, round-trip vectors [delegated: Codex]
- [x] ecu-netsim minimal live mode: sensor-fusion cast (SRS_ecu_netsim §6) emitting cyclic SOME/IP events + SD offers + gPTP sync as fully serialized wire frames through a ns-stamped virtual switch, deterministic under --seed [delegated: Codex]
- [x] ecu-netsim monitor link (TCP 5560, loopback bind): JSON handshake line (version, scenario, ports) then length-prefixed binary records {u32 len, u64 switch-ns, u16 port, u8 dir, frame bytes}; bounded outbound queue emitting gap records on overflow (SRS_ecu_netsim §8) [delegated: Codex]
- [x] Core frame sources behind one reader (minimal cut of v0.3.1): devgen source + simulator-link TCP source (connect, handshake, record stream, reconnect with backoff), capture_start takes a tagged SourceSpec [delegated: Grok]
- [x] Capture reader parses link records via radeau-proto (Ethernet/IPv4/UDP → SOME/IP | SD | gPTP classification) into the existing accumulator → frames:batch path; session endpoint table delivered to the UI via a capture:session event; link state via capture:link events [delegated: Grok]
- [x] UI: capture source picker (Dev generator | Simulator link 127.0.0.1:5560) + link status chip in the Trace toolbar; endpoint names resolved from the session table with static fallback; browser mode keeps the devgen mirror only [delegated: Grok]
- [x] Integration: E2E extends e2e-smoke to launch ecu-netsim, start a simulator-link capture, and assert live simulator frames rendered in Trace; README run recipe; smoke test [integration: Claude]

## Backlog
- [ ] CAN / CAN FD backend behind the channel abstraction + DBC schema pipeline (dual bit-walk decoders, shared vectors)
- [ ] Npcap/libpcap live-capture backend + capture-privilege diagnostics in Settings
- [ ] ARXML / FIBEX service-catalog import targeting the same in-memory model
- [ ] SOME/IP-TP segmentation, SOME/IP over TCP, multicast eventgroups
- [ ] gPTP BMCA (dynamic grandmaster election)
- [ ] XCP-on-UDP calibration browser (Protocols view) over an A2L-derived variable tree
- [ ] Renderer memory watchdog (2,048 MB soft reset) + manual trim tools
- [ ] Hybrid envelope rendering beyond the visible window (decision D2 — only if raw-only caps prove limiting)
- [ ] Reduced-UI mode for constrained hosts
- [ ] Module inventory generated from the source tree
- [ ] Privileged bring-up helper pattern (Unix socket, per-launch token) for future backends needing host configuration
