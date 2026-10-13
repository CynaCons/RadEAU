/**
 * Trace Time-column formatting: session-relative (default) vs wall clock
 * anchored at capture:session.sessionEpochMs (CP-009 / SRS_visual_ui §5.2).
 */

export type TraceTimeMode = "session" | "wall";

export const DEFAULT_TRACE_TIME_MODE: TraceTimeMode = "session";

/** Default session-relative format — 4 decimal places, seconds. */
export function formatSessionTime(tS: number): string {
  return tS.toFixed(4);
}

/** Local wall clock HH:MM:SS.mmm from session epoch + relative seconds. */
export function formatWallTime(tS: number, sessionEpochMs: number): string {
  const d = new Date(sessionEpochMs + tS * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

/**
 * Renders the Time cell. Wall mode falls back to session format when the
 * source has no wall-clock anchor (sessionEpochMs is null).
 */
// TR-012: session-relative or epoch-anchored wall-clock trace time.
export function formatTraceTime(
  tS: number,
  mode: TraceTimeMode,
  sessionEpochMs: number | null,
): string {
  if (mode === "wall" && sessionEpochMs != null) {
    return formatWallTime(tS, sessionEpochMs);
  }
  return formatSessionTime(tS);
}

/** Reason the wall-clock radio is disabled; null when enabled. */
export function wallTimeDisabledReason(sessionEpochMs: number | null): string | null {
  return sessionEpochMs == null ? "source has no wall-clock anchor" : null;
}
