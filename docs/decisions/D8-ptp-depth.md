# D8 — PTP simulation depth

Status: Accepted · 2026-08-26

## Context

The simulator must produce gPTP traffic realistic enough for RadEAU's PTP
analysis views and for PTP-stamped sensor payloads to tell a true latency story
([SRS_ecu_netsim.md](../SRS_ecu_netsim.md) §5–6). Full 802.1AS — BMCA, path
delay asymmetry handling, TSN shaping — is far more machinery than the v1
observation and demo goals require ([PRD.md](../../PRD.md) §1.3).

## Decision

**gPTP two-step with modeled clocks and a simple servo; static grandmaster; no
BMCA and no TSN shaping in v1.** Concretely: Sync + Follow_Up at 125 ms, Pdelay
at 1 s, Announce at 1 s over EtherType 0x88F7, domain 0; per-node clock models
with initial offset and ppm drift; a servo that steps on first sync then applies
proportional rate correction ([SRS_ecu_netsim.md](../SRS_ecu_netsim.md) §5).

## Consequences

- The convergence trajectory is deliberately observable — offset-vs-time is a
  demo chart, and `clock_step` / `clock_drift` faults have visible consequences
  (PT-002, NV-003 in [SRS_ecu_netsim.md](../SRS_ecu_netsim.md) §9).
- Sensor payloads carry PTP-corrected node time, so end-to-end fusion latency is
  measurable without full-standard fidelity.
- Grandmaster election scenarios cannot be simulated in v1; BMCA sits in the
  backlog behind the same message plumbing.
- The wire format is real 802.1AS framing, so RadEAU's gPTP classification and
  any third-party dissector parse the same bytes today and when depth grows.
