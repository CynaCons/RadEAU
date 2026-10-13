# D5 — IPC transport for frame batches

Status: Accepted · 2026-08-26 (provisional) · confirmed 2026-10-13

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

## Confirmation (2026-10-13, PLAN v0.1.13)

The provisional binary transport is **replaced** by what shipped and was
measured: one `frames:batch` Tauri event per batch carrying **columnar arrays
of primitives as JSON** (SRS_streaming PF-001). Measured on the dev laptop:
the core classifies, batches and serializes 1.05 M frames/s (release,
117 bytes/frame); in the UI at 5,000 frames/s the dominant cost was React
re-rendering (fixed by render discipline: script time 365 → 140 ms/s in the
dev build), not JSON parsing. The owner chose to keep JSON (2026-10-12).
Reopen only if a profile under line-rate load shows `JSON.parse` of batches
as a top cost — then binary columns over a Tauri channel, same batch contract.

