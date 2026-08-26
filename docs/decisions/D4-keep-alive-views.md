# D4 — Keep-alive views

Status: Accepted · 2026-08-26

## Context

The UI shell uses no router: a current-view state selects visibility, views
mount once and hide with `display: none` ([PRD.md](../../PRD.md) §3.6). This
keeps navigation instant and view state (viewports, filters, scroll positions)
alive, but an undisciplined keep-alive view keeps consuming data, memory, and
GPU resources while invisible — exactly the renderer-memory risk D1 exists to
contain.

## Decision

**Keep keep-alive views, with a mandatory suspend/resume contract implemented
by every view from its first commit**: on suspend, release buffers, unsubscribe
from data, and drop graphics contexts; on resume, re-subscribe and rebuild.
Navigation stays two-phase — flip the visible shell immediately, activate
expensive subscriptions only after paint ([PRD.md](../../PRD.md) §3.6).

## Consequences

- Hidden views cost approximately nothing: the consumer registry sees their
  unsubscription and downgrades emission tiers accordingly
  ([SRS_streaming.md](../SRS_streaming.md) §2).
- The contract is structural, not optional — a view without suspend/resume does
  not ship, because retrofitting it after consumers multiply is expensive.
- View-local state survives navigation for free; no rehydration machinery or
  router integration is needed.
- Suspend/resume must be verified under live data as part of acceptance, since
  a leaked subscription is invisible in casual use.
