# D5 — IPC transport for frame batches

Status: Accepted (provisional) · 2026-08-26

## Context

Frame batches are the highest-volume traffic crossing the core→UI boundary: one
event carrying an array of wire frames per deadline interval, under credit-based
backpressure ([SRS_streaming.md](../SRS_streaming.md) §1,
[SRS_protocols.md](../SRS_protocols.md) §1). [PRD.md](../../PRD.md) §10 requires
choosing the transport before tuning field encodings — the goal is one batch,
one allocation, one copy — and §11 requires the decision before the first frame
consumer is built.

## Decision

The candidate — **binary framing / structured clone over shared memory** — is
**adopted provisionally**. Per [PRD.md](../../PRD.md) §11 (D5), this choice
**must be confirmed (or replaced) before the first frame consumer** is
implemented; confirmation means a measured comparison on real batch shapes, not
a default that hardened by accident.

## Consequences

- Wire-frame field encodings are not tuned until the transport is confirmed —
  encoding work against the wrong transport is discarded work.
- The single-event-shape rule stands regardless of transport: exactly one
  batched frame event on the hot path from the first commit
  ([SRS_streaming.md](../SRS_streaming.md) §1).
- Whatever transport is confirmed must preserve the batching contract: one
  user-visible update is one allocation, one copy across the boundary.
- This record is updated from provisional to final, with the measured numbers,
  as part of the first frame consumer's definition of done.
