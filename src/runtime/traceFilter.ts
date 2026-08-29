/**
 * Trace column-filter projection (SRS_visual_ui.md §5.2): predicates over the
 * untouched ring, composed before Fixed collapse / Sequential windowing.
 * Session-scoped state lives in the Trace view.
 */

import type { TraceFrame } from "./frameModel";
import { protoLabel } from "./wireCodes";

export type TraceFilterDir = "rx" | "tx" | "unknown";

export type TraceFilterColumn = "service" | "name" | "protocol" | "dir";

/**
 * Per-column criteria. `null` = column unfiltered. An empty Set is an active
 * filter that matches nothing (allowed — yields the filtered empty state).
 * Service and Name keys are `${sv}:${m}` id pairs; Protocol keys are PROTO_*
 * integers; Direction keys are the row `dir` strings.
 */
export interface TraceFilter {
  services: ReadonlySet<string> | null;
  names: ReadonlySet<string> | null;
  protocols: ReadonlySet<number> | null;
  dirs: ReadonlySet<TraceFilterDir> | null;
}

export const EMPTY_FILTER: TraceFilter = Object.freeze({
  services: null,
  names: null,
  protocols: null,
  dirs: null,
});

export interface TraceFilterOption {
  key: string;
  label: string;
  count: number;
}

/** Stable (service, method) id pair used by Service and Name selections. */
export function serviceMethodId(row: TraceFrame): string {
  return `${row.sv}:${row.m}`;
}

export function isFilterActive(f: TraceFilter): boolean {
  return (
    f.services !== null ||
    f.names !== null ||
    f.protocols !== null ||
    f.dirs !== null
  );
}

export function isColumnFilterActive(
  f: TraceFilter,
  column: TraceFilterColumn,
): boolean {
  switch (column) {
    case "service":
      return f.services !== null;
    case "name":
      return f.names !== null;
    case "protocol":
      return f.protocols !== null;
    case "dir":
      return f.dirs !== null;
  }
}

/** Integer / Set membership — no string compares on the hot path. */
export function matches(row: TraceFrame, f: TraceFilter): boolean {
  if (f.services !== null && !f.services.has(serviceMethodId(row))) return false;
  if (f.names !== null && !f.names.has(serviceMethodId(row))) return false;
  if (f.protocols !== null && !f.protocols.has(row.proto)) return false;
  if (f.dirs !== null && !f.dirs.has(row.dir)) return false;
  return true;
}

/**
 * Filters the ring. Zero-cost fast path when nothing is active: returns the
 * same array reference.
 */
export function applyFilter(
  rows: readonly TraceFrame[],
  f: TraceFilter,
): readonly TraceFrame[] {
  if (!isFilterActive(f)) return rows;
  return rows.filter((row) => matches(row, f));
}

const DIR_LABEL: Record<TraceFilterDir, string> = {
  rx: "Rx",
  tx: "Tx",
  unknown: "—",
};

const DIR_ORDER: readonly TraceFilterDir[] = ["rx", "tx", "unknown"];

/**
 * Distinct values present in `rows` for one filter column — one pass, with
 * occurrence counts. Labels are display strings; keys are the stable ids the
 * filter stores (Name shows display names but keys by `${sv}:${m}`).
 */
export function distinctValues(
  rows: readonly TraceFrame[],
  column: TraceFilterColumn,
): TraceFilterOption[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const row of rows) {
    let key: string;
    let label: string;
    switch (column) {
      case "service":
        key = serviceMethodId(row);
        label = row.serviceMethod;
        break;
      case "name":
        key = serviceMethodId(row);
        label = row.name;
        break;
      case "protocol":
        key = String(row.proto);
        label = protoLabel(row.proto);
        break;
      case "dir":
        key = row.dir;
        label = DIR_LABEL[row.dir];
        break;
    }
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      // Prefer a non-empty / more specific label if the first row was sparse.
      if (label && !existing.label) existing.label = label;
    } else {
      counts.set(key, { label, count: 1 });
    }
  }

  const options: TraceFilterOption[] = Array.from(counts.entries()).map(
    ([key, v]) => ({ key, label: v.label, count: v.count }),
  );

  if (column === "protocol") {
    options.sort((a, b) => Number(a.key) - Number(b.key));
  } else if (column === "dir") {
    options.sort(
      (a, b) =>
        DIR_ORDER.indexOf(a.key as TraceFilterDir) -
        DIR_ORDER.indexOf(b.key as TraceFilterDir),
    );
  } else {
    options.sort((a, b) =>
      a.label < b.label ? -1 : a.label > b.label ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
  }
  return options;
}

/**
 * Sequential history window over matching rows only: scan the ring tail
 * backward, collect up to `window` matches, reverse. Avoids allocating a
 * full-ring filtered copy when the tail already fills the window.
 */
export function windowSequentialFiltered(
  rows: readonly TraceFrame[],
  window: number,
  f: TraceFilter,
): TraceFrame[] {
  if (window <= 0) return [];
  const out: TraceFrame[] = [];
  for (let i = rows.length - 1; i >= 0 && out.length < window; i -= 1) {
    const row = rows[i];
    if (matches(row, f)) out.push(row);
  }
  out.reverse();
  return out;
}
