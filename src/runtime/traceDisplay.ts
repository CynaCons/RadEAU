/**
 * Trace display projection (SRS_visual_ui.md §5.2): Fixed collapses the
 * chronological ring to one live row per key; Sequential windows the ring
 * tail. Pure helpers — pin set and mode live in the Trace view (session-scoped).
 * Column filters compose BEFORE collapse / window (never an ingest filter).
 */

import type { TraceFrame } from "./frameModel";
import {
  applyFilter,
  EMPTY_FILTER,
  isFilterActive,
  type FilterVisitOpts,
  type TraceFilter,
  windowSequentialFiltered,
} from "./traceFilter";

export type TraceDisplayMode = "fixed" | "sequential";

export const DEFAULT_TRACE_MODE: TraceDisplayMode = "fixed";

/** Sequential history-window choices (rows retained at the tail). */
export const HISTORY_WINDOW_OPTIONS = [10_000, 50_000, 200_000] as const;
export type HistoryWindow = (typeof HISTORY_WINDOW_OPTIONS)[number];
export const DEFAULT_HISTORY_WINDOW: HistoryWindow = 200_000;

/**
 * Stable display key for fixed-mode collapse — the per-row key computed once
 * in projectRow (SRS_visual_ui.md §5.2 fixed-mode keying).
 */
export function fixedDisplayKey(row: TraceFrame): string {
  return row.key;
}

/**
 * Collapses chronological ring rows to one row per key (last write wins),
 * ordered pinned-first then key ascending.
 *
 * Rebuilds from the full buffered ring on every call so a mode switch back
 * into Fixed recovers the latest state without clearing the ring. Clearing
 * would drop cycle-time history for no gain — the ring is already bounded.
 */
export function collapseFixed(
  rows: readonly TraceFrame[],
  pinned: ReadonlySet<string>,
): TraceFrame[] {
  const byKey = new Map<string, TraceFrame>();
  for (const row of rows) {
    byKey.set(fixedDisplayKey(row), row);
  }
  const entries = Array.from(byKey.entries());
  entries.sort((a, b) => {
    const ap = pinned.has(a[0]) ? 0 : 1;
    const bp = pinned.has(b[0]) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  return entries.map(([, row]) => row);
}

/** Sequential display: last `window` rows of the ring (chronological). */
export function windowSequential(
  rows: readonly TraceFrame[],
  window: number,
): readonly TraceFrame[] {
  if (window <= 0 || rows.length <= window) return rows;
  return rows.slice(rows.length - window);
}

/**
 * Projects ring rows into the table data for the active display mode.
 * When a filter is active it runs first: Fixed shows the latest *matching*
 * frame per key; Sequential's history window holds the last N *matching* rows
 * (backward tail scan — no full-ring allocation when the tail fills the window).
 * Optional `opts.onVisit` instruments Sequential filtered scans (perf tests).
 */
export function projectDisplayRows(
  rows: readonly TraceFrame[],
  mode: TraceDisplayMode,
  pinned: ReadonlySet<string>,
  historyWindow: number,
  filter: TraceFilter = EMPTY_FILTER,
  opts?: FilterVisitOpts,
): readonly TraceFrame[] {
  if (!isFilterActive(filter)) {
    if (mode === "fixed") return collapseFixed(rows, pinned);
    return windowSequential(rows, historyWindow);
  }
  if (mode === "fixed") {
    return collapseFixed(applyFilter(rows, filter) as TraceFrame[], pinned);
  }
  return windowSequentialFiltered(rows, historyWindow, filter, opts);
}
