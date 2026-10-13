# SRS — Trace View

The Trace view's behaviour as testable requirements. Visual composition
(rail, columns, widths, faces, chips, colors) is specified in
[SRS_visual_ui.md §5.2](SRS_visual_ui.md); per-class Name / Type / key tables
in [SRS_protocols.md §7](SRS_protocols.md); the streaming path that feeds the
view in [SRS_streaming.md](SRS_streaming.md). This document owns the `TR-`
prefix ([REQUIREMENT_IDS.md](REQUIREMENT_IDS.md)).

## 1. Model

The view projects a bounded UI ring of rows (one row per frame, fed by
`frames:batch`) through three stages, in this order: **filter** (per-column
selections) → **mode** (Fixed: latest matching row per key; Sequential: last N
matching rows) → **display** (virtualized table, only visible rows rendered).
Ingest never filters. Every stage is incremental: work per flush is
proportional to the rows that arrived, not to the ring size; only a change of
filter, mode or history window may re-project the whole ring once.

## 2. Requirements

| ID | Requirement | Priority | Status | Acceptance criteria |
|---|---|---|---|---|
| TR-001 | The UI ring holds at most 200,000 rows and evicts oldest first; ingest is batched (one `frames:batch` event per backend batch) and published on an adaptive flush — 50 ms when the last batch held ≥ 64 frames, else 100 ms | Must | Implemented | Unit: ring of cap N after N+k rows holds the last N in order; flush delay follows the last batch size |
| TR-002 | Exactly one backpressure credit is returned to the core per animation frame while capturing; no credit while stopped | Must | Implemented | E2E: frames flow under the stress profile; ack loop present only while capturing |
| TR-003 | Fixed mode (the default) shows one row per key — the latest matching frame — pinned keys first, then key ascending; rows rewrite in place | Must | Implemented | Unit: collapse over a random sequence equals the latest-per-key reference; pinned keys sort first |
| TR-004 | Sequential mode shows the last N matching rows (history window 10,000 / 50,000 / 200,000) in arrival order and auto-follows the tail while scrolled to the bottom | Must | Implemented | Unit: window holds the last N matching rows; E2E: mode switch Fixed → Sequential keeps rows flowing |
| TR-005 | Fixed-mode keys follow SRS_visual_ui §5.2 and SRS_protocols §7 per class (service/method; protocol + source; flows; DoIP request and response share a key) — no class is hidden behind another's key | Must | Implemented | Unit: key table per class; E2E: every class of the simulator mix has its own Fixed row |
| TR-006 | Δ global is the time since the previous row; Δ per key the time since the previous row of the same key | Must | Implemented | Unit: projectRow deltas over a hand-built sequence |
| TR-007 | Column filters (Service:Method, Name, Protocol, Direction) project over the untouched ring before the mode stage, apply on Apply, clear when everything is selected, key Service/Name selections by (service, method) ids, and never filter ingest | Must | Implemented | Unit: filtered Fixed shows the latest matching frame per key; E2E: Protocol/Direction/Name filters narrow the table and clear |
| TR-008 | While a filter is active a `Filtered · shown / total` chip shows and the empty state reads "No rows match the active filters" when the ring is not empty | Must | Implemented | E2E: chip and empty-state text under a filter matching nothing |
| TR-009 | Pause stops display updates and stages up to 20,000 incoming rows (oldest dropped beyond) with a `Paused · n buffered` chip counting raw ingest; resume merges the staged rows in order | Must | Implemented | Unit: pause/resume staging order and cap; E2E: paused table does not grow |
| TR-010 | Clear empties the UI ring, the staged rows and the per-key delta state | Must | Implemented | Unit: clear resets rows, staging and Δ per key |
| TR-011 | Any row expands to the protocol-layer dissection fetched on demand from the core (`frame_detail`), never from the streaming batch; an evicted frame reads "frame no longer buffered" | Must | Implemented | E2E: dissection spot checks per class (DoIP, ICMPv6 RA, DNS, TLS SNI, LLDP) |
| TR-012 | Time renders as session-relative seconds (4 decimals) or wall-clock when the session epoch is known; wall-clock is disabled with a stated reason otherwise | Must | Implemented | Unit: formatTraceTime both modes; disabled reason without an epoch |
| TR-013 | Export writes the core's buffered frames as a pcap (default name `radeau-<session start>.pcap`) and is disabled with the reason "no frames buffered" when the core ring is empty | Must | Implemented | Unit: ring export path; E2E: export produces a readable pcap |
| TR-014 | Work per flush is proportional to the arrived batch: no flush rebuilds an array or projection over the whole ring; only a filter, mode or history-window change re-projects once | Must | Planned | Unit: ingest of k rows into a full ring touches O(k) rows (instrumented); perf: trace-fixed script time within budget (perf/budgets.json) |
| TR-015 | A flush re-renders only the table subtree; toolbar, chips and popovers re-render only when the values they display change; an unchanged row does not re-render | Must | Planned | Render-count unit test; perf: trace row renders and view-trace commits within budget |
| TR-016 | While the Trace view is hidden it performs zero React commits; the ring keeps ingesting and the view shows the current state in one render on return | Must | Planned | Perf: network/recorder/settings-visible scenarios report view-trace commits ≤ 1/s; E2E: rows present after returning to Trace |
| TR-017 | Appending rows repaints only the table body: the table region is layout- and paint-contained and data-driven elements carry no transitions (VU-019) | Should | Planned | Perf: trace-sequential layout and paint within budget |
