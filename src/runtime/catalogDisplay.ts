/**
 * Catalog rail popover display helpers (SRS_visual_ui.md §5.2): source label,
 * counts line, badge tone, last-error copy. Pure — no desktop bridge.
 */

import type { CatalogDiagnostic, CatalogSourceKind } from "./desktop";

export type CatalogBadgeTone = "success" | "warning" | "error" | "hidden";

/** File basename from a path, or the string itself when there is no separator. */
export function catalogFileName(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * Active-source line: file name for file/env sources, or the embedded demo
 * label when sourceKind is embedded.
 */
export function catalogSourceLabel(
  source: string,
  sourceKind: CatalogSourceKind | "",
): string {
  if (sourceKind === "embedded") return "embedded demo catalog";
  const name = catalogFileName(source);
  return name || "catalog";
}

/** "n services · m signals" counts line. */
export function catalogCountsLabel(serviceCount: number, signalCount: number): string {
  const svc = `${serviceCount} service${serviceCount === 1 ? "" : "s"}`;
  const sig = `${signalCount} signal${signalCount === 1 ? "" : "s"}`;
  return `${svc} · ${sig}`;
}

/** "e errors / w warnings" summary above the diagnostics list. */
export function catalogDiagCountLabel(errors: number, warnings: number): string {
  return `${errors} error${errors === 1 ? "" : "s"} / ${warnings} warning${
    warnings === 1 ? "" : "s"
  }`;
}

/**
 * Badge tone on the catalog rail button: success when clean, warning with
 * diagnostics, error when lastError; hidden when unloaded with no failure.
 */
export function catalogBadgeTone(input: {
  loaded: boolean;
  errors: number;
  warnings: number;
  lastError: string | null;
}): CatalogBadgeTone {
  if (input.lastError) return "error";
  if (!input.loaded) return "hidden";
  if (input.errors > 0 || input.warnings > 0) return "warning";
  return "success";
}

/** Popover Alert body when the last import failed (previous catalog stays). */
export function catalogLastErrorMessage(lastError: string): string {
  return `Previous catalog stays active. ${lastError}`;
}

export const CATALOG_NO_DIAGNOSTICS = "no diagnostics";

/** Severity glyph for a diagnostic row (plain text, no color literal). */
export function catalogSeverityGlyph(
  severity: CatalogDiagnostic["severity"],
): string {
  switch (severity) {
    case "error":
      return "✕";
    case "warn":
      return "⚠";
    case "info":
      return "ℹ";
  }
}
