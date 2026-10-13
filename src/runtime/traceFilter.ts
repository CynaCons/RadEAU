/**
 * Trace column-filter projection (SRS_visual_ui.md §5.2): predicates over the
 * untouched ring, composed before Fixed collapse / Sequential windowing.
 * Session-scoped state lives in the Trace view.
 */

import type { TraceFrame } from "./frameModel";
import type { TraceRows } from "./traceStore";
import {
  PROTO_AVTP,
  PROTO_DHCP,
  PROTO_DNS,
  PROTO_DOIP,
  PROTO_EAPOL,
  PROTO_HTTP,
  PROTO_ICMPV6,
  PROTO_IGMP,
  PROTO_LLDP,
  PROTO_MACSEC,
  PROTO_NTP,
  PROTO_PTP,
  PROTO_SCTP,
  PROTO_SNMP,
  PROTO_SSDP,
  PROTO_SSH,
  PROTO_TFTP,
  PROTO_TLS,
  protoLabel,
} from "./wireCodes";

export type TraceFilterDir = "rx" | "tx" | "unknown";

export type TraceFilterColumn = "service" | "name" | "protocol" | "dir";

/**
 * Per-column criteria. `null` = column unfiltered. An empty Set is an active
 * filter that matches nothing (allowed — yields the filtered empty state).
 * Service keys are `${sv}:${m}` id pairs; Name keys are `${sv}:${m}` for
 * MOST classes, `doip:${ty}` for DoIP, and `${p}:${ty}` (plus `:${se}` for
 * DNS/HTTP/TLS) for the §7 standard-protocol classes; Protocol keys are
 * PROTO_* integers; Direction keys are the row `dir` strings.
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

function isTraceRows(rows: readonly TraceFrame[] | TraceRows): rows is TraceRows {
  return !Array.isArray(rows);
}

export interface TraceFilterOption {
  key: string;
  label: string;
  count: number;
}

/** Stable (service, method) id pair used by Service selections. */
export function serviceMethodId(row: TraceFrame): string {
  return `${row.sv}:${row.m}`;
}

/** Classes keyed by message kind for the Name filter (§7). */
function isStandardProtoNameKey(proto: number): boolean {
  switch (proto) {
    case PROTO_ICMPV6:
    case PROTO_IGMP:
    case PROTO_DHCP:
    case PROTO_DNS:
    case PROTO_NTP:
    case PROTO_SSDP:
    case PROTO_PTP:
    case PROTO_LLDP:
    case PROTO_AVTP:
    case PROTO_MACSEC:
    case PROTO_EAPOL:
    case PROTO_HTTP:
    case PROTO_TLS:
    case PROTO_SSH:
    case PROTO_SCTP:
    case PROTO_TFTP:
    case PROTO_SNMP:
      return true;
    default:
      return false;
  }
}

/**
 * Name-filter key: DoIP collapses by payload type (`doip:${ty}`); §7 classes
 * use `${p}:${ty}` (plus `:${se}` for DNS/HTTP/TLS so "DNS query · A" /
 * "TLS ClientHello" appear once each); other classes keep `${sv}:${m}`.
 */
export function nameFilterId(row: TraceFrame): string {
  if (row.proto === PROTO_DOIP) return `doip:${row.ty}`;
  if (isStandardProtoNameKey(row.proto)) {
    if (
      row.proto === PROTO_DNS ||
      row.proto === PROTO_HTTP ||
      row.proto === PROTO_TLS
    ) {
      return `${row.proto}:${row.ty}:${row.se}`;
    }
    return `${row.proto}:${row.ty}`;
  }
  return serviceMethodId(row);
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
  if (f.names !== null && !f.names.has(nameFilterId(row))) return false;
  if (f.protocols !== null && !f.protocols.has(row.proto)) return false;
  if (f.dirs !== null && !f.dirs.has(row.dir)) return false;
  return true;
}

/**
 * Filters the ring. Zero-cost fast path when nothing is active: returns the
 * same array reference.
 */
export function applyFilter(rows: readonly TraceFrame[], f: TraceFilter): readonly TraceFrame[];
export function applyFilter(rows: TraceRows, f: TraceFilter): readonly TraceFrame[] | TraceRows;
export function applyFilter(
  rows: readonly TraceFrame[] | TraceRows,
  f: TraceFilter,
): readonly TraceFrame[] | TraceRows;
export function applyFilter(
  rows: readonly TraceFrame[] | TraceRows,
  f: TraceFilter,
): readonly TraceFrame[] | TraceRows {
  if (!isFilterActive(f)) return rows;
  const out: TraceFrame[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = isTraceRows(rows) ? rows.get(i) : rows[i];
    if (matches(row, f)) out.push(row);
  }
  return out;
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
 * filter stores (Name shows display names but keys by `${sv}:${m}`,
 * `doip:${ty}`, or `${p}:${ty}` / `${p}:${ty}:${se}` for §7 classes).
 */
export function distinctValues(
  rows: readonly TraceFrame[] | TraceRows,
  column: TraceFilterColumn,
): TraceFilterOption[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = isTraceRows(rows) ? rows.get(i) : rows[i];
    let key: string;
    let label: string;
    switch (column) {
      case "service":
        key = serviceMethodId(row);
        label = row.serviceMethod;
        break;
      case "name":
        key = nameFilterId(row);
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

export interface FilterVisitOpts {
  /** Called once per row visited during a Sequential filtered scan. */
  onVisit?: (row: TraceFrame) => void;
}

/**
 * Sequential history window over matching rows only: scan the ring tail
 * backward, collect up to `window` matches, reverse. Avoids allocating a
 * full-ring filtered copy when the tail already fills the window.
 * Visits at most `window + (non-matching rows in the scanned tail)`.
 */
export function windowSequentialFiltered(
  rows: readonly TraceFrame[] | TraceRows,
  window: number,
  f: TraceFilter,
  opts?: FilterVisitOpts,
): TraceFrame[] {
  if (window <= 0) return [];
  const out: TraceFrame[] = [];
  const onVisit = opts?.onVisit;
  for (let i = rows.length - 1; i >= 0 && out.length < window; i -= 1) {
    const row = Array.isArray(rows) ? rows[i] : (rows as TraceRows).get(i);
    onVisit?.(row);
    if (matches(row, f)) out.push(row);
  }
  out.reverse();
  return out;
}
