/**
 * Trace display projection (SRS_visual_ui.md §5.2): Fixed collapses the
 * chronological ring to one live row per key; Sequential windows the ring
 * tail. Pure helpers — pin set and mode live in the Trace view (session-scoped).
 * Column filters compose BEFORE collapse / window (never an ingest filter).
 */

import type { TraceFrame } from "./frameModel";
import type { TraceRows } from "./traceStore";
import {
  applyFilter,
  EMPTY_FILTER,
  isFilterActive,
  matches,
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

function isTraceRows(rows: readonly TraceFrame[] | TraceRows): rows is TraceRows {
  return !Array.isArray(rows);
}

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
  rows: readonly TraceFrame[] | TraceRows,
  pinned: ReadonlySet<string>,
): TraceFrame[] {
  const byKey = new Map<string, TraceFrame>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = isTraceRows(rows) ? rows.get(i) : rows[i];
    if (row === undefined) continue;
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
  rows: readonly TraceFrame[] | TraceRows,
  window: number,
): readonly TraceFrame[] {
  if (!isTraceRows(rows)) {
    return window <= 0 || rows.length <= window
      ? rows
      : rows.slice(rows.length - window);
  }
  const count = window <= 0 ? 0 : Math.min(rows.length, window);
  const out = new Array<TraceFrame>(count);
  for (let i = 0; i < count; i += 1) out[i] = rows.get(rows.length - count + i);
  return out;
}

/**
 * Projects ring rows into the table data for the active display mode.
 * When a filter is active it runs first: Fixed shows the latest *matching*
 * frame per key; Sequential's history window holds the last N *matching* rows
 * (backward tail scan — no full-ring allocation when the tail fills the window).
 * Optional `opts.onVisit` instruments Sequential filtered scans (perf tests).
 */
export function projectDisplayRows(
  rows: readonly TraceFrame[] | TraceRows,
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
    return collapseFixed(applyFilter(rows, filter), pinned);
  }
  return windowSequentialFiltered(rows, historyWindow, filter, opts);
}

/** Index-addressed display rows: what the virtualized table reads. */
export interface DisplayRows {
  readonly length: number;
  get(index: number): TraceFrame;
}

const EMPTY_DISPLAY: DisplayRows = Object.freeze({
  length: 0,
  get(index: number): TraceFrame {
    throw new RangeError(`Trace display index ${index} outside an empty view`);
  },
});

/** Materializes a display view (tests, filter option scans — never the hot path). */
export function displayRowsToArray(rows: DisplayRows): TraceFrame[] {
  const out = new Array<TraceFrame>(rows.length);
  for (let i = 0; i < rows.length; i += 1) out[i] = rows.get(i);
  return out;
}

interface KeyLatest {
  sequence: number;
  row: TraceFrame;
}

/**
 * Incremental live projection (SRS_trace_view TR-014). Per flush it visits
 * only the rows appended since the previous call; Sequential returns an O(1)
 * window view over the ring (or over the matching-sequence list when a
 * filter is active), Fixed keeps the latest row per key and sorts the key set
 * (keys ≪ rows). A filter, epoch (clear) or gap change rebuilds once — O(N).
 * Memory stays bounded by the ring: evicted sequences are compacted away.
 */
export class IncrementalTraceProjection {
  private epoch = -1;
  private endSequence = 0;
  private filter: TraceFilter | null = null;
  private latestByKey = new Map<string, KeyLatest>();
  /** Sequences of matching rows (filter active only), oldest first from `matchingHead`. */
  private matching: number[] = [];
  private matchingHead = 0;

  project(
    rows: TraceRows,
    mode: TraceDisplayMode,
    pinned: ReadonlySet<string>,
    historyWindow: number,
    filter: TraceFilter = EMPTY_FILTER,
  ): DisplayRows {
    const filtered = isFilterActive(filter);
    const rebuild =
      this.epoch !== rows.epoch ||
      this.filter !== filter ||
      this.endSequence < rows.startSequence ||
      this.endSequence > rows.endSequence;
    if (rebuild) {
      this.latestByKey.clear();
      this.matching = [];
      this.matchingHead = 0;
      this.epoch = rows.epoch;
      this.endSequence = rows.startSequence;
      this.filter = filter;
    }

    const base = rows.startSequence;
    for (let sequence = this.endSequence; sequence < rows.endSequence; sequence += 1) {
      const row = rows.get(sequence - base);
      if (filtered && !matches(row, filter)) continue;
      this.latestByKey.set(fixedDisplayKey(row), { sequence, row });
      if (filtered) this.matching.push(sequence);
    }
    this.endSequence = rows.endSequence;
    if (filtered) this.dropEvictedMatches(base);

    if (mode === "sequential") {
      const window = historyWindow <= 0 ? 0 : historyWindow;
      if (!filtered) {
        const count = Math.min(rows.length, window);
        if (count === 0) return EMPTY_DISPLAY;
        const offset = rows.length - count;
        return { length: count, get: (index: number) => rows.get(offset + index) };
      }
      const available = this.matching.length - this.matchingHead;
      const count = Math.min(available, window);
      if (count === 0) return EMPTY_DISPLAY;
      const matching = this.matching;
      const first = matching.length - count;
      return { length: count, get: (index: number) => rows.get((matching[first + index] as number) - base) };
    }

    const entries: Array<[string, TraceFrame]> = [];
    for (const [key, latest] of this.latestByKey) {
      if (latest.sequence < base) this.latestByKey.delete(key);
      else entries.push([key, latest.row]);
    }
    entries.sort((a, b) => {
      const ap = pinned.has(a[0]) ? 0 : 1;
      const bp = pinned.has(b[0]) ? 0 : 1;
      return ap !== bp ? ap - bp : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    if (entries.length === 0) return EMPTY_DISPLAY;
    return { length: entries.length, get: (index: number) => (entries[index] as [string, TraceFrame])[1] };
  }

  /** Advances past evicted sequences and compacts so memory tracks the ring. */
  private dropEvictedMatches(base: number): void {
    const matching = this.matching;
    let head = this.matchingHead;
    while (head < matching.length && (matching[head] as number) < base) head += 1;
    if (head > 4096 && head * 2 > matching.length) {
      this.matching = matching.slice(head);
      head = 0;
    }
    this.matchingHead = head;
  }
}
