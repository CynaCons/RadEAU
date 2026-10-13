# Requirement-ID registry

The **single allocator** for requirement, plan, and test numbering
(PRD §9.2/§9.4). Every prefix is owned by exactly one SRS document; an ID is
defined (appears as a requirements-table row) in its owning document only, and
is never reused or renumbered — superseded requirements are marked, not
deleted. `scripts/check-req-ids.mjs` fails CI on duplicate definitions.

## Prefixes

| Prefix | Area | Owning document | Allocated | Next free |
|---|---|---|---|---|
| VU- | Visual and UI | SRS_visual_ui.md | 001–027 | 028 |
| GR- | Graphing / engines | SRS_graphing.md | 001–008 | 009 |
| ZM- | Zoom / interaction | SRS_graphing.md | 001–003 | 004 |
| AS- | Autoscale | SRS_graphing.md | 001–004 | 005 |
| LM- | Live mode / render loop | SRS_graphing.md | 001–004 | 005 |
| MG- | Multi-pane graphing | SRS_graphing.md | 001–004 | 005 |
| FF- | FFT view | SRS_graphing.md | 001–005 | 006 |
| PF- | Streaming / performance | SRS_streaming.md | 001–005 | 006 |
| SP- | SOME/IP protocol + decode | SRS_ecu_netsim.md (elaborated in SRS_protocols.md) | 001–018 | 019 |
| SD- | Service discovery | SRS_ecu_netsim.md | 001–005 | 006 |
| PT- | PTP / time sync | SRS_ecu_netsim.md | 001–004 | 005 |
| NS- | Network simulator | SRS_ecu_netsim.md | 001–006 | 007 |
| NV- | Network view | SRS_ecu_netsim.md | 001–003 | 004 |
| TR- | Trace view | SRS_trace_view.md | 001–017 | 018 |
| CP- | Capture sources and backends | SRS_capture.md | 001–016 | 017 |

## E2E test numbers

E2E scripts are numbered `NN-e2e-topic` (PRD §9.3). Allocated: none yet.
Next free: `01`.
