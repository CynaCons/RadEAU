# D2 — No-decimation ceiling vs. hybrid envelope

Status: Accepted · 2026-08-26

## Context

The core rendering principle is *never decimate*: no LTTB, bucketing, envelope
reduction, stride sampling, or LOD pyramids anywhere in the rendering path;
degradation is in frame rate, never fidelity ([PRD.md](../../PRD.md) §1.1,
GR-001 in [SRS_graphing.md](../SRS_graphing.md) §10). That principle has a
practical ceiling for very long histories, and the question was whether v1 needs
a hybrid raw-plus-envelope scheme to raise it.

## Decision

**Keep raw-only rendering in v1, within the documented caps** — signal rings at
`min(user depth, 200,000, 1,000,000 absolute)` points and 50,000,000 floats of
GPU geometry per series ([SRS_streaming.md](../SRS_streaming.md) §7,
[SRS_graphing.md](../SRS_graphing.md) §2). A hybrid envelope for beyond-cap
histories is **reserved as a versioned extension**, not built now.

## Consequences

- Every in-window sample is drawn; a single-sample spike renders at full
  amplitude at every zoom level (GR-001 acceptance stands unchanged).
- History depth is honestly bounded and documented; users see caps, not silent
  fidelity loss.
- Formats and schemas stay versioned so a hybrid tier can be added later without
  breaking recordings or the engine handle.
- The backlog hybrid item activates only if raw-only caps prove limiting in real
  use — evidence first, mechanism second.
