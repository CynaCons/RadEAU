/**
 * Recorder view honesty copy (SRS_visual_ui.md §5.3) — no fabricated
 * recent-captures list until the recording core lands in v0.6.
 */

export const RECORDER_EMPTY = "no recordings yet";

export const RECORDER_RECORDING_CAPTION = "recording arrives with v0.6";

export const RECORDER_REPLAY_CAPTION =
  "Press Start to replay through the capture path";

/** Label for the Export buffered frames action with a live count. */
export function recorderExportLabel(frameCount: number): string {
  if (frameCount <= 0) return "Export buffered frames";
  return `Export buffered frames · ${frameCount.toLocaleString("en-US")}`;
}
