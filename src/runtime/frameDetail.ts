/**
 * Pure helpers for Trace row expansion (SRS_visual_ui.md §5.2): hex-dump
 * formatting, honest error copy, and fixed-mode expansion slot capture.
 */

import type { TraceDisplayMode } from "./traceDisplay";
import { fixedDisplayKey } from "./traceDisplay";
import type { TraceFrame } from "./frameModel";

export interface HexDumpRow {
  /** Absolute frame offset as 4-digit uppercase hex. */
  offsetLabel: string;
  /** Space-separated uppercase byte pairs (≤ 16). */
  hex: string;
}

/**
 * Formats `bytes` from `payloadOffset` onward as 16-byte hex-dump rows.
 * Returns `null` when there is no payload (`payloadOffset == wireLen`), so
 * the Payload section can be omitted.
 */
export function formatHexDump(
  bytes: string,
  payloadOffset: number,
  wireLen: number,
): HexDumpRow[] | null {
  if (payloadOffset >= wireLen) return null;
  const start = Math.max(0, payloadOffset) * 2;
  const end = Math.max(start, wireLen * 2);
  const payloadHex = bytes.slice(start, end).toUpperCase();
  const totalBytes = Math.floor(payloadHex.length / 2);
  if (totalBytes <= 0) return null;

  const rows: HexDumpRow[] = [];
  for (let i = 0; i < totalBytes; i += 16) {
    const chunk = payloadHex.slice(i * 2, (i + 16) * 2);
    const pairs: string[] = [];
    for (let j = 0; j < chunk.length; j += 2) {
      pairs.push(chunk.slice(j, j + 2));
    }
    const offset = payloadOffset + i;
    rows.push({
      offsetLabel: offset.toString(16).toUpperCase().padStart(4, "0"),
      hex: pairs.join(" "),
    });
  }
  return rows;
}

/** Field-row hint: `offset:len`, right-aligned tertiary mono in the panel. */
export function formatFieldExtent(offset: number, len: number): string {
  return `${offset}:${len}`;
}

/**
 * Formats a catalog-scaled physical value for the decoded table: enough
 * precision for extract factors (0.01 / 0.001 / 0.1), trailing zeros trimmed.
 */
export function formatScaled(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Object.is(value, -0)) return "0";
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(6);
  return fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** Malformed layers carry a summary that starts with this prefix (core contract). */
export function isMalformedLayerSummary(summary: string): boolean {
  return summary.startsWith("malformed: ");
}

/**
 * Maps a `fetchFrameDetail` rejection to the exact empty-state sentence shown
 * in the expansion panel. Unknown errors pass through honestly.
 */
export function frameDetailErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw === "desktop app only" || /\bdesktop app only\b/i.test(raw)) {
    return "frame dissection is desktop-only";
  }
  if (raw.includes("frame no longer buffered")) return "frame no longer buffered";
  if (raw.includes("unknown frame")) return "unknown frame";
  return raw;
}

/**
 * Expansion identity for a trace row. `idx` is captured at click time and
 * never auto-refetched as a Fixed-mode row rewrites in place.
 */
export interface TraceExpansion {
  /** Stable slot: fixedDisplayKey in Fixed, frame id string in Sequential. */
  slotKey: string;
  /** Frame index fetched for dissection. */
  idx: number;
  /** Fixed mode: show `#idx` on the first layer header. */
  showCapturedIdx: boolean;
}

export function captureTraceExpansion(
  mode: TraceDisplayMode,
  frame: TraceFrame,
): TraceExpansion {
  return {
    slotKey: mode === "fixed" ? fixedDisplayKey(frame) : String(frame.id),
    idx: frame.id,
    showCapturedIdx: mode === "fixed",
  };
}

export function rowMatchesExpansion(
  mode: TraceDisplayMode,
  frame: TraceFrame,
  expansion: TraceExpansion,
): boolean {
  const key = mode === "fixed" ? fixedDisplayKey(frame) : String(frame.id);
  return key === expansion.slotKey;
}
