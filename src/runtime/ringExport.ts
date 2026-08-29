/**
 * Buffered-frame export helpers (CP-006 / SRS_capture §3): default save name,
 * result summary copy, and the shared Trace rail / Recorder action.
 */

import {
  exportRing,
  onCaptureExport,
  pickSavePath,
  type ExportRingResult,
} from "./desktop";

/** `radeau-<yyyyMMdd-HHmmss>.pcap` in local time. */
export function defaultExportPcapName(now: Date = new Date()): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `radeau-${y}${mo}${d}-${h}${mi}${s}.pcap`;
}

/** Success chip / toast copy: "Exported n frames · x KB". */
export function formatExportSummary(result: ExportRingResult): string {
  const kb = Math.round(result.bytes / 1024);
  return `Exported ${result.frames.toLocaleString("en-US")} frames · ${kb.toLocaleString("en-US")} KB`;
}

export function exportErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

export interface ExportRingOutcome {
  ok: boolean;
  message: string;
  result?: ExportRingResult;
  path?: string;
}

/**
 * Pick a save path and write the frame ring. Cancel (null path) returns
 * `{ ok: false, message: "export cancelled" }` without invoking the core.
 */
export async function runExportRing(
  onProgress?: (p: { done: number; total: number }) => void,
): Promise<ExportRingOutcome> {
  let path: string | null;
  try {
    path = await pickSavePath(defaultExportPcapName());
  } catch (err) {
    return { ok: false, message: exportErrorMessage(err) };
  }
  if (!path) {
    return { ok: false, message: "export cancelled" };
  }
  const unsub = onProgress
    ? onCaptureExport((p) => {
        onProgress(p);
      })
    : () => {};
  try {
    const result = await exportRing(path);
    return { ok: true, message: formatExportSummary(result), result, path };
  } catch (err) {
    return { ok: false, message: exportErrorMessage(err) };
  } finally {
    unsub();
  }
}
