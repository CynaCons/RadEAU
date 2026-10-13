# Changelog

All notable changes to RadEAU. Versions follow the iteration numbers in
[PLAN.md](PLAN.md); each release ships `RadEAU-<version>-win64.zip` (Windows,
portable) and `RadEAU_<version>_amd64.AppImage` plus
`RadEAU-<version>-linux-x64.tar.gz` (Linux), built by the release workflow.

## v0.1.16 — 2026-10-13

RadEAU becomes AI-first: an agent can drive everything the operator can and see every frame.

### Highlights

- **Agent access (MCP).** `radeau-mcp`, shipped next to `radeau`, is an MCP stdio server: an agent (Claude Code, Codex, any MCP client) starts and stops capture on any source, records, opens and replays recordings, queries the trace (filters, paging), fetches any frame's full dissection, gets statistics and analysis, and exports decoded JSONL. The app serves the matching loopback JSON-RPC endpoint (`127.0.0.1:5555`; a non-loopback bind requires a token and an allowlist). Everything an agent does shows in the UI — run control, record switch, replay bar — and an **Agent** chip marks a connected agent. See the README, "Agent access (MCP)".
- **Trace analysis.** One bounded pass over the buffered trace or a recording: protocols, endpoints and conversations; SOME/IP per service/method with per-sender cadence (mean, p50, p99, jitter), gaps and request/response latency; SD offer lifecycles with reboot detection; gPTP Sync cadence and grandmaster; traffic bursts. Available to agents (`trace_analyze`, `service_summary`, `timing_report`) and in the Network view (**Analyze buffered trace**).
- **pcapng recordings and a replay transport.** Recordings are pcapng (session metadata in the section comment, direction flags, network timestamps at ns resolution, size-based rotation, arm/disarm mid-session). Replays open with a seek index and play at 0.1×–10× or as fast as possible, with pause, single-step and seek from the replay time bar. Any recording or the buffered trace exports as decoded JSONL.
- **Faster, leaner UI.** Hidden views do no work, only the Trace table follows the stream, and Trace ingestion and projection cost scales with what arrived instead of the 200,000-row history (Trace script time at 5,000 frames/s cut from 365 to 140 ms/s in the development build, long tasks gone). The core's frame path runs 26% faster with the same output. Performance budgets are enforced (`npm run test:perf`).
- **Engineering base.** Strict TypeScript, ESLint, clippy (pedantic on the codec crates), rustfmt, cargo-deny (a quick-xml advisory fixed), an independent code review with every finding fixed or answered (`docs/reviews/v0.1.13-code-review.md`), coverage raised (UI 49% → 82%, core 75% → 81%), and requirement traceability enforced in CI (`docs/TRACEABILITY.md`, 168 requirements).

## v0.1.12 — 2026-08-30

First published build.

RadEAU is an automotive Ethernet network analyzer: a native Rust core with a WebView user interface (Tauri 2, React, TypeScript) that captures, classifies, dissects and records SOME/IP, SOME/IP-SD, gPTP and DoIP traffic alongside the standard protocols a bench NIC carries. It ships with `ecu-netsim`, a deterministic simulator of a sensor-fusion network with a gPTP grandmaster, used for demos, fixtures and end-to-end tests.

v0.1.12 is a bench build for Windows laptops, with a CI-built Linux AppImage: everything needed to capture from a NIC, a pcap file or the simulator, read the trace like Wireshark, decode SOME/IP payloads against an AUTOSAR extract, and bring a capture home as a pcap. Charting, live topology, transmission and automation are not yet functional (see Known limitations).

### Highlights

- **Trace view.** Every frame a source delivers becomes exactly one row; the classifier never drops silently. Two table modes: *Fixed* (default, rewrite-in-place per key with a pin column and a live per-key cycle time) and *Sequential* (append, follows the tail, configurable history window). Per-column filters for Service:Method, Name, Protocol and Direction with a `Filtered · shown/total` chip. Session or wall-clock time column. A Dropped chip appears whenever frames were lost, with an accumulator / gap / kernel / recording breakdown in its tooltip; a Recording chip shows while a pcap is being written. Received, emitted, dropped, gap and malformed counters and a per-class line live in Network › Connection.
- **Layered dissection.** Expanding a row fetches the frame from a bounded raw-frame ring (65,536 frames / 96 MiB, retained after stop) and renders a per-protocol layer tree with field rows and a hex dump with offsets. Parse failures keep the transport layer and show the payload as data.
- **Catalog-driven decode.** An AUTOSAR Ethernet communication extract (ARXML, adaptive-platform flavour) is imported at runtime through a file picker, preloaded from the `RADEAU_CATALOG` environment variable at startup, or embedded from `catalog/sensor-fusion.arxml`. Service, event and field names appear on trace rows; the dissection shows a decoded signal table (name, raw hex, raw decimal, scaled value, unit) using COMPU-METHOD scaling and TEXTTABLEs. Every skipped element is a visible diagnostic; a failed import reports its error and leaves the previously active catalog in place rather than switching silently.
- **Four capture sources** behind one static-dispatch channel layer: simulator link, pcap/pcapng file, pcap record stream over TCP, and a live interface via Npcap/libpcap bound at runtime (no SDK, no link-time dependency).
- **pcap in, pcap out.** Continuous pcap recording while capturing (armed record switch, bounded drop-oldest writer thread, 2 s flush, live counters in the Recorder view; a writer error disarms the switch). Recordings default to `Documents\RadEAU\recordings` as `radeau-YYYYMMDD-HHMMSS.pcap`; the directory is editable in the Recorder, which lists the 50 newest files (frame counts omitted above 64 MiB). Export of the buffered frame ring to pcap at any time, and replay of any recording through the pcap source. Exports and recordings are classic pcap with the nanosecond magic.
- **Bench diagnostics.** Settings › Dependencies probes Npcap, libpcap, the Vector XL Driver Library and the Vector driver package (Installed with version, Missing, Blocked when Npcap was installed admin-only, N/A for the other platform's library; a button opens the official download page). Settings › Diagnostics produces a copyable plain-text report (version, build profile, OS, log path, dependency probe results, catalog source and service count, and the last 20 warning/error lines of the log). The core writes a JSONL log to `%LOCALAPPDATA%\com.cynacons.radeau\logs\radeau.log`, rotated at 5 MiB with `radeau.log.1` to `.3` kept; if the log queue overflows, a "log lines dropped" line records the count.
- **Bounded streaming.** Frames flow core → UI as columnar batches on a 16 ms deadline cadence with 3-credit backpressure and a 4,000-frame drop-oldest accumulator; drops are counted and displayed, never hidden.
- **Honest UI.** Views and settings whose backend has not landed show an explicit empty state or a disabled control labelled with the version it arrives in. Two exceptions remain in this build: the Signals view explorer lists a static placeholder catalog (not the imported ARXML), and the Transmit-only switch in Settings › Interface is a visual stub with no effect.

### Protocols decoded

29 protocol classes, each with its own row identity, Name/Type tables, fixed-mode key and dissection layer.

**Automotive**
- SOME/IP — header, message types (notification, request, request-no-return, response, error), session id; classified on any port by header plausibility, VLAN-tagged, over IPv4 and IPv6
- SOME/IP-SD — Offer / Find / StopOffer / Subscribe / StopSubscribe / SubscribeAck / SubscribeNack, entries (options are length-checked but not decoded)
- gPTP (IEEE 802.1AS over Ethernet 0x88F7) — Sync, Follow_Up, Pdelay_Req, Pdelay_Resp, Pdelay_Resp_Follow_Up, Announce, Signaling
- PTP over UDP 319/320 (IEEE 1588, any transportSpecific)
- DoIP (ISO 13400-2) over UDP and TCP 13400 — header NACK, vehicle identification requests and announcement (VIN, logical address, EID, GID), routing activation, alive check, entity status, power mode, diagnostic message and ACK/NACK, with a UDS service-id sub-layer (session control, DIDs, DTC read, security access, routine control, download set, TesterPresent, positive responses, NRC)

**Network and transport**
- Ethernet II, 802.1Q and QinQ (0x88A8) VLAN tags, ARP
- IPv4, ICMPv4 (named types and codes), IGMP v1–v3
- IPv6 with extension-header walk (hop-by-hop, routing, fragment, destination options; AH/ESP terminate), ICMPv6 including NDP (RS/RA/NS/NA with options) and MLD
- UDP, TCP, SCTP (common header and chunk walk)

**Applications**
- DHCPv4 (options) and DHCPv6
- DNS, mDNS, LLMNR (compression-safe names, questions and answers)
- NTP, SSDP, TFTP, SNMP v1/v2c (bounded BER walk)
- HTTP (request/status line, headers), TLS (record and handshake; ClientHello SNI and ALPN, ServerHello cipher suite), SSH (banner and packets)

**Layer 2**
- LLDP (TLV walk), AVTP / IEEE 1722 (subtypes, stream id, sequence, timestamp, AAF format fields), MACsec SecTAG, EAPOL and EAPOL-Key

**Fallback classes** — other UDP, other TCP, other IPv4 protocol, other EtherType, malformed (runt) frame. Every decoder is bounded and panic-free on arbitrary input.

### Capture sources

Chosen in Settings › Interface; the app-bar run control starts and stops the session everywhere. The release build defaults to Physical interface when Npcap is installed and to pcap file otherwise.

- **Simulator link** — TCP client to `ecu-netsim`'s monitor link (default `127.0.0.1:5560`): JSON handshake carrying node names and addresses, then length-prefixed binary records with switch nanosecond timestamps; gap records on simulator overflow; reconnect with backoff. Records and the handshake are each capped at 64 KiB, so a misbehaving peer cannot exhaust memory.
- **pcap file** — pure-Rust reader for classic pcap (both byte orders, µs and ns) and pcapng (SHB/IDB/EPB/SPB, per-interface resolution); Ethernet link type only, other link types refused with a diagnostic. Paced by record timestamps (*realtime*: inter-record gaps honoured up to 5 s, longer gaps collapsed and counted in the end-of-file summary) or *fast* (throttled by the accumulator so nothing drops). Records over 256 KiB end the file as a truncated tail; oversized unknown pcapng blocks are skipped. End of file ends the session with a summary (frames, collapsed gaps, truncation) and returns the run control to Start; rows and dissection stay available.
- **pcap stream** — the same parser over a TCP connection to `host:port` (for example a remote `tcpdump -w -` piped through a socket), preserving remote wire timestamps.
- **Physical interface** — runtime-bound `wpcap.dll` (Npcap) on Windows or `libpcap.so` on Linux: interface picker with stable ids and refresh, editable BPF filter (default `udp or ether proto 0x88f7 or arp or vlan`), promiscuous and immediate mode, nanosecond precision when negotiable, kernel drop counters from `pcap_stats`, and privilege/access failures mapped to a remedy sentence. The Npcap loopback device (BSD `DLT_NULL` framing) is supported.
- **Dev generator** — seeded synthetic SOME/IP/SD/gPTP frames at idle/normal/stress/burst rates; debug builds only, absent from the release build.

Timestamps are host time for live capture, switch time for the simulator, and file time for pcap. Direction is Rx for live and simulator frames (live capture labels every frame Rx, including frames the host itself transmitted); pcapng files with EPB direction flags show Rx/Tx, classic pcap files show `—`.

### Simulator (ecu-netsim)

`ecu-netsim` generates a fully serialized sensor-fusion network on a nanosecond-stamped virtual switch and serves it over the monitor link on `127.0.0.1:<port>`.

- **Cast:** camera 10.42.0.11 (CameraObjects 0x1101, ObjectList every 33 ms), radar 10.42.0.12 (RadarTargets 0x1102, 50 ms), lidar 10.42.0.13 (LidarClusters 0x1103, 100 ms, 802.1Q VLAN 10 on UDP port 30501), dynamics 10.42.0.14 (VehicleDynamics 0x1104, 10 ms), fusion 10.42.0.20 (FusedObjects 0x1201: FusedTrackList 50 ms, FusionStats 1 s; gPTP grandmaster), a DoIP tester at 10.42.0.99 and a second PTP clock candidate at 10.42.0.30.
- **Traffic:** cyclic SOME/IP events with payloads encoded per the checked-in ARXML extract (deterministic waveforms), SD offers, gPTP Sync/Follow_Up, ARP request/reply pairs, ICMPv6 NDP (RS/RA/NS/NA), a periodic runt frame, a DoIP vehicle announcement plus a tester session (routing activation, TesterPresent cycle, periodic ReadDataByIdentifier), and standard background traffic on fixed schedules: mDNS, DHCPv4/v6, NTP request/response, LLDP every 30 s, an AVTP AAF stream at 100 Hz, PTP-over-UDP Announce and Sync from the second clock candidate, an HTTP GET/response and a TLS handshake.
- **CLI:** `--monitor-port N` (default 5560), `--seed N` (deterministic traffic), `--udp-target IP` (additionally emits the SOME/IP, SD and DoIP discovery datagrams from real host sockets bound to source ports 30490 / 30501 / 13400, falling back to ephemeral ports with a warning, so a live NIC or the loopback device sees real traffic; raw-Ethernet classes and DoIP over TCP stay monitor-only), `--write-pcap PATH --duration SECONDS` (accelerated, socket-free fixture generation), `--version` / `-V`, `--help` / `-h`.

### Known limitations

- **Windows x64 portable zip is the bench-tested artifact.** The Linux AppImage and tarball are built by CI from the same sources; the libpcap binding's platform-independent parts are unit-tested, but the Linux build has not yet been exercised on a bench, and there is no macOS build or capture backend.
- **Live capture requires Npcap**, installed separately from npcap.com with "Restrict Npcap driver's access to Administrators only" left unchecked. RadEAU never bundles a driver and never elevates. Windows NIC drivers may strip 802.1Q tags before Npcap sees them (noted in the Npcap dependency row).
- **The default live BPF filter** keeps UDP, gPTP, ARP and VLAN-tagged frames; widen or clear it in Settings › Interface to capture TCP-based classes (DoIP over TCP, HTTP, TLS, SSH) and untagged L2 classes (LLDP, AVTP, MACsec, EAPOL) on a live NIC.
- **Vector XL (VN56xx) attach is not available.** The backend needs the XL Driver Library header, which is not part of this build; the Dependencies panel already probes `vxlapi64.dll` and the driver package. No hardware timestamping on any source; live timestamps are host time.
- **Signals view is a placeholder**: the chart engine has not landed, the plot area is an empty drop target, and the signal explorer shows a static placeholder catalog rather than the imported ARXML. Network view shows a truthful Connection panel only; Topology, SD monitor and PTP status are empty states. Simulation and Automation views are empty states. Settings groups Performance (v0.8), Automation (v0.7), Memory (v0.8) and the two Diagnostics switches (v0.6) are disabled and labelled; the Transmit-only switch is a stub that toggles nothing.
- **DoIP over TCP** is dissected per segment without per-connection reassembly; mid-stream segments are labelled as such. SOME/IP-TP segmentation, SOME/IP over TCP and multicast eventgroup handling are not decoded. gPTP BMCA state is not tracked.
- **ARXML import** covers adaptive-platform Ethernet communication extracts (service interfaces, SOME/IP deployments, events, fields, linear COMPU-METHODs, TEXTTABLEs). Classic System Descriptions are detected and refused with a diagnostic. Nested records, arrays, strings, bitfields and per-service byte-order overrides are not decoded. Import is through the file picker; drag-and-drop is pending.
- **Recording is pcap only** (no decoded recording format, no paced replay controls beyond the pcap source's realtime/fast pacing). Recording is unavailable when the capture source is itself a pcap file. Because exports and recordings are classic pcap, they carry no direction when replayed. Bounds: frame ring 65,536 frames / 96 MiB, accumulator 4,000 frames, recording queue 8,192 frames; overflow is counted and displayed. The endpoint table holds 255 addresses per session, after which new addresses share an overflow bucket.
- **Line-rate behaviour is not yet validated** on a 1000BASE-T1 bench; the Fixed-mode collapse is rebuilt per publish and is a known hardening item.
- **Nothing persists across launches:** capture source, addresses, BPF filter, trace filters and the recording directory all return to defaults; no automation server, no node plane, no transmission.

### Portable build contents and how to run

`npm run build:portable` produces `dist-portable/RadEAU-<version>-win64.zip` (`tauri build --no-bundle` with the UI embedded, plus a release `ecu-netsim`). The zip contains:

| File | Purpose |
|---|---|
| `radeau.exe` | RadEAU release app (embedded UI, no dev server) |
| `ecu-netsim.exe` | Companion ECU network simulator for a local demo |
| `sensor-fusion-5s.pcap` | Short fixture for Settings › Interface › pcap file replay (1,578 frames; SOME/IP, SD, gPTP, ARP, DoIP over UDP and TCP, TCP, ICMPv6, DHCP, DNS, NTP, PTP, LLDP, AVTP, HTTP, TLS) |
| `sensor-fusion.arxml` | Sensor-fusion service catalog extract |
| `README-portable.md` | Target-machine instructions |

**Prerequisites (Windows 10/11):** the WebView2 runtime (present on updated Windows); Npcap for live NIC capture. Vector VN hardware is not supported yet; the Dependencies panel only reports whether the XL Driver Library and driver package are installed.

**Linux:** `chmod +x RadEAU_<version>_amd64.AppImage` and run it; the tarball carries `ecu-netsim`, the fixture and the catalog extract. Live capture binds the distribution's `libpcap` at runtime and needs the usual packet-capture privileges.

**Run:**
1. Unzip and double-click `radeau.exe`. No Node, Rust or Visual Studio is required on the target machine. The app never opens a console window; all diagnostics go to the log file and the Diagnostics report.
2. Optional local demo without a bench: in a terminal next to the files, `ecu-netsim.exe --monitor-port 5560 --udp-target 127.0.0.1`, then Settings › Interface › Simulator link at `127.0.0.1:5560` and Start from the app bar.
3. Optional live demo through Npcap: with the Npcap loopback adapter installed, run the same `ecu-netsim.exe --udp-target 127.0.0.1` command, choose Settings › Interface › Physical interface, pick the loopback adapter and Start; the SOME/IP, SD and DoIP UDP traffic arrives as real captured frames.
4. Or replay the bundled fixture: Settings › Interface › pcap file, browse to `sensor-fusion-5s.pcap`, pace *fast*, Start.

**First-run checklist:** Settings › Dependencies (confirm Npcap) → Settings › Interface (Physical interface / Simulator link / pcap) → Start → Export buffered frames as pcap from the Trace rail or the Recorder view when a capture is worth keeping.

**Reporting a problem:** copy the Settings › Diagnostics report, attach `%LOCALAPPDATA%\com.cynacons.radeau\logs\radeau.log`, and attach a pcap export of the buffered frames when useful.

### Verification

- **Unit tests.** 220 Rust test functions across the workspace (app core 91, `radeau-proto` 89, `ecu-netsim` 15, `radeau-pcap` 9, `radeau-livecap` 8, `radeau-catalog` 8; counted from source, one of them ignored by default) covering codec round-trip vectors, random-prefix no-panic tests, a byte-exact regression vector recorded from a live simulator session, the ARXML fixture corpus (`fixtures/arxml/`) and the pcap fixture coverage test; 217 vitest cases in 25 files on the UI side, including a test that pins the Rust and TypeScript protocol-code tables against each other. `npm run ci` runs typecheck, unit tests, theme-token sync, colour-literal and requirement-ID lints, and the unused-dependency check.
- **E2E smoke (`scripts/e2e-smoke.mjs`, `npm run test:e2e`).** Launches the real debug binary hidden on a random Chrome DevTools Protocol port with a per-run WebView2 profile and drives it through the DOM. Phases: shell mounts; run gate with Fixed-mode default (rewrite-in-place verified by row fingerprints) and Sequential growth; simulator-link session with handshake-derived endpoint names and the Network Connection panel showing Connected; layer-by-layer dissection of a live frame with `frame_detail` timings and an event-loop lag sampler; catalog-driven content (names on rows, decoded signal table, no malformed layers); per-column filtering with chip counts and the filtered empty state; DoIP dissection with UDS fields; ICMPv6 Router Advertisement, DNS, TLS ClientHello and LLDP spot checks; a no-malformed sweep across every protocol class; Settings › Dependencies and Diagnostics report; pcap file replay to end-of-file with the wall-clock time toggle; live loopback capture through Npcap of `ecu-netsim --udp-target` traffic (skipped honestly when Npcap or the loopback device is absent); and continuous pcap recording (arm, run, stop, file present with matching size, Recorder list).
- **Release-bundle E2E (`scripts/e2e-release.mjs`, `npm run test:e2e:release`).** Launches the zipped `radeau.exe` with the dev server confirmed down, and asserts: window title, About dialog reporting build profile *release* and a version, no Dev generator option in the Interface select, four Dependencies rows, fixture replay producing rows including a DoIP row, the session ending itself at end of file with the run control back to Start and the rows retained, and the Network view showing Closed · end of file.
