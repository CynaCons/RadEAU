# D1 — Renderer memory strategy

Status: Accepted · 2026-08-26

## Context

Renderer (WebView) memory growth is the number-one long-run risk even when every
application buffer is provably bounded ([PRD.md](../../PRD.md) §10). The
streaming pipeline enforces consolidated memory bounds, a renderer
resident-memory watchdog, and CI-gated post-warm-up resident and JS-heap slopes,
with the overnight resident-set slope a release gate from the first release
([SRS_streaming.md](../SRS_streaming.md) §7–8). The alternative considered was
moving hot-path rendering out of the browser environment entirely.

## Decision

Adopt **workers + transferable/shared buffers** as the renderer memory strategy:
keep frame data out of the JS heap where practical, coalesce at the producer so
one user-visible update is one allocation, and push decoding, projection, and
signal processing off the UI main thread. Non-browser hot-path rendering is
**revisited only if the overnight slope gates fail**.

## Consequences

- Hot data lives in typed arrays and shared/transferable buffers, never in
  ordinary JS object graphs; workers own decoding, projection, and signal
  processing before consumers multiply.
- The CI gates in [SRS_streaming.md](../SRS_streaming.md) §8 (resident slope
  ≤ 80 MB/min, JS heap slope ≤ 40 MB/min post-warm-up, overnight slope as a
  release gate) are the standing test of this decision — a sustained failure
  reopens it.
- The renderer resident watchdog (2,048 MB default → notify, then soft reset)
  remains the last-resort backstop, not the plan.
- Off-main-thread structure is mandatory from the first consumer — cheap now,
  expensive to retrofit later ([PRD.md](../../PRD.md) §10).
