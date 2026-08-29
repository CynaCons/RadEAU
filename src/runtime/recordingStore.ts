/**
 * Continuous pcap recording store (SRS_capture §7 / CP-014..016): mirrors
 * `recording_state` + `recording:state`, exposes arm / setDir / refreshList.
 * Views subscribe via useSyncExternalStore.
 */

import {
  onRecordingState,
  recordingArm,
  recordingDirSet,
  recordingList,
  recordingState,
  type RecordingInfo,
  type RecordingState,
} from "./desktop";

export interface RecordingSnapshot {
  readonly ready: boolean;
  readonly armed: boolean;
  readonly active: boolean;
  readonly path: string | null;
  readonly frames: number;
  readonly bytes: number;
  readonly dropped: number;
  readonly error: string | null;
  readonly dir: string;
  readonly startedMs: number | null;
  readonly list: readonly RecordingInfo[];
  /** Last `recording_dir_set` rejection (cleared on the next successful set). */
  readonly dirError: string | null;
}

function idleState(): RecordingState {
  return {
    armed: false,
    active: false,
    path: null,
    frames: 0,
    bytes: 0,
    dropped: 0,
    error: null,
    dir: "browser",
    startedMs: null,
  };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

export class RecordingStore {
  private ready = false;
  private state: RecordingState = idleState();
  private list: RecordingInfo[] = [];
  private dirError: string | null = null;
  private listeners = new Set<() => void>();
  private snapshot: RecordingSnapshot;

  constructor() {
    this.snapshot = this.buildSnapshot();
    onRecordingState((next) => {
      this.applyState(next);
      // Refresh the file list when a recording closes (active → idle).
      if (!next.active) void this.refreshList();
    });
    void this.bootstrap();
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): RecordingSnapshot => this.snapshot;

  /** Arms or disarms continuous recording (intent while stopped). */
  async arm(armed: boolean): Promise<void> {
    try {
      const next = await recordingArm(armed);
      this.applyState(next);
      if (!next.active) void this.refreshList();
    } catch (err) {
      // Surface as recording error so the Record panel can show an alert.
      this.state = { ...this.state, error: errMessage(err), armed: false };
      this.publish();
    }
  }

  /** Sets the recordings directory; rejects while a file is active. */
  async setDir(path: string): Promise<boolean> {
    const trimmed = path.trim();
    if (!trimmed) {
      this.dirError = "directory path is empty";
      this.publish();
      return false;
    }
    try {
      const dir = await recordingDirSet(trimmed);
      this.state = { ...this.state, dir };
      this.dirError = null;
      this.publish();
      return true;
    } catch (err) {
      this.dirError = errMessage(err);
      this.publish();
      return false;
    }
  }

  /** Reloads `recording_list` (newest first). */
  async refreshList(): Promise<void> {
    try {
      this.list = await recordingList();
      this.publish();
    } catch {
      // Keep the previous list; list failures are non-fatal for the panel.
    }
  }

  private async bootstrap(): Promise<void> {
    try {
      const [state, list] = await Promise.all([recordingState(), recordingList()]);
      this.state = state;
      this.list = list;
    } catch {
      // Browser / early-boot: keep idle defaults.
    }
    this.ready = true;
    this.publish();
  }

  private applyState(next: RecordingState): void {
    this.state = next;
    this.ready = true;
    // A write failure from the core disarms; clear a stale dirError only
    // when the core reports a recording error of its own.
    if (next.error) this.dirError = null;
    this.publish();
  }

  private buildSnapshot(): RecordingSnapshot {
    return {
      ready: this.ready,
      armed: this.state.armed,
      active: this.state.active,
      path: this.state.path,
      frames: this.state.frames,
      bytes: this.state.bytes,
      dropped: this.state.dropped,
      error: this.state.error,
      dir: this.state.dir,
      startedMs: this.state.startedMs,
      list: this.list,
      dirError: this.dirError,
    };
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const cb of this.listeners) cb();
  }
}

/** Application-wide recording singleton. */
export const recordingStore = new RecordingStore();
