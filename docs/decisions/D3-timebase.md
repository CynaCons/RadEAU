# D3 — Timebase

Status: Accepted · 2026-08-26

## Context

Frames need one authoritative time axis for pacing, plotting, and eviction,
while PTP analysis and cross-node latency work need network-derived time
([PRD.md](../../PRD.md) §3.3). The candidate domains are application arrival
time (monotonic, always present) and network time (switch/hardware nanosecond
stamps, sometimes absent).

## Decision

**Application arrival timebase as specified in [PRD.md](../../PRD.md) §3.3**:
milliseconds since process start, u32, from a monotonic instant latched once at
startup; UI rebase against a session-start latch; a > 30,000,000 s jump is a
timebase switch (live ↔ replay); u32 wrap is a session boundary. The **network
timestamp (nanoseconds) is a first-class optional field of the recording format
from v1** (storage frame, [SRS_protocols.md](../SRS_protocols.md) §1), preserved
through replay — but the application never paces itself on network time.

## Consequences

- One unambiguous hot-path timebase: pacing, rings, and eviction never depend on
  a field that may be absent.
- Network time is display/analysis-only (PTP charts, cross-node latency
  alignment), so a channel without hardware stamps degrades gracefully.
- Recordings carry the ns stamp from format v1 — no format migration when
  capture backends with hardware timestamps arrive.
- Arrival vs. network vs. embedded payload time remains representable as three
  distinct stamps — the latency story the tool exists to tell.
