# D9 — Simulator delivery

Status: Accepted · 2026-08-26

## Context

`ecu-netsim` is simultaneously the primary development data source, the
permanent E2E/soak fixture generator, and the demo
([SRS_ecu_netsim.md](../SRS_ecu_netsim.md) §1). It must speak exactly the wire
formats RadEAU decodes, and drift between two SOME/IP/SD/gPTP implementations
would silently invalidate every test built on it.

## Decision

**Deliver the simulator as a Rust crate plus a standalone binary in the same
workspace as the application, sharing the protocol codec crates with the core**
([PRD.md](../../PRD.md) §2, [SRS_ecu_netsim.md](../SRS_ecu_netsim.md) §1) — one
codec, tested once. It runs as a separate process and connects to RadEAU exactly
like a capture source, over the monitor/inject and control links.

## Consequences

- Encoder and decoder can never drift: the bytes the simulator emits are
  produced by the same codec crates the core parses with, and one shared vector
  corpus tests both.
- One workspace, one canonical build: CI builds and versions the simulator with
  the application, and E2E/soak suites always test matched pairs.
- Process isolation is preserved — the simulator is a peer on TCP
  (monitor 5560, control 5561), not a linked-in test mode, so it exercises the
  real channel path.
- The standalone binary doubles as the demo artifact: the full sensor-fusion
  network runs on a laptop with no automotive hardware attached
  ([PRD.md](../../PRD.md) §1).
