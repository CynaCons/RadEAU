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

### v0.1.2 — View visuals to parity (static + dev data) (2026-08-28 — closed on bench-proto pivot; open visual tasks deferred to backlog) (COMPLETE)
- [x] Trace view visual: virtualized protocol-aware table (arrival + network time, endpoint, protocol, service/method, message type, session, return code), column filtering UI, pause/resume, expandable payload decode rows — mock frames
- [x] Network view: Connection panel with TRUE data only (active source, link state, counters from the session store; attached node-plane clients with session states once §8.3 lands) + honest empty states for topology/SD/PTP panels until live decode feeds them (v0.5) — no mock states (SRS_visual_ui §1.5)
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

### v0.1.4 — Catalog pulled forward — AUTOSAR extract, decode, truthful payloads (COMPLETE)
**Goal:** The trace reads like CANoe: catalog names on every row, decoded signal values (name/raw/scaled/unit) in the dissection, simulator payloads carrying real encoded signals per the checked-in AUTOSAR extract — one shared definition (SRS_protocols §4). Pulled forward from v0.5.0 on user direction (2026-08-28); v0.5.0 keeps live view wiring.
- [x] AUTOSAR communication extract authored: catalog/sensor-fusion.arxml — base types, linear compu-methods with units, record payload types, service interfaces, SOME/IP deployments (ids), provided instances (sockets) [Claude]
- [x] radeau-catalog crate: ARXML-subset importer (quick-xml) → in-memory catalog model (services/events/byte-aligned signals with factor/offset/unit), per-element import diagnostics, serde JSON projection for the UI [delegated: Codex]
- [x] ecu-netsim payloads become truthful: encode each event's signals per the extract layouts (deterministic waveforms, seeded phase), remainder zero-filled — no random payload bytes [delegated: Codex]
- [x] Core catalog integration: load the extract at startup + catalog_model command + catalog:state event; dissection payload section decodes to name/raw hex/raw dec/scaled/unit when the catalog knows the event [delegated: Codex]
- [x] UI: catalog-driven names in Trace rows (service.event from catalog_model, static table fallback), decoded five-column table in the dissection payload section (SRS_visual_ui §5.2), catalog rail button shows the real load state [delegated: Grok]
- [x] E2E trace-content phase: assert catalog names render in rows (CameraObjects.ObjectList, FusionStats), dissect one frame per class and assert NO "malformed" layer, decoded signal table shows named signals with units and plausible scaled values [delegated: Grok]

### v0.1.5 — Honest wire truth — classification, direction, stats (2026-08-29 — E2E green: 6 classes rendered, VLAN lidar on 30501 classified, stats received=199) (COMPLETE)
**Goal:** Every parseable frame becomes an honest trace row: VLAN-tagged and off-port SOME/IP classified, ARP/IPv6/TCP/ICMP/other shown as what they are — never a silent drop (SRS_protocols §2 conformance). Direction comes from the source or renders "—"; skip/drop counters are visible; dead controls stop pretending. Hardens the sim path now and is the prerequisite for the NIC backend. First rung of the bench-proto ladder from the 2026-08-28 bench-readiness audit.
- [x] 802.1Q VLAN codec in radeau-proto (0x8100 + QinQ 0x88A8, PCP/DEI/VID, effective inner EtherType + payload offset); classify_frame and dissect consume it (no more hardcoded IPv4/UDP field offsets); payloadPreview overhead fixed for tagged frames
- [x] Port-agnostic SOME/IP classification by header plausibility (protocol_version, length consistent with datagram) with 30490 as the SD fast-path; cold-path dissection gates the SOME/IP attempt on port/plausibility and gives other UDP an honest 'Data (n bytes)' layer
- [x] Honest Other classes end to end: PROTO_ARP / PROTO_OTHER_UDP / PROTO_OTHER (IPv6/TCP/ICMP labels from carried EtherType/IP-proto), retained in the frame ring for dissection, projectRow branches added and the unknown-code default renders 'Unknown (n)' instead of gPTP; Rust/TS proto-code mirror test pins the tables
- [x] gPTP message-type fidelity: parsed msg_type flows through the batch ty column — Sync/FollowUp/Announce/Pdelay rows named correctly with per-type delta keys (classify_frame stops discarding the parse)
- [x] Direction truth (SP-009): semantics pinned relative to RadEAU's host (Rx observed / Tx originated / unknown); classify_frame takes direction from the caller instead of hardcoding rx:true — simulator frames map to Rx through an explicit tested function (the monitor record's direction byte is the switch's port side, not RadEAU's), devgen keeps its synthesized share, DIR_UNKNOWN reserved for sources that cannot know; Dir column renders '—' for unknown; the capture.rs test that pinned the hardcode is rewritten
- [x] Endpoint identity by address: src/dst IPv4 + src MAC columns in FrameBatch, dynamic endpoint table (first-sight indexes, capture:session re-emit, 255-sentinel overflow bucket), SD/gPTP fixed-mode and delta keys by source address instead of port index
- [x] capture:stats 1 Hz event {classified, skippedOther, accumulatorDropped, gapDropped} — accumulator drop counter added — surfaced as counter chips beside the Trace link chip and in the Network connection panel (eprintln diagnostics are void under windows_subsystem)
- [x] Honesty polish: Arm-recording switch disarmed with 'recording arrives v0.6' tooltip (currently shows a red Recording indicator while writing nothing), mock Settings groups (Transmit-only, Automation token, Diagnostics, Memory) disabled with arrives-vX captions, capture_start rejections kept in sessionStore and shown inline in Settings instead of being swallowed
- [x] SRS_protocols §2 and SRS_visual_ui updated to match; E2E: VLAN-tagged + off-port SOME/IP + foreign-traffic fixtures render honestly as their classes, stats chip visible, no silent drops

### v0.1.6 — Live NIC capture — pcap backend, Windows + Linux (current) (ACTIVE)
**Goal:** Capture backends I, built blind: the dev laptop has no bench hardware — everything is developed here against drivers/SDKs and fixtures, then verified on the work laptop through the app's own diagnostics. Two bench attach paths are known (2026-08-29): Ethernet frames forwarded over VPN (Npcap on a virtual L2 adapter, or a remote capture process streaming pcap records) and Vector VN hardware (v0.1.10). This iteration delivers the Channel trait now that five backends are concrete, a pure-Rust pcap/pcapng file+stream source (no driver, works over any VPN, replays work-laptop captures here as fixtures), the libpcap/Npcap live backend (never bundled, never elevating, wpcap delay-loaded), a portable release bundle, an on-disk log + copy-able diagnostics report as the remote-debugging channel, and ring→pcap export so every bench session comes home as a fixture. Supersedes the backlog entry "Npcap/libpcap live-capture backend + capture-privilege diagnostics in Settings"; implements decision D6's deferred backend.
- [x] Live backend (CP-010..013): `radeau-livecap` crate binding wpcap.dll / libpcap.so at RUNTIME via libloading + hand-written FFI (no SDK, no link-time dependency — supersedes the pcap-crate plan), SourceSpec::Live{interfaceId, filter}, promisc + immediate mode + 100 ms timeout + ns precision when negotiable, default BPF filter aligned with the classifier, host-ns timestamps, ps_drop → kernelDropped, errors mapped to remedies
- [x] Windows story: no SDK needed (runtime binding); Npcap absence/admin-restriction surfaced as Dependencies + link-error diagnostics with the installer-option remedy; driver VLAN-stripping note in the Npcap row detail
- [x] Linux story: libpcap.so runtime binding (load order .so.1 / .so.0.8 / .so); PermissionDenied on device open mapped to a diagnostic naming the exact `setcap cap_net_raw,cap_net_admin+eip` command; app never elevates (PRD §3.5) — implemented and unit-tested on Windows; first Linux run pending
- [x] capture_list_interfaces command (stable ids: NPF GUID / ifname per PRD §3.5 selection identifiers, friendly names, up/loopback flags) + Settings NIC picker with refresh button and inline error text; SourceKind grows 'live' across captureSource/sessionStore/SettingsView, locked while running like the other sources
- [x] Timestamps: Precision::Nano negotiated with silent micro fallback, achieved precision recorded in capture:session; sessionEpochMs wall-clock anchor in capture:session + session/wall Time-column format toggle in the display-settings popover
- [x] capture:stats gains kernel-level drops (pcap ps_recv/ps_drop) so a broadcast storm is visible as loss, not a quiet bus
- [x] Ring→pcap export: command snapshotting the FrameRing (65,536 frames / 96 MiB of raw wire bytes, survives UI stalls) to a classic pcap file with absolute timestamps from the session epoch, plus a UI entry — the first bench day becomes evidentiary before JSONL recording lands in v0.6
- [ ] Release readiness: devgen actually compiled out of release builds (cfg gate — the module comment claims it, no gate exists), release-bundle E2E smoke phase (launch the built exe, assert shell + frames), live-source loopback E2E phase where the environment allows
- [x] Channel trait (PRD §3.5: open/read/status/close, stable selection ids, capability flags for direction/timestamp-source/transmit) introduced now that five backends are concrete (devgen, sim-link, pcap file/stream, Npcap/libpcap live, Vector XL); devgen and sim readers moved behind it with no behavior change; stub backend for driverless CI
- [x] pcap/pcapng file + stream source: pure-Rust record parser (magic/endianness/ns-vs-us, pcapng EPB/IDB with per-interface link type), opens a file (paced replay or as-fast-as-possible) or a TCP/stdin record stream (remote `tcpdump -w -` / dumpcap through any VPN, L3 included) preserving the remote wire timestamps; the same path replays work-laptop captures on the dev laptop — the bench-to-fixture loop
- [x] Blind-development protocol: on-disk radeau.log (backend probes, device lists, open errors, session lifecycle, stats snapshots) because the binary has no console; Settings Diagnostics panel made real with a copy-report button (OS, Npcap/vxlapi presence + versions, interface list, last errors, counters) — the remote-debugging channel for work-laptop testing
- [ ] Local live verification: `ecu-netsim --udp-target 127.0.0.1` emits real SOME/IP/SD datagrams; E2E phase captures the Npcap loopback device and asserts SOME/IP rows with 127.0.0.1 endpoints (skips honestly when Npcap or the loopback device is absent); pcap-file replay phase already unconditional
- [x] Settings › Dependencies group (SRS_visual_ui §5.7): read-only probes for Npcap (service + wpcap.dll version, admin-restricted detection), libpcap (.so presence/version), Vector XL Driver Library (vxlapi64.dll version) + Vector driver package — status chip Installed/Missing/Incompatible/Blocked per row, detected path/version, 'Open download page' action to the official vendor page when not installed (never bundled, never elevated), Refresh; sources with a missing dependency disabled in the Interface select with the reason; probe results included in the Diagnostics report
- [x] Recorder view honesty (SRS_visual_ui §5.3): fabricated recent-captures list replaced by the empty state, record controls disabled with the v0.6 caption, Export buffered frames action with count/size, Replay panel opens a .pcap/.pcapng into the pcap source
- [x] UI for the file/stream sources: Settings Interface select gains 'pcap file' (path picker via tauri-plugin-dialog, realtime/fast pace toggle) and 'pcap stream' (host:port); a closed link on a running session returns the run control to Start (CP-005); Time column session/wall toggle uses sessionEpochMs (CP-009)
- [x] docs/SRS_capture.md (CP-001..009) written as the normative spec for the channel layer, pcap sources, export, log, and probes [Claude]
- [x] Simulation + Automation views honesty (SRS_visual_ui §5.4/§5.5): mock controls, fabricated scripts and console output replaced by honest empty states naming the arriving version; static mock data removed

### v0.1.7 — Trace filtering — per-column, spec §5.2
**Goal:** Filter the trace by Service:Method, Name, Protocol, and Direction through the per-column header-glyph popovers SRS_visual_ui §5.2 already fully specifies (no horizontal toolbar). Pure projection-stage predicates over the untouched ring — filter BEFORE collapse/window so Fixed shows the latest matching frame per key and Sequential windows hold N matching rows — with honest filtered-state display. Needs v0.1.5 (Other classes + real direction) to be meaningful on bench traffic.
- [x] Projection-layer filter engine in traceDisplay: criteria {services, names, protocols, dirs} (null = column unfiltered, zero-cost fast path) composed BEFORE collapseFixed/windowSequential; session-scoped state beside mode/pinned/historyWindow; unit tests beside the existing collapse/window suite
- [x] Raw numeric fields carried on TraceFrame by projectRow (proto, svc, method, srcEp, dirBit, msgType) so predicates are integer Set lookups and Name/Service selections key by (svc,method) — catalog loads mid-session don't invalidate active filters
- [x] Service:Method + Name header-glyph popovers per SRS_visual_ui §5.2: the two inert IconButtons wired — accent-primary tint while active, 250 px popover with search, select-all/deselect-all + selected/total count, Cancel/Apply, everything-selected clears the filter; values from a memoized ring-snapshot pass
- [x] Protocol + Direction column filters with the same glyph+popover treatment (small fixed value sets, no search field); pinned keys do NOT bypass filters, pin set survives filter round-trips
- [x] Filtered-state honesty: 'Filtered · shown/total' chip in the top-right chip stack, 'No rows match the active filters' empty state when the ring is non-empty, expansion cleared on Apply like mode change; pausedBuffered stays the raw pre-filter ingest count
- [x] Perf guardrails: Sequential filter scans the ring tail backward collecting up to historyWindow matches, unfiltered path keeps today's exact cost; verified under the devgen burst profile
- [x] E2E filtering phase: apply and clear each filter kind, assert row sets, active-glyph tint, Filtered chip counts, and the filtered empty-state copy

### v0.1.8 — ARXML import for real extracts
**Goal:** Open the bench project's own AUTOSAR Ethernet Communication Extract from the UI and get an honest catalog: schema-valid COMPU-METHODs, encoding-keyed base types, attribute/ref-resolved deployments, FIELDS — with every skipped element visible as a diagnostic and never a silent fallback to the embedded demo (today's worst failure mode: wrong decode presented confidently). Supersedes the backlog entry "ARXML / FIBEX service-catalog import"; adaptive-platform extracts first, classic System Descriptions loudly detected (full classic ingest stays in backlog until the target bench's extract flavor is known).
- [x] Runtime import path: tauri-plugin-dialog file picker (.arxml filter) + window drag-drop → catalog_import(path) on a worker thread → catalog:state carrying source label + diagnostics payload; reload/unload semantics replace the current boolean toggle over the embedded extract
- [x] Diagnostics surfaced end to end: count badge on the catalog rail button + expandable diagnostics panel with element-path context; fatal parse/read errors and any fallback-to-embedded explicit and labeled — the silent .ok() fallback in catalog.rs removed
- [x] Importer structural upgrade: XML attributes recorded in the DOM (DEST, BYTE-ORDER), absolute-path reference index replacing leaf-name HashMaps (cross-package short-name collisions diagnosed, not last-write-wins mis-bound), EVENT-REF/FIELD-REF-based deployment matching with short-name fallback diagnosed, dec/0x/0b numeral parser for ids
- [x] Schema-valid COMPU-METHOD parsing: CATEGORY + COMPU-INTERNAL-TO-PHYS/COMPU-SCALES with COMPU-RATIONAL-COEFFS for LINEAR/SCALE_LINEAR (single-scale; multi-scale diagnosed), TEXTTABLE value tables onto Signal (SRS §5 value-table index), UNIT-REF resolved against UNIT elements
- [x] Base types keyed on BASE-TYPE-SIZE + BASE-TYPE-ENCODING instead of literal names; BaseType widened to u8-u64/i8-i64/f32/f64/bool per SRS_protocols §5; decode() and the dissection decoded-table shape extended to match
- [x] FIELDS + SOMEIP-FIELD-DEPLOYMENT parsed into the existing model (notifier → Event, getter/setter → Methods) — field notifiers are the most common real-world SOME/IP construct and currently dissect nameless
- [x] catalog/sensor-fusion.arxml re-authored schema-valid (real COMPU-SCALES structure) so the round-trip test stops being self-referential; ecu-netsim encode and all importer tests stay green against the re-authored extract
- [x] Robustness: BOM/UTF-16 detection + transcode, CDATA text handled, file-size threshold with a clear diagnostic, import off the startup path with a progress event; classic System Description markers (SERVICE-INSTANCE-COLLECTION-SET, SOCKET-ADDRESS, PDU-TRIGGERING) detected → loud 'classic variant not yet supported' diagnostic instead of silent zero services
- [x] Real-ARXML fixture corpus: schema-valid compu-methods, DEST-attributed refs, colliding short-names across packages, hex ids, FIELDS-bearing interface, a classic-variant sample asserting the loud diagnostic + a generated multi-MB fixture with a parse-time budget test

### v0.1.9 — DoIP on the wire
**Goal:** DoIP (ISO 13400-2) joins SOME/IP/SD/gPTP as a first-class displayed protocol: UDP-13400 discovery decoded in full, TCP-13400 sessions dissected boundary-aligned with honest mid-stream labels and a UDS SID sub-layer. Specced in SRS_protocols with the PRD v1 non-goal amended deliberately; bounded per the house discipline (full TCP reassembly stays in backlog).
- [x] Spec first: DoIP section in docs/SRS_protocols.md §6 (header validation, payload-type table, discovery/diagnostic layouts, boundary-aligned TCP rules, UDS sub-layer, simulator cast; SP-011..014); PRD non-goal narrowed to transmission/tester roles/full UDS; DOIP_TY_* code table pinned in codes.rs + wireCodes.ts [Claude]
- [ ] TCP header codec in radeau-proto (ports, seq/ack, data-offset, flags, window; options length-skipped; bounded, missing-not-partial like udp.rs) + TCP layer in dissect for non-13400 traffic
- [ ] DoIP codec in radeau-proto: header + payload decoders for 0x0000 NACK, 0x0001-0x0004 vehicle identification/announcement (VIN, logical address, EID, GID), 0x0005/0x0006 routing activation, 0x0007/0x0008 alive check, 0x4001-0x4004 entity status/power mode, 0x8001-0x8003 diagnostic message + acks; payload-length sanity cap
- [ ] Classification + dissection: UDP/TCP port 13400 → PROTO_DOIP with payload-type identity in the batch columns; DoIP layer in the dissector; payload-type name table driving row names ('Vehicle Announcement', 'Routing Activation', …)
- [ ] DoIP over TCP phase 1 (no connection state): boundary-aligned multi-message dissection when the segment starts with a valid DoIP header, honest 'DoIP (continues in next segment)' / 'TCP payload (mid-stream)' labels otherwise; UDS SID sub-layer for 0x8001 (session control, read/write DID, DTC read, security access, routine control, download set, TesterPresent, SID+0x40 responses, 0x7F NRC)
- [ ] Fixed-mode DoIP keying: discovery/status rows by payload type, diagnostic messages by src→tgt with the UDS SID response-bit folded so request/response pairs share one live row and TesterPresent shows its cadence in Δ-per-key; deltaKeyOf mirrored
- [ ] ecu-netsim DoIP cast member: vehicle announcer + a tester session (routing activation, TesterPresent cycle, a periodic ReadDataByIdentifier) so the demo and E2E carry DoIP traffic deterministically
- [ ] E2E DoIP phase: DoIP rows present with named payload types, one UDP discovery and one TCP diagnostic frame dissected with no bogus-malformed layers, UDS sub-layer fields asserted

### v0.1.10 — Vector XL Ethernet backend (Windows)
**Goal:** Vector VN Ethernet interfaces (VN5610A/5620 two-port, VN5640/5650 switch-class with tap modes) as a first-class capture backend behind the Channel trait, via our own FFI binding of the XL Driver Library's network-based Ethernet API: direct 100BASE-T1/1000BASE-T1 attach, hardware ns timestamps as network time, real RX/TX-ack/TX-error direction, VLAN and FCS-error flags — the trustworthy timing path for gPTP and the transmit substrate for v0.7. Built blind on the dev laptop against the header and a mock API; verified on the work laptop through the v0.1.6 diagnostics/log/export loop. Windows-only by nature of the XL API; vxlapi64.dll loaded at runtime so the app launches without Vector drivers.
- [ ] radeau-vxl binding crate: bindgen over vxlapi.h from the user-downloaded XL Driver Library (path via env var, header never committed), vxlapi64.dll loaded at runtime with libloading, struct-size/offset static assertions against the documented layouts, version check at load
- [ ] Thin VxlApi trait over the calls actually used (driver open/close, driver config + Ethernet channel enumeration, network-based Ethernet open/activate/receive/deactivate/close, timestamp sync) with the dynamic-loaded real implementation and a mock that replays canned XL event streams — every line above the trait unit-tested without hardware; check whether the driver package installs a virtual Ethernet channel and use it if so
- [ ] Vector backend behind the Channel trait: VN Ethernet channels/measurement points enumerated as stable ids, network-based API (VN5610A/5620/5640/5650), hardware ns timestamps carried as network time, RX / TX-ack / TX-error direction, VLAN + FCS-error flags, T1 PHY master/slave + link speed surfaced in Settings
- [ ] Settings + diagnostics: Vector channel picker with refresh; 'Vector driver not installed' / 'no Ethernet channels' / 'channel in use by another application' diagnostics; radeau.log + copy-report coverage of the Vector probe
- [ ] Hardware verification protocol on the work laptop: scripted checklist (driver version, channel list, first frames, timestamp sanity against gPTP cadence, direction, VLAN visibility, stats) + ring→pcap export of the session brought back as a replay fixture; first hardware defects fixed against those fixtures on the dev laptop
- [ ] Transmit entry point (xlNetEthSend) reserved behind the Channel capability flag for v0.7 — declared, not wired, documented

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
- Recorder, Simulation, Automation, Settings visual pass to parity with the established design (deferred from v0.1.2: bench-proto pivot 2026-08-28 — visual parity resumes after the v0.1.5–v0.1.9 bench ladder)
- Per-view screenshot baseline (browser mode) committed as the visual-identity reference (deferred from v0.1.2: bench-proto pivot 2026-08-28 — visual parity resumes after the v0.1.5–v0.1.9 bench ladder)
- Classic-platform System Description ingest (SERVICE-INSTANCE-COLLECTION-SET, SOCKET-ADDRESS/APPLICATION-ENDPOINT topology, PDU-TRIGGERING → same Catalog model) — promote onto the critical path if the target bench's extract turns out classic rather than adaptive
- ARXML nested records / fixed arrays / strings: recursive layout computation with dotted names and array expansion; dynamic-length constructs diagnosed 'deferred', not dropped
- ARXML bitfields (MSB0 bit slices) + per-service byte-order overrides per SRS_protocols §5; method in/out argument decode over the same layout machinery
- DoIP TCP phase 2: bounded per-connection reassembly (64 KiB per direction, LRU-capped connection table, visible truncation diagnostics) + fuller UDS decode (DIDs, transfer sequences)
- Wireshark-grade expression display filter (parsed predicate over raw numeric row fields, spec amendment to §5.2) + capture-side filter pushdown + filter persistence decision
- Incremental Fixed-mode collapse keymap (update per flushed row instead of O(200k) ring rebuild per publish) + per-batch emit-size caps — line-rate UI hardening before any 1000BASE-T1 bench
- Hardware timestamping via pcap tstamp types (e.g. Intel i210) for judging gPTP sync quality rather than just viewing it
- Evaluate the autosar-data crate as a schema-aware importer backend (verify license compatibility first)
- Windows NIC-driver VLAN stripping: document + detect (Intel/Realtek 'Priority & VLAN' / MonitorModeEnabled) so tagged frames reach Npcap on the pcap path — promote into v0.1.6 docs if the VPN adapter turns out to be a physical-NIC bridge
- Wireshark/CANoe bootstrap captures: ask for real bench pcapng exports (Wireshark on the VPN adapter; CANoe/CANalyzer Ethernet export) and the target ARXML before v0.1.8 — settles VLAN, port, classic-vs-adaptive questions from the audit
- ARXML import via window drag-drop (the picker and popover import landed in v0.1.8; drop-target UX pending)
- Release-bundle E2E smoke phase (launch the built release exe against frontendDist, assert shell + a pcap replay) — release build compiles since v0.1.6, the phase itself is pending
