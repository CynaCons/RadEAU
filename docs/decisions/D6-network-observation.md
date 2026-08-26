# D6 — Network observation model

Status: Accepted · 2026-08-26

## Context

RadEAU needs a way to observe (and inject into) a network from day one, but live
promiscuous capture requires drivers, privileges, and per-platform work
([PRD.md](../../PRD.md) §3.5). The companion simulator already serves a
monitor/inject data plane from its virtual switch — length-prefixed binary
records with switch-time ns stamps and explicit gap records on overflow
([SRS_ecu_netsim.md](../SRS_ecu_netsim.md) §8).

## Decision

**Observe via the simulator's virtual-switch monitor link first**, as the
default channel backend. **Npcap/libpcap live capture is a later backend behind
the same compile-time channel API** ([PRD.md](../../PRD.md) §3.5) — same
open/read/write/status surface, same stable selection identifiers, no changes
above the channel layer.

## Consequences

- The whole product is developable, testable, and demonstrable on a laptop with
  no automotive network and no capture drivers or elevation.
- The channel abstraction is exercised by a real second implementation
  (simulator link alongside the loopback pseudo-channel) before pcap arrives,
  keeping the API honest.
- Capture-privilege detection and diagnostics ([PRD.md](../../PRD.md) §3.5) are
  deferred with the pcap backend, not skipped.
- Everything downstream — classification, decode, recording, views — is written
  against channel frames, so the pcap backend slots in without touching
  consumers.
