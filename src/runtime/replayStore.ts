/**
 * Replay transport store (CP-020..022 / VU-028): owns the opened replay file
 * metadata and latest replay:position event for the shell time bar.
 */

import {
  onReplayPosition,
  onReplaySeek,
  replayOpen,
  replayPause,
  replayPlay,
  replaySeek,
  replaySetSpeed,
  replayStep,
  type ReplayInfo,
  type ReplayPosition,
  type ReplaySpeed,
} from "./desktop";
import { sessionStore } from "./sessionStore";
import { traceStore } from "./traceStore";

export interface ReplaySnapshot {
  readonly info: ReplayInfo | null;
  readonly position: ReplayPosition | null;
  readonly opening: boolean;
  readonly error: string | null;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

export class ReplayStore {
  private info: ReplayInfo | null = null;
  private position: ReplayPosition | null = null;
  private opening = false;
  private error: string | null = null;
  private listeners = new Set<() => void>();
  private snapshot: ReplaySnapshot;

  constructor() {
    this.snapshot = this.buildSnapshot();
    onReplayPosition((position) => {
      this.position = position;
      this.error = null;
      this.publish();
    });
    onReplaySeek(() => {
      traceStore.clear();
    });
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): ReplaySnapshot => this.snapshot;

  /** CP-020: prepare/open a pcap replay and configure it as the session source. */
  async open(path: string): Promise<ReplayInfo> {
    this.opening = true;
    this.error = null;
    this.publish();
    try {
      const info = await replayOpen(path);
      this.info = info;
      this.position = {
        state: "paused",
        tNs: 0,
        frame: 0,
        frames: info.frames,
        durationNs: info.durationNs,
        speed: 1,
      };
      // A replay opens at 1x; the time bar changes the speed (CP-021).
      sessionStore.setPcapSource(path, "realtime");
      this.publish();
      return info;
    } catch (err) {
      this.error = errMessage(err);
      this.publish();
      throw err;
    } finally {
      this.opening = false;
      this.publish();
    }
  }

  /** Play: starts the replay session when none runs (it starts playing), else resumes. */
  play(): Promise<void> {
    if (!sessionStore.getSnapshot().running) return this.run(() => sessionStore.start());
    return this.run(replayPlay);
  }

  pause(): Promise<void> {
    return this.run(replayPause);
  }

  step(): Promise<void> {
    return this.run(replayStep);
  }

  seek(tNs: number): Promise<void> {
    return this.run(() => replaySeek(tNs));
  }

  setSpeed(speed: ReplaySpeed): Promise<void> {
    return this.run(() => replaySetSpeed(speed));
  }

  /** Transport commands never reject to the caller: failures surface as `error`. */
  private async run(command: () => Promise<void>): Promise<void> {
    try {
      await command();
    } catch (err) {
      this.error = errMessage(err);
      this.publish();
    }
  }

  private buildSnapshot(): ReplaySnapshot {
    return {
      info: this.info,
      position: this.position,
      opening: this.opening,
      error: this.error,
    };
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const cb of this.listeners) cb();
  }
}

/** Application-wide replay singleton. */
export const replayStore = new ReplayStore();

if (import.meta.env.DEV) {
  // E2E/perf harness handle (the Recorder's Browse opens a native dialog).
  (globalThis as { __radeauReplay?: ReplayStore }).__radeauReplay = replayStore;
}
