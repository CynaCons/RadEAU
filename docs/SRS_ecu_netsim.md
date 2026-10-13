# SRS — ECU Network Simulator (`ecu-netsim`)

**Scope:** The companion simulator — virtual network model, SOME/IP runtime,
service discovery, gPTP time synchronization, the sensor-fusion scenario, fault
injection, and the monitor/injection/control links — plus the Network-view
requirements that observe it. Wire formats: [SRS_protocols.md](SRS_protocols.md).
Product context: [PRD.md](../PRD.md) §7. ID prefixes: `SP-`, `SD-`, `PT-`,
`NS-`, `NV-`.

---

## 1. Purpose and shape

A standalone Rust binary in the same workspace, sharing the protocol codec
crates with the core (one codec, tested once). It simulates a small automotive
Ethernet network — a virtual switch, simulated ECUs with their own clocks,
SOME/IP service runtimes, service discovery, and gPTP — and serves a
monitor/inject link that RadEAU consumes as its default channel. It is
simultaneously the primary development data source, the permanent E2E/soak
fixture generator, and the demo.

CLI: `ecu-netsim --scenario <file> [--seed <n>] [--accelerated]
[--monitor-port 5560] [--control-port 5561]`. Loopback bind by default.

## 2. Network model

- **Virtual switch:** one port per node plus a monitor port; store-and-forward
  with configurable per-link latency and jitter; bounded per-port queues with
  drop counters. Frames on the virtual wire are **fully serialized Ethernet II**
  — dst/src MAC, optional 802.1Q tag, EtherType (0x0800 IPv4, 0x88F7 gPTP,
  0x0806 ARP) — with real IPv4/UDP headers and valid checksums, so RadEAU's
  decoders and any third-party dissector parse the same bytes.
- **Addressing:** locally administered MACs `02:52:41:44:00:xx`; IPv4
  `10.42.0.0/24`.
- **Scheduler:** a virtual event scheduler drives all behavior. Real-time pacing
  by default; an **accelerated deterministic mode** for tests runs the same event
  stream as fast as possible. One seeded RNG; behavior models never read the wall
  clock — determinism is a feature, not an accident.

## 3. SOME/IP runtime

Server and client runtimes per node: cyclic event publication with configurable
cycle time and jitter, request/response methods with a configurable processing
latency model, fire-and-forget, per-client session-id discipline (1→0xFFFF, wrap
to 1), correct message types and return codes per
[SRS_protocols.md](SRS_protocols.md). Events flow only to subscribed endpoints
(unicast eventgroups in v1).

## 4. Service discovery (SOME/IP-SD)

UDP port 30,490; configurable multicast group (default 224.244.224.245). SD
messages ride a standard SOME/IP header (Service 0xFFFF, Method 0x8100,
NOTIFICATION) with the SD payload: flags (reboot, unicast), entries
(FindService 0x00, OfferService 0x01 — StopOffer = TTL 0, SubscribeEventgroup
0x06, SubscribeEventgroupAck 0x07 — Nack = TTL 0), and options (IPv4 endpoint
0x04, IPv4 multicast 0x14).

Server lifecycle: initial delay (uniform in a configured window, default
10–100 ms) → repetition phase (base 30 ms, doubling, default 3 repeats) → main
phase cyclic offers (default 1 s). Default TTL 3 s; TTL bookkeeping marks
services down on expiry. Clients find on demand, subscribe on offer, renew
before TTL expiry, and surface Nacks. The reboot flag plus session-id
regression signals a node restart; learned state is discarded.

RadEAU's own SD model (Network view) is a **passive observer**: it derives
service and subscription state purely from observed traffic, never by
participating.

## 5. Time synchronization (gPTP / IEEE 802.1AS)

Layer-2 transport: EtherType 0x88F7 to the multicast address
01:80:C2:00:00:0E, domain 0. Two-step sync — Sync + Follow_Up at 125 ms default
interval — plus Pdelay_Req/Resp/Resp_Follow_Up at 1 s and Announce at 1 s. The
grandmaster is statically configured in v1 (BMCA in backlog).

Each simulated ECU has its own clock model: initial offset plus drift in ppm
(optionally a slow random walk). A simple servo (step on first sync, then
proportional rate correction) converges each node to the grandmaster; the
convergence trajectory is deliberately observable — offset-vs-time is a demo
chart. Nodes stamp their published sensor payloads with **PTP-corrected node
time**, so fusion latency is measurable end to end. Every frame crossing the
switch is stamped with switch time in ns; that stamp becomes the frame's
network timestamp (PRD §3.3).

## 6. Sensor-fusion scenario (default, checked in)

One seeded **ground-truth kinematic scene** (2-D constant-velocity objects with
process noise) shared by all sensor models. Each sensor observes the same scene
through its own field of view, noise, latency, and dropout model — so the same
physical object appears in camera, radar, and fused outputs, and plotting
`camera.obj0_x` against `radar.target0_x` against `fusion.track0_x` tells a true
story. All payloads are plottable numeric signals.

| ECU | IP | Service | Events / methods | Cycle |
|---|---|---|---|---|
| CameraECU | 10.42.0.11 | CameraObjects 0x1101 | ObjectList event (≤16 objects: x, y, vx, vy, class, confidence) | 33 ms |
| RadarECU | 10.42.0.12 | RadarTargets 0x1102 | TargetList event (≤32 targets: range, azimuth, range rate, RCS) | 50 ms |
| LidarECU | 10.42.0.13 | LidarClusters 0x1103 | ClusterList event (clusters: centroid, extent, point count) | 100 ms |
| VehicleDynECU | 10.42.0.14 | VehicleDynamics 0x1104 | Dynamics event (speed, yaw rate, ax, ay, wheel speeds) | 10 ms |
| FusionECU (gPTP GM) | 10.42.0.20 | FusedObjects 0x1201 | FusedTrackList event (tracks: id, x, y, vx, vy, quality, contributing-sensor mask) 50 ms; FusionStats event (input latencies, matched/unmatched counts) 1 s; SetFusionMode method (request/response) | — |

The fusion model is deliberately simple and deterministic: PTP-time alignment,
nearest-neighbor association, alpha-beta filtering. It exists to generate
truthful, correlated traffic — not to advance the state of the art.

**Background traffic realism.** The live scenario also carries what a real
bench carries, on a fixed schedule so it stays deterministic under `--seed`:
each ECU in turn sends an ARP request for the fusion ECU and receives its
reply (one pair every 2 s, rotating through the nodes); LidarECU's traffic is
802.1Q-tagged (VLAN 10, PCP 5) and its ClusterList events use UDP port 30501
while its SD offers stay on 30490 — a tagged, off-port SOME/IP source;
FusionECU sends an ICMPv6 Router Solicitation (EtherType 0x86DD) every 5 s;
VehicleDynECU emits one 10-byte runt frame every 10 s. Together they make the
honest-classification path (SP-006..SP-008) observable in the default demo
and assertable by the E2E.

**Real-socket emission (`--udp-target <ip>`).** Besides the monitor link, the
simulator can transmit every SOME/IP and SD datagram it generates as a real
UDP datagram from a host socket to the given address (destination port = the
frame's UDP destination port, source port bound per ECU when free), so a live
capture backend can be verified on a laptop with no bench: capturing the
loopback device while `--udp-target 127.0.0.1` runs shows the same services
as real traffic (SRS_capture CP-012). Raw-Ethernet classes (gPTP, ARP, VLAN
tags, runts) cannot be sent from a host socket and are only on the monitor
link; the flag documents that limitation in its help text.

## 7. Fault injection

Verbs, all via the control channel, all deterministic under seed + accelerated
mode: `stop_offer` / `resume_offer` (service), `drop_events` (service, count),
`delay_events` (service, ms, duration), `clock_step` (node, µs), `clock_drift`
(node, ppm), `reboot_node` (node — SD reboot flag observable), `pause_node` /
`resume_node`, `link_flap` (port, ms). Every verb exists so RadEAU can *show*
its consequence.

## 8. Monitor, injection, and control links

- **Monitor / inject data plane (TCP 5560):** version-checked handshake, then
  length-prefixed binary records: `{u32 length, u64 switch-time ns, u16 port id,
  u8 direction, raw frame bytes}`. The outbound queue is bounded; overflow emits
  an explicit **gap record** (dropped count + time span) — RadEAU renders a
  capture-gap marker, never silently missing data. Injection uses the same
  connection with framed inject records; injected frames enter the switch as a
  tagged port and are routed like any node's traffic.
- **Control channel (JSON-RPC, TCP 5561):** scenario lifecycle (load / start /
  stop / status), node and service listing, fault verbs (§7). Same header and
  security discipline as the automation surface (PRD §8.1): loopback default;
  external bind requires token + allowlist or startup rejection.

## 9. Requirements

| ID | Requirement | Priority | Status | Acceptance criteria |
|---|---|---|---|---|
| SP-001 | Encode/decode the full SOME/IP header exactly; Length covers Request ID through payload end | Must | Verified | Round-trip and byte-exact header vectors are checked; malformed/truncated lengths return bounded errors, never a panic |
| SP-002 | Message-type semantics: 0x00/0x01/0x02/0x80/0x81; event method ids carry the high bit | Must | Superseded (by SP-019, SP-020) | Type/id inconsistencies are flagged in Trace, not dropped |
| SP-003 | Simulator SOME/IP session ids increment 1→0xFFFF per ECU stream and wrap to 1; 0 is skipped | Must | Verified | Unit coverage proves wrap behavior; monitor generation uses the same helper for events and SD offers |
| SP-004 | Payload decode against the catalog: big-endian default with per-service override, base types at fixed offsets, MSB0 bit slices, physical = raw × factor + offset in f64 | Must | Superseded (by SP-021, SP-022) | Core and UI decoders agree bit-for-bit on the shared vector corpus (floats, signed widths, bit slices, byte straddles) |
| SP-005 | Payload shorter than a field's extent → signal missing; never partial, never panic | Must | Verified | Truncated vectors decode with the field absent; decoded emitted payloads remain finite |
| SP-006 | Classification never drops: every delivered frame gets exactly one protocol class (SOME/IP, SD, gPTP, ARP, UDP, TCP, ICMP, IPv6, IPv4, Other, Malformed) and is retained for dissection | Must | Verified | Mixed fixtures and runt frames render one Trace row per frame with the expected class |
| SP-007 | 802.1Q / 802.1ad tags are peeled (one or two); outer VLAN id carried, inner EtherType classified; dissection shows the tag layer with correct downstream offsets | Must | Verified | Tagged and double-tagged vectors retain the outer VLAN id and classify/dissect against the inner EtherType offsets |
| SP-008 | SOME/IP is recognized by header plausibility on any UDP port; 30490 is a fast path, never a gate | Must | Verified | Events on a non-30490 port classify as SOME/IP; a random 16-byte UDP payload does not |
| SP-009 | Direction is relative to RadEAU's host: Rx observed, Tx originated by RadEAU, unknown when the source cannot say — never guessed | Must | Verified | Simulator frames render Rx; a source without direction metadata renders "—" |
| SP-010 | Capture statistics (received, emitted, accumulator drops, gaps, malformed, kernel drops, per-class counts) are emitted at 1 Hz and at stop, and rendered in the UI | Must | Verified | A forced accumulator overflow shows a non-zero drop count in the Trace chip and the Network connection panel |
| SP-011 | DoIP header and payload codec per ISO 13400-2 (SRS_protocols §6): version / inverse-version validation, the listed payload types decoded, length sanity cap, bounded and panic-free | Must | Verified | Checked-in vectors for every listed payload type round-trip; a mismatched inverse version dissects as malformed, never panics |
| SP-012 | DoIP classification on UDP 13400 and boundary-aligned TCP 13400; identity columns carry logical addresses and the UDS SID; mid-stream TCP segments stay honest `TCP` | Must | Verified | Simulator discovery and diagnostic frames render as `DoIP` rows with named payload types; a TCP segment without a DoIP header renders as `TCP` |
| SP-013 | UDS sub-layer for 0x8001 messages: SID name, positive / negative response mapping with NRC names, sub-function and DID where applicable | Must | Verified | TesterPresent and ReadDataByIdentifier dissections show the named SID, sub-function / DID and the response pairing |
| SP-014 | The simulator carries a deterministic diagnostic session (announcements, routing activation, TesterPresent, ReadDataByIdentifier VIN) so DoIP is observable in the default demo and assertable by the E2E | Must | Verified | The E2E finds DoIP rows for discovery and diagnostic types within 15 s of a seeded run |
| SP-015 | IPv6 extension-header walk with transport dispatch identical to IPv4 (UDP/TCP application classes, SOME/IP and DoIP over IPv6); ICMPv6 and ICMPv4 rows name their types; IGMP and SCTP classified | Must | Verified | Fixtures for RS/RA/NS/NA, MLD, echo, a SOME/IP datagram over IPv6, a fragmented IPv6 packet, IGMPv3 and SCTP INIT render with the expected class, name and layer fields |
| SP-016 | UDP application classes (DHCPv4/v6, DNS/mDNS/LLMNR, NTP, SSDP, PTP over UDP, TFTP, SNMP) classified by port with a format check and dissected per SRS_protocols §7 | Must | Verified | One fixture per class round-trips; a random payload on each port stays `UDP`; DNS name compression and SNMP BER are bounded (random-prefix no-panic sweep) |
| SP-017 | L2 classes (LLDP, AVTP, MACsec, EAPOL) classified by EtherType and dissected (TLVs, AVTP subtypes, SecTAG, EAPOL-Key) | Must | Verified | One fixture per class; LLDP TLV walk stops at End-of-LLDPDU or truncation with a named partial layer |
| SP-018 | TCP application classes (HTTP request/status lines + headers, TLS record/handshake with SNI and ALPN, SSH banner) classified by port or by content signature, never by port alone for HTTP/TLS | Must | Verified | ClientHello with SNI, a GET with Host, an SSH banner render; a TCP segment with random bytes on port 443 stays `TCP` |
| SP-019 | Message-type semantics as shipped: 0x00/0x01/0x02/0x80/0x81 are preserved in the Trace type columns; simulator event method ids carry the high bit | Must | Verified | Known message types map to stable Trace type codes; generated event frames carry high-bit method ids |
| SP-020 | Type/method-id inconsistencies (an event type without the method high bit, or a request type with it) are flagged in Trace, not dropped | Must | Planned | A crafted inconsistent frame renders with a visible flag and stays in the trace |
| SP-021 | Whole-byte payload decode against the catalog: big-endian base types at fixed offsets; physical = raw × factor + offset in f64 | Must | Verified | Catalog and simulator tests cover signed and float vectors plus the sensor-fusion catalog payload decode |
| SP-022 | Per-service byte-order override and MSB0 bit slices in payload decode, core and UI decoders bit-identical | Must | Planned | Core and UI decoders agree bit-for-bit on the shared vector corpus (bit slices, byte straddles, little-endian override) |
| SD-001 | Server lifecycle: initial delay → doubling repetition → cyclic main phase; StopOffer via TTL 0 | Must | Superseded (by SD-006, SD-007) | Offer cadence on the monitor stream matches configured phases within jitter bounds |
| SD-002 | TTL bookkeeping: no re-offer within TTL → service down | Must | Planned | Killing a node marks its services down within TTL + one cycle in the Network view |
| SD-003 | Subscribe / Ack handshake precedes event flow; Nack surfaces as an error state | Must | Planned | No event frames toward a subscriber precede its Ack on the monitor stream |
| SD-004 | Reboot detection (flag + session-id regression) discards learned state | Must | Planned | `reboot_node` → offers and subscriptions relearned; no stale subscription edges |
| SD-005 | RadEAU's SD model is derived passively from observed traffic only | Must | Planned | Network view converges to identical state whether RadEAU attached before or after scenario start (within one TTL) |
| SD-006 | Shipped SD server traffic: cyclic OfferService every 1 s with TTL 3; the shared SD codec preserves StopOffer as OfferService with TTL 0 | Must | Verified | Simulator tests assert the cyclic monitor cadence; codec vectors assert TTL 0 StopOffer preservation |
| SD-007 | SD server initial-wait and doubling-repetition phases before the cyclic main phase | Must | Planned | Offer cadence on the monitor stream matches the configured phases within jitter bounds |
| PT-001 | Two-step gPTP: Sync/Follow_Up 125 ms, Pdelay 1 s, Announce 1 s, EtherType 0x88F7, domain 0, static GM | Must | Superseded (by PT-005, PT-006) | Cadence and field contents match checked-in vectors; correction fields consumed |
| PT-002 | Per-node clock model (offset, drift ppm) converges through the servo | Must | Planned | 500 µs initial offset + 50 ppm drift converges below 5 µs within 30 simulated seconds (seeded, accelerated) |
| PT-003 | Sensor payload timestamps use PTP-corrected node time | Must | Planned | Post-convergence, payload-stamp-derived input latency is stable within the configured jitter bounds |
| PT-004 | Every monitored frame carries a switch-time ns stamp; recordings persist it; replay preserves it | Must | Superseded (by PT-007, PT-008) | Recording lines include the stamp; a replayed session shows identical network timestamps |
| PT-005 | Direct-Ethernet two-step gPTP Sync/Follow_Up every 125 ms (EtherType 0x88F7, domain 0, static GM); codec support for Pdelay and Announce headers | Must | Verified | Simulator tests assert the Sync/Follow_Up cadence; codec vectors cover Sync, Follow_Up, Pdelay and Announce headers |
| PT-006 | Simulator Pdelay (1 s) and Announce (1 s) cadence on Ethernet with correction fields consumed | Must | Planned | Cadence and field contents match checked-in vectors; correction fields consumed |
| PT-007 | Simulator monitor records carry a switch-time ns stamp; the accelerated pcap export persists epoch + switch time | Must | Verified | Unit coverage checks serialized monitor record timestamps and generated pcap timestamps |
| PT-008 | RadEAU recordings persist the network (switch) timestamp and replay preserves it | Must | Planned | A recorded then replayed session shows identical network timestamps (PLAN v0.1.14) |
| NS-001 | Shipped simulator SOME/IP events, SD offers, and background IPv4/UDP traffic are serialized as Ethernet II / IPv4 / UDP with valid checksums | Must | Verified | Monitor and accelerated-pcap tests reparse generated frames and assert IPv4, UDP, and TCP checksums are valid |
| NS-002 | Determinism: same seed in accelerated pcap/export mode → byte-identical monitor stream | Must | Verified | Two accelerated exports with the same seed compare equal and records are monotonic in switch time |
| NS-003 | Monitor-client queues are bounded; overflow emits explicit gap records instead of silently losing frames | Must | Verified | A forced full writer queue test produces a gap record with the dropped count and time span |
| NS-004 | Real-time pacing accuracy at default scenario rates | Should | Implemented | Event jitter ≤ ±2 ms p99 over 60 s on a development laptop |
| NS-005 | Every fault verb (§7) is exposed on the control channel with an observable effect | Must | Planned | One E2E per verb asserts its consequence on the monitor stream or Network view |
| NS-006 | Scenario config is versioned, seeded YAML validated with precise errors | Must | Planned | Invalid configs are rejected with field-level messages; the default scenario is checked in and referenced by E2E |
| NV-001 | Topology view: ECUs, offered services, subscription edges from passive observation | Must | Planned | Matches the scenario definition after convergence; reflects changes within one SD cycle |
| NV-002 | SD monitor: per-service state machine with TTL countdown, correlated to Trace | Must | Planned | Selecting a state transition selects its frame in the Trace view |
| NV-003 | PTP status: sync tree and per-node offset/rate charts through the standard chart stack | Must | Planned | A `clock_step` fault is visible as an offset step followed by reconvergence |
| NV-004 | Until NV-001..003 ship, the Network view's Topology, SD monitor and PTP panels show honest empty states — no fabricated ECUs, services, counters or offsets | Must | Verified | Empty-state tests reject fabricated strings and the copy names the future live decode |
