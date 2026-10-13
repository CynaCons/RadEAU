# SRS — Trace Analysis

Answers about a trace, not just its rows: what talks to what, which SOME/IP
services run at which cadence and latency, where the gaps and bursts are, how
service discovery and time sync behave. Built for agents first (the analysis
methods of [SRS_automation.md](SRS_automation.md)) and shown in the UI as a
snapshot (PLAN v0.1.16). The signal-array analysis mode that feeds charts
(PRD §6) is separate and stays with graphing. Owns the `AN-` prefix
([REQUIREMENT_IDS.md](REQUIREMENT_IDS.md)).

## 1. Requirements

| ID | Requirement | Priority | Status | Acceptance criteria |
|---|---|---|---|---|
| AN-001 | Analysis is one pass over either the core frame ring (a snapshot) or a pcap/pcapng file (streamed through the shared reader + classifier), on the blocking pool; memory is bounded independently of the input length — per-key running statistics, at most 4,096 retained samples per key for quantiles, at most 10,000 keys per table with overflow counted — and the result is one JSON report | Must | Planned | A 1,000,000-frame file analyses with flat memory in < 10 s (release); key overflow is reported, not silent |
| AN-002 | Overview: frames, bytes, duration; per protocol frames, bytes and share; endpoints (IPv4 address, else source MAC) with frames and bytes sent and the protocols seen; conversations (unordered endpoint pair + transport class) with frames, bytes, first and last time | Must | Planned | Unit: hand-built frame set → exact tables; per-protocol frames sum to the total |
| AN-003 | SOME/IP per (service, method): message counts by type, catalog names when a catalog is loaded; for notifications/events per (service, method, sender) the inter-arrival period (mean, min, max, p50, p99, standard deviation) and gaps — intervals above 3 × the median, at most 100 listed per key with time and length; for requests, pairing with responses by (service, method, session, endpoint pair) into latency statistics (mean, p50, p99, max), unanswered requests and error responses counted | Must | Planned | Unit: synthetic cyclic events with one injected gap → period and gap exact; synthetic request/response pairs → latency exact |
| AN-004 | SOME/IP-SD per offered service instance (service, instance, sender): offers, stop-offers, first and last seen, offer period statistics, last TTL, reboot detections (reboot flag set after being clear, or the SD session counter going backwards); per eventgroup: subscribes, acks, nacks | Must | Planned | Unit: offer sequence with a reboot → one reboot detected; fixture → each simulator node's offers at a 1 s period |
| AN-005 | gPTP per sender (source MAC): Sync, Follow_Up, Pdelay_Req, Pdelay_Resp, Announce counts, Sync period statistics, grandmaster identity from the latest Announce | Must | Planned | Fixture: the simulator grandmaster's Sync period 125 ms ± 1% |
| AN-006 | Bursts: the maximum frame count in any 10 ms window and the top 5 windows (start time, frames) | Should | Planned | Unit: a synthetic burst is the top window with its exact count |
| AN-007 | Automation methods (SRS_automation §2): `trace_analyze {from: {kind:"ring"} \| {kind:"file", path}, sections?: [overview, someip, sd, ptp, bursts]}` → the report; `service_summary {from?, service?}` → the SOME/IP section, optionally one service; `timing_report {from?, service, method}` → periods, latency and every gap for one service/method. `from` defaults to the ring | Must | Planned | E2E through radeau-mcp: `trace_analyze` on a simulator session lists every simulator SOME/IP service with its configured period |
| AN-008 | UI: the Network view's **Analyze buffered trace** action runs the analysis on the ring and shows a snapshot labelled with its frame count and time: endpoints and conversations in the Topology panel, the SD instance table in the SD monitor panel, the per-sender sync table in the PTP panel, and a SOME/IP services panel (service/method, kind, count, period mean/p99, latency p99, gaps). The live views NV-001..003 remain separate requirements | Must | Planned | E2E: after a simulator session the action fills the four panels; the services table lists 0x1101 with a ≈33 ms period |
| AN-009 | Accuracy against the simulator's seeded schedules (fixture `sensor-fusion-5s.pcap`): event periods 0x1101 33 ms, 0x1102 50 ms, 0x1103 100 ms, 0x1104 10 ms, 0x1201 50 ms, SD offers 1 s, gPTP Sync 125 ms — each mean within 1% | Must | Planned | Unit test over the checked-in fixture |
