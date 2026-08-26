# D7 — Service catalog format

Status: Accepted · 2026-08-26

## Context

The service catalog defines services, methods, events, eventgroups, cycle-time
expectations, and payload layouts with scaling and units — it drives naming,
decode, and the dual-decoder contract
([SRS_protocols.md](../SRS_protocols.md) §4–5). Industry exchange formats
(ARXML, FIBEX) exist but are large, complex to parse correctly, and would put a
third-party schema on the critical path of v1.

## Decision

**Native versioned YAML first**: a catalog schema owned by RadEAU, parsed once
at load into precomputed lookups with an atomic catalog version counter.
**ARXML/FIBEX import is a backlog importer that targets the same in-memory
model** ([SRS_protocols.md](../SRS_protocols.md) §4,
[PRD.md](../../PRD.md) §1.3) — import is a translation, never a second catalog
path.

## Consequences

- v1 ships with a format that is hand-writable, diffable, and exactly as
  expressive as the decoder needs — including the simulator's checked-in
  scenario catalogs.
- The versioned schema admits later extensions (dynamic arrays, strings, TLV)
  without breaking existing catalogs.
- Importers reduce to converters into one in-memory model; decode, caches, and
  the catalog version mechanism never learn about ARXML or FIBEX.
- Users with existing ARXML/FIBEX assets must wait for the importer or
  hand-translate — an accepted v1 cost ([PRD.md](../../PRD.md) §1.3).
