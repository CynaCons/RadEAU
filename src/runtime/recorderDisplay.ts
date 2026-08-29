/**
 * Recorder view helpers (SRS_visual_ui.md §5.3 / SRS_capture §7) — arm
 * indicator colors, directory caption, list row model, active-stats line.
 */

import type { RecordingInfo, RecordingState } from "./desktop";

export const RECORDER_EMPTY = "no recordings yet";

/** 12 px caption under the recordings directory field. */
export const RECORDER_DIR_CAPTION =
  "Default: Documents / RadEAU / recordings";

export const RECORDER_REPLAY_CAPTION =
  "Press Start to replay through the capture path";

/** Label for the Export buffered frames action with a live count. */
export function recorderExportLabel(frameCount: number): string {
  if (frameCount <= 0) return "Export buffered frames";
  return `Export buffered frames · ${frameCount.toLocaleString("en-US")}`;
}

/**
 * App-bar / Record indicator color token (VU §4.3 row 6–7):
 * `error` only while bytes are being written (`active && frames > 0`),
 * `warning` while armed, else idle secondary.
 */
export function recordIndicatorColor(state: {
  armed: boolean;
  active: boolean;
  frames: number;
}): string {
  if (state.active && state.frames > 0) return "var(--error)";
  if (state.armed) return "var(--warning)";
  return "var(--text-secondary)";
}

/** Tooltip for the app-bar record indicator. */
export function recordIndicatorTooltip(state: {
  armed: boolean;
  active: boolean;
  path: string | null;
}): string {
  if (state.active && state.path) return `Recording · ${state.path}`;
  if (state.armed) return "Recording armed — starts with the next session";
  return "Recording idle";
}

/** Basename of a path (handles `/` and `\`). */
export function recordingBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/** Compact byte count for list rows and live stats. */
export function formatRecordingBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString("en-US")} B`;
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024).toLocaleString("en-US")} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb.toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`;
}

/** Live counters line while a recording file is open. */
export function formatActiveRecordingStats(state: {
  frames: number;
  bytes: number;
  dropped: number;
}): string {
  return [
    `${state.frames.toLocaleString("en-US")} frames`,
    formatRecordingBytes(state.bytes),
    `${state.dropped.toLocaleString("en-US")} dropped`,
  ].join(" · ");
}

export interface RecordingListRow {
  path: string;
  basename: string;
  bytesLabel: string;
  framesLabel: string | null;
  bytes: number;
  frames: number | null;
  startedMs: number;
}

/** Newest-first list model from `recording_list`. */
export function recordingListModel(
  items: readonly RecordingInfo[],
): RecordingListRow[] {
  return items.map((item) => ({
    path: item.path,
    basename: recordingBasename(item.path),
    bytesLabel: formatRecordingBytes(item.bytes),
    framesLabel:
      item.frames === null || item.frames === undefined
        ? null
        : `${item.frames.toLocaleString("en-US")} frames`,
    bytes: item.bytes,
    frames: item.frames,
    startedMs: item.startedMs,
  }));
}

/** Trace chip label while recording is active. */
export function recordingChipLabel(frames: number): string {
  return `Recording · ${frames.toLocaleString("en-US")} frames`;
}

/** True when the Record panel should show the 3 px error left rule. */
export function recordingPanelActive(state: Pick<RecordingState, "active">): boolean {
  return state.active;
}
