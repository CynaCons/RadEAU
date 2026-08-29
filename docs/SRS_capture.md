# SRS — Capture Sources and Backends

**Scope:** The channel layer between a frame source and the single capture
reader — the backend enumeration, the pcap/pcapng file and stream source, the
buffered-frame export, the on-disk log, and the dependency/diagnostics probes
that make a bench test debuggable from a pasted report. Product context:
[PRD.md](../PRD.md) §3.5 (channel abstraction), decision D6. Classification
and the batch contract live in [SRS_protocols.md](SRS_protocols.md) §2/§2b;
the streaming bounds in [SRS_streaming.md](SRS_streaming.md). ID prefix: `CP-`.

## 0. Requirements

| ID | Requirement | Priority | Status | Acceptance criteria |
|---|---|---|---|---|
| CP-001 | One channel enumeration with static dispatch (no trait object on the read path), one generic reader loop for every backend, per-backend capability flags (direction, timestamp source, transmit) and stable selection ids | Must | Planned | devgen and sim behave identically before and after the refactor (E2E unchanged); a stub backend keeps driverless CI green |
| CP-002 | pcap and pcapng files are read in both byte orders, µs and ns resolution, link type Ethernet only — any other link type is a diagnosed refusal, not a garbage trace; a truncated tail delivers every complete record and reports the cut | Must | Planned | Fixture corpus (classic µs, classic ns, swapped, pcapng with `if_tsresol`, truncated tail, Linux SLL) reads or refuses exactly as specified |
| CP-003 | A pcap/pcapng record stream over TCP uses the same parser; backpressure is TCP flow control; end of stream ends the session like end of file | Must | Planned | `tcpdump -w -` piped through a socket renders in Trace with the remote wire timestamps |
| CP-004 | File replay never drops a frame: real-time pacing by record timestamps (50 ms sleep cap) or as-fast-as-possible throttled by the accumulator high-water mark | Must | Planned | A 100k-frame fixture replayed fast yields exactly 100k rows and zero accumulator drops in `capture:stats` |
| CP-005 | End of file/stream ends the session honestly: final stats, link `closed` with the detail `end of file · n frames`, the run control returns to stopped, the trace and frame ring stay inspectable | Must | Planned | E2E: after the fixture ends the app-bar shows Start, rows remain, a row still dissects |
| CP-006 | Buffered-frame export writes the frame ring as classic pcap (ns magic, link type 1, absolute timestamps from the session epoch); reading the export back through the pcap source reproduces the same frames byte for byte | Must | Planned | Round-trip test: sim session → export → pcap source → identical wire bytes and relative timestamps |
| CP-007 | The core writes `radeau.log` (JSONL, rotated) through a buffered writer thread; session lifecycle, link transitions, stats at stop, catalog results, dependency probes and command errors are logged; the reader thread never blocks on the log | Must | Planned | Log lines appear for a start/stop cycle; a write stall on the log file does not change batch cadence |
| CP-008 | Read-only dependency probes report installed / missing / incompatible / blocked with version, path and an official download URL; a diagnostics report command bundles them with build, OS, last session and recent log warnings | Must | Planned | On a machine without Npcap the Npcap row is `missing` with the npcap.com URL; the report copies as plain text |
| CP-009 | Direction comes from pcapng EPB flags when present (inbound → Rx, outbound → Tx) and is `unknown` otherwise; `capture:session` carries the session epoch and the timestamp source | Must | Planned | A pcapng fixture with flags renders Rx/Tx; a classic pcap renders "—" |

## 1. Channel layer (CP-001)

The capture reader owns exactly one **channel** per session. Backends are
variants of one enum with static dispatch — PRD §3.5 forbids per-read virtual
dispatch — behind a single generic reader loop (open → session event → timed
reads polling the stop flag → classify → retain/push → batch cadence → stats
→ close). The devgen and simulator readers become variants of this loop; their
behavior is unchanged and pinned by the existing E2E.

`SourceSpec` (the UI's tagged union) grows: `{kind:"devgen", profile}`,
`{kind:"sim", addr}`, `{kind:"pcap", path, pace: "realtime" | "fast"}`,
`{kind:"pcapStream", addr}`, `{kind:"stub"}`; later `{kind:"live",
interfaceId}` and `{kind:"vector", channelId}`.

Each backend declares **capabilities**: `direction` (whether Rx/Tx is known),
`timestampSource` (`host` | `switch` | `file` | `hardware`), `transmit`
(reserved for v0.7). `capture:session` gains `sessionEpochMs` (wall-clock ms
of relative time 0 — host time at start for devgen/sim/live, the first record's
timestamp for a file) and `timestampSource`, so the Time column can offer a
session/wall toggle and the export can write absolute timestamps.

Channel reads yield one of: a frame (absolute ns timestamp, direction code,
wire bytes), a gap (dropped count, span), idle (timeout, poll the stop flag),
end (of file/stream). Status is one of connecting / up / reconnecting / down
(reason) / ended; the reader maps these onto the existing `capture:link`
states. The **stub** backend answers "no link available" to everything so the
pipeline builds and tests without any driver.

## 2. pcap / pcapng file and stream source (CP-002..005, CP-009)

A pure-Rust reader (`radeau-pcap` crate, no libpcap dependency) recognizes:

- **Classic pcap:** magic `0xA1B2C3D4` (µs) or `0xA1B23C4D` (ns), either byte
  order; 24-byte global header (version 2.4, snaplen, link type); 16-byte
  record headers (ts seconds, ts fraction, captured length, original length).
- **pcapng:** Section Header Block (byte-order magic), Interface Description
  Blocks (link type, snaplen, `if_tsresol`, `if_name`), Enhanced Packet Blocks
  (interface id, 64-bit timestamp in the interface's resolution, captured and
  original length, `epb_flags` direction bits), Simple Packet Blocks (no
  timestamp — the previous frame's timestamp is reused and the record is
  flagged), unknown blocks skipped by their declared length. Multiple
  interfaces are allowed; each becomes a channel label in the endpoint title.
- **Link type:** Ethernet (1) only. Linux cooked (113/276), raw IP, and every
  other type are refused with a diagnostic naming the type — never dissected
  as Ethernet. Frames longer than the declared snaplen are delivered as
  captured and marked truncated in the dissection.
- **Robustness:** a record whose declared length exceeds 256 KiB or the file
  end is treated as the end of usable data; every complete record before it is
  delivered and the cut is reported in the link detail. No panic on any byte
  sequence (fuzz-style test over random prefixes of the fixtures).

**Timestamps:** the first record's absolute timestamp becomes the session
epoch; relative time is computed from it exactly like the simulator's switch
time. **Direction** follows CP-009. **Endpoints** are keyed by address like
every other source (SRS_protocols §2).

**Pacing (CP-004):** `realtime` sleeps to the next record's timestamp with a
50 ms sleep cap so stop stays responsive and clock jumps in the file do not
stall the reader (a gap larger than 5 s is collapsed to 5 s and reported);
`fast` reads as quickly as the accumulator allows — the reader waits when the
accumulator holds more than 3,000 frames (75% of its cap) instead of letting
it evict, so a file replay never drops. A gap record in the source (none in
pcap; possible in a stream forwarder) is passed through as a gap.

**Stream (CP-003):** `pcapStream` connects to `host:port` (the same connect /
timeout / link-state discipline as the simulator link, but no reconnect — a
stream is one session) and feeds the socket bytes to the same parser; TCP flow
control is the backpressure. Stdin is not a source (the binary has no console).

**End (CP-005):** at end of file or stream the reader emits the final stats,
`capture:link {state:"closed", detail:"end of file · n frames"}`, and ends
the session; the UI treats a `closed` link on a running session as the
session having stopped itself: the run control returns to Start, the trace
keeps its rows, the frame ring stays inspectable.

**Fixtures:** `fixtures/pcap/` holds small checked-in files exercising every
branch above, plus `fixtures/pcap/sensor-fusion-5s.pcap` generated
deterministically by `ecu-netsim --write-pcap <path> --duration 5` (seeded,
accelerated, no sockets) — the E2E replays it unconditionally.

## 3. Buffered-frame export (CP-006)

Command `export_ring(path) → {frames, bytes, firstTsMs, lastTsMs}` writes the
current frame ring (SRS_protocols §3b: up to 65,536 frames / 96 MiB, retained
after stop) as classic pcap, ns magic, link type 1, snaplen 65,535, timestamps
`sessionEpochNs + relative`. It runs on a worker thread with a
`capture:export` progress event and refuses while a session is starting;
it may run during a live session (it snapshots the ring under the lock in
bounded chunks). Reading an export back through the pcap source yields the
same frames byte for byte. The UI offers it from the Trace rail (a fifth rail
button, Download glyph, "Export buffered frames as pcap", disabled with the
reason when the ring is empty) and from the Recorder view's Record panel.

## 4. On-disk log (CP-007)

`radeau.log` in the platform app-log directory (`%LOCALAPPDATA%\RadEAU\logs`
on Windows, `~/.local/share/RadEAU/logs` on Linux): one JSON object per line —
`{"ts": RFC 3339 ms, "level": "info"|"warn"|"error", "area": "session"|
"link"|"stats"|"catalog"|"deps"|"export"|"cmd", "msg": …, plus fields}` —
through a dedicated writer thread fed by a bounded channel (drop-oldest at
4,096 lines with a counter, so the reader never blocks), 256 KB / 2 s flush,
rotation at 5 MB keeping three files. Logged: startup (version, OS, log path),
every `capture_start` with its `SourceSpec` and outcome, every link
transition, the final stats of every session, catalog import results and
diagnostics count, dependency probe results, export results, command errors.
Log content is also what the Diagnostics report quotes (last 20 warn/error
lines). This file is the seed of the v0.6 core event log; it is not the frame
recording.

## 5. Dependency probes and diagnostics report (CP-008)

`dependency_probe() → [{id, name, enables, status, version, path, detail,
downloadUrl}]` with `status ∈ installed | missing | incompatible | blocked |
not-applicable`, read-only, never loading a capture driver as a side effect:

| id | Windows probe | Linux probe | downloadUrl |
|---|---|---|---|
| `npcap` | `wpcap.dll` under `System32\Npcap`, file version; registry `HKLM\SOFTWARE\Npcap` (`AdminOnly` = 1 → `blocked`, detail names the installer option) | not-applicable | `https://npcap.com/#download` |
| `libpcap` | not-applicable | `libpcap.so.1` / `.so.0.8` resolvable (`ldconfig -p` or library search), version from `pcap_lib_version` when loadable | distro package named in detail; `https://www.tcpdump.org/` |
| `vxlapi` | `vxlapi64.dll` in the system search path or `%ProgramFiles%\Vector XL Driver Library`, file version; below the minimum the binding needs → `incompatible` | not-applicable | `https://www.vector.com/int/en/download/xl-driver-library/` |
| `vector-driver` | registry `HKLM\SOFTWARE\Vector` driver package version when present | not-applicable | `https://vector.com/latest_driver` |

`diagnostics_report() → string`: app version and build profile, OS, log path,
the dependency rows, the interface list (once live capture lands), the last
session (source, link state, final stats), catalog state (source, services,
diagnostics), and the last 20 warn/error log lines — plain text, ready to
paste. Both commands feed the Settings Dependencies and Diagnostics groups
([SRS_visual_ui.md](SRS_visual_ui.md) §5.7).

## 6. Live capture backend — Npcap / libpcap (CP-010..013)

| ID | Requirement | Priority | Status | Acceptance criteria |
|---|---|---|---|---|
| CP-010 | The live backend binds libpcap **dynamically at runtime** (`wpcap.dll` from `System32\Npcap` on Windows, `libpcap.so.1` / `.so.0.8` on Linux) through a hand-written FFI over the functions it uses — no SDK at build time, no link-time dependency, the app launches without the library and every failure is a diagnostic | Must | Planned | Build succeeds on a machine without the Npcap SDK; with the DLL renamed the app starts, the Dependencies row reads Missing, and `capture_start(live)` returns "Npcap not installed" |
| CP-011 | `capture_list_interfaces()` enumerates devices with stable ids (`\Device\NPF_{GUID}` / ifname), friendly descriptions, addresses, up/loopback flags; the loopback device is listed when the library offers it | Must | Planned | The list is stable across calls; on this machine it contains the Npcap loopback device |
| CP-012 | A live session opens promiscuous with snaplen 65,535, immediate mode, a 100 ms read timeout (so stop stays responsive), nanosecond precision when negotiable (achieved precision recorded), and a default BPF filter aligned with the classifier that can be widened; every frame is Rx; `capture:stats.kernelDropped` carries `ps_drop` | Must | Planned | Real UDP SOME/IP traffic sent to 127.0.0.1 by the simulator renders as SOME/IP rows through the loopback device; a deliberately tiny snaplen test shows truncated frames flagged in the dissection |
| CP-013 | Privilege and access failures (admin-restricted Npcap, missing CAP_NET_RAW on Linux, device busy) surface as `capture:link {state:"error", detail}` naming the exact remedy, never a crash or an empty trace | Must | Planned | Each failure class is mapped from the library's error string to a remedy sentence with a unit test |

**Design.** A `radeau-livecap` crate wraps `libloading`: it resolves
`pcap_lib_version`, `pcap_findalldevs`, `pcap_freealldevs`, `pcap_create`,
`pcap_set_snaplen`, `pcap_set_promisc`, `pcap_set_timeout`,
`pcap_set_immediate_mode`, `pcap_set_tstamp_precision`, `pcap_activate`,
`pcap_next_ex`, `pcap_stats`, `pcap_compile`, `pcap_setfilter`,
`pcap_freecode`, `pcap_geterr`, `pcap_close` (and `pcap_statustostr`) once,
keeps the library handle for the process lifetime, and exposes a safe
`Device` list and a `LiveCapture` reader. The channel variant `Live` feeds
the generic reader loop with host timestamps (`ts_ns` from `pcap_pkthdr`,
µs or ns per the achieved precision) and `DIR_RX`; the endpoint table keys by
address as for every source. The default filter is `udp or ether proto
0x88f7 or arp or vlan` (widen with a setting later); Windows NIC drivers may
strip 802.1Q tags before Npcap sees them — documented in the Dependencies
row detail. `SourceSpec` gains `{kind:"live", interfaceId, filter?}`. The
dependency probe may call `pcap_lib_version` through the same loader (it
opens no device). Verification on this laptop uses the Npcap loopback device
with `ecu-netsim --udp-target 127.0.0.1` emitting real datagrams. The Npcap
loopback device presents BSD loopback framing (`DLT_NULL`: a 4-byte
address-family header before the IP packet); the live source synthesizes an
Ethernet II header for those frames so classification is unchanged; any
other unsupported data link is refused with a diagnostic naming it.

## 7. Continuous pcap recording (CP-014..016)

| ID | Requirement | Priority | Status | Acceptance criteria |
|---|---|---|---|---|
| CP-014 | While the record switch is armed, every frame the reader classifies is appended to a classic pcap file (ns magic, link type 1, absolute timestamps from the session epoch) by a dedicated writer thread fed by a bounded queue (8,192 frames, drop-oldest, counted) with a 256 KB / 2 s flush discipline; the reader never blocks on disk | Must | Planned | A 60 s simulator session records a file that replays through the pcap source with the same frame count as `capture:stats.received` minus `recordingDropped` |
| CP-015 | Recording is a sub-state of a running session: arming while stopped stores the intent and starts the file with the next session; stopping the session closes the file; the file name is `radeau-<session start yyyyMMdd-HHmmss>.pcap` in the recordings directory (Settings › Recording, default the platform documents dir / RadEAU); the app-bar indicator shows `error` only while bytes are actually being written | Must | Planned | Indicator color follows real writes; a write failure surfaces as an inline alert and disarms recording |
| CP-016 | `capture:stats` gains `recordingFrames`, `recordingBytes`, `recordingDropped`; the Recorder view's Record panel shows the active path, frames and bytes live and lists this session's recordings when stopped (true files only) | Must | Planned | E2E: arm, run the sim 5 s, stop → a file exists whose size matches `recordingBytes`; the Recorder list shows it |

Recording writes pcap (not the v0.6 JSONL format) because it is the format the
bench engineer can open anywhere; the JSONL recording with decoded names and
the replay worker stay in v0.6. Commands: `recording_arm(bool)`,
`recording_dir_set(path)`, `recording_list() → [{path, bytes, frames,
startedMs}]`; events: `recording:state {armed, active, path, frames, bytes,
dropped, error}`.
