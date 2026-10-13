# SRS — Automation and Agent Access

RadEAU is driven by agents as fully as by the operator: an agent can see
every frame and control capture, recording and replay (PLAN v0.1.15,
PRD §8.1 — "anything the operator can do, a script can do; a UI-only
capability is a defect"). Two layers:

- the **automation server** in the core: newline-delimited JSON-RPC 2.0 over
  TCP on loopback, every method a call into the same core functions the UI's
  Tauri commands use;
- **`radeau-mcp`**, a stdio Model Context Protocol server shipped next to the
  app, exposing each method as an MCP tool and forwarding it to the running
  app's automation server.

Owns the `AU-` prefix ([REQUIREMENT_IDS.md](REQUIREMENT_IDS.md)). Capture,
recording, replay and export semantics are [SRS_capture.md](SRS_capture.md);
dissection is [SRS_protocols.md](SRS_protocols.md).

## 1. Requirements

| ID | Requirement | Priority | Status | Acceptance criteria |
|---|---|---|---|---|
| AU-001 | The core listens on `127.0.0.1:5555` (Settings › Automation: port, enable) for newline-delimited JSON-RPC 2.0 — one request per line, one response per line, notifications ignored; at most 4 concurrent clients, requests above 1 MiB rejected, a client that sends invalid JSON gets a parse error and keeps its connection | Must | Planned | Unit + E2E: a TCP client calls `capture_status`; a 5th client is refused with a JSON-RPC error; a 2 MiB line is rejected |
| AU-002 | Binding beyond loopback requires a token of at least 32 characters **and** a non-empty client address allowlist; a configuration enabling a non-loopback bind without both is refused at startup with a logged error (the server stays on loopback). With a token configured, a client must send `authenticate {token}` before any other method; three failures close the connection | Must | Planned | Unit: external bind without token/allowlist → refused; wrong token ×3 → disconnected |
| AU-003 | Verb parity: every automation method calls the same core function as the corresponding UI command; state changes made by an agent (session start/stop, source, recording, replay transport) reach the UI through the same events, and the UI mirrors them (run control, source, record switch, replay bar) within 200 ms | Must | Planned | E2E: `capture_start` over automation flips the app-bar run control to Stop; `capture_stop` flips it back |
| AU-004 | The method catalog of §2 is complete: capture, recording, replay, export, trace query, frame detail, trace statistics; unknown methods return `-32601`, invalid params `-32602` naming the offending field, domain failures `-32000` with the core's message verbatim | Must | Planned | Unit: one test per method's happy path and per error class |
| AU-005 | `trace_query` answers from the core frame ring (independent of the UI): filters `protocols`, `nameContains`, `key`, `dir`, `fromNs`/`toNs` (session-relative), `afterIdx`; returns at most `limit` rows (default 100, max 500) as compact rows `{idx, tNs, dir, len, protocol, name, type, key, src, dst}`, plus `total` (matching rows in the ring), `nextIdx` for paging and `ring {firstIdx, lastIdx, frames}` | Must | Planned | Unit: filters combine with AND; paging with `nextIdx` visits every matching row exactly once; a query over a full 65,536-frame ring answers in < 50 ms (release) |
| AU-006 | `trace_frame {idx}` returns the full dissection (layers, fields, hex, decoded signals) identical to the UI's `frame_detail`; an evicted frame returns the domain error "frame no longer buffered" | Must | Planned | Unit: equals `frame_detail` for the same idx |
| AU-007 | `trace_stats` returns the session (`running`, source, epoch, timestamp source), the live counters of `capture:stats`, and per-protocol counts and time span of the frames currently in the ring | Must | Planned | Unit: per-protocol counts sum to the ring size |
| AU-008 | `radeau-mcp` speaks MCP over stdio (protocol `2025-06-18`: `initialize`, `tools/list`, `tools/call`, `ping`), lists one tool per §2 method with a JSON Schema for its input, forwards each call to the automation server and returns the result as JSON text content; when the app is not running a call returns a tool error "RadEAU is not running — start the app (automation enabled, port N)"; it reconnects per call, so starting the app later just works | Must | Planned | Integration test: a scripted MCP client lists the tools and calls `capture_status` through a running core; with no core the call returns the not-running error |
| AU-009 | Agent visibility: while at least one automation client is connected the app bar shows an `Agent` chip (tooltip: client count and last method); every automation call is written to the core log (area `automation`, method, client, ok/error, ms) | Must | Planned | E2E: the chip appears while a client is connected and disappears after it closes; the log has one line per call |
| AU-010 | `radeau-mcp` ships in the portable Windows zip and the Linux tarball next to `radeau`; the README documents the Claude Code / Codex MCP configuration | Must | Planned | The release-bundle E2E finds `radeau-mcp.exe` in the zip and it answers `initialize` |

## 2. Method catalog (AU-004)

JSON-RPC method names equal the MCP tool names. Times are session-relative
ns unless named `*EpochMs`. Results are JSON objects.

| Method | Params | Result | Core function (same as the UI's) |
|---|---|---|---|
| `capture_list_sources` | — | `{kinds: [...], interfaces: [{id, name, description, addresses}]}` | `capture_list_interfaces` + available kinds |
| `capture_start` | `{source: SourceSpec}` (as `capture_start`: `{kind:"sim", addr}`, `{kind:"pcap", path, pace}`, `{kind:"pcapStream", addr}`, `{kind:"live", interfaceId, filter?}`, `{kind:"devgen", profile}` in dev builds) | `{started: true}` | `capture::start_session` |
| `capture_stop` | — | `{stopped: true}` | `capture::stop_session` |
| `capture_status` | — | `{running, source, sessionInfo, stats}` | session state + last `capture:stats` |
| `recording_start` | — | recording state | `recording_arm(true)` |
| `recording_stop` | — | recording state | `recording_arm(false)` |
| `recording_status` | — | recording state (`recording:state` shape) | `recording_state` |
| `recording_list` | — | `[{path, bytes, frames, startedMs}]` | `recording_list` |
| `export_jsonl` | `{path, from: {kind:"ring"} \| {kind:"file", path}}` | `{frames, bytes, path}` | `export::export_jsonl` |
| `replay_open` | `{path}` | `ReplayInfo` | `replay::replay_open` (also selects the file as the session source, 1×) |
| `replay_play` / `replay_pause` / `replay_step` | — | `ReplayPosition` | `replay::*` (play starts the replay session when none runs) |
| `replay_seek` | `{tNs}` | `ReplayPosition` | `replay::replay_seek` |
| `replay_set_speed` | `{speed: number \| null}` | `ReplayPosition` | `replay::replay_set_speed` |
| `replay_status` | — | `{info, position}` | replay state |
| `trace_query` | AU-005 | AU-005 | core frame ring |
| `trace_frame` | `{idx}` | `FrameDetail` | `dissect::frame_detail` |
| `trace_stats` | — | AU-007 | ring + session + stats |
