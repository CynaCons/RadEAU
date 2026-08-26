/**
 * The one thin wrapper around every desktop-API call (PRD §3.6). In a plain
 * browser every function degrades to an inert no-op with a valid return value
 * (including valid unsubscribe handles), so the UI loads for component work
 * and E2E without a native build. No module outside this file may import
 * from @tauri-apps/api.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { FrameBatchRaw } from "./frameModel";
import { DevGenMirror, profileRateAt, projectMirrorBatch, RateProfile } from "./devGenMirror";

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function minimizeWindow(): void {
  if (!isDesktop()) return;
  void getCurrentWindow().minimize();
}

export function toggleMaximizeWindow(): void {
  if (!isDesktop()) return;
  void getCurrentWindow().toggleMaximize();
}

export function closeWindow(): void {
  if (!isDesktop()) return;
  void getCurrentWindow().close();
}

/**
 * Subscribes to maximize-state changes; fires immediately with the current
 * state. Returns a valid unsubscribe in both environments.
 */
export function onMaximizedChange(cb: (maximized: boolean) => void): () => void {
  if (!isDesktop()) {
    cb(false);
    return () => {};
  }
  const win = getCurrentWindow();
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void win.isMaximized().then((m) => {
    if (!disposed) cb(m);
  });
  void win
    .onResized(() => {
      void win.isMaximized().then((m) => {
        if (!disposed) cb(m);
      });
    })
    .then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

// ---------------------------------------------------------------------------
// Capture session + frame stream. Desktop: commands + the single batched
// event ("frames:batch", SRS_streaming.md §1). Browser: a TS mirror of the
// dev generator emits the same shape on the same cadence, self-paced.
// ---------------------------------------------------------------------------

const FRAME_EVENT = "frames:batch";
const MIRROR_TICK_MS = 16;

class MirrorCapture {
  private timer: ReturnType<typeof setInterval> | null = null;
  private gen: DevGenMirror | null = null;
  private seq = 0;
  private lastTick: number | null = null;
  private carry = 0;
  private subscribers = new Set<(b: FrameBatchRaw) => void>();

  start(profile: RateProfile): void {
    this.stop();
    this.gen = new DevGenMirror();
    this.seq = 0;
    this.carry = 0;
    const t0 = Date.now();
    this.lastTick = t0;
    this.timer = setInterval(() => {
      const now = Date.now();
      const elapsedS = (now - t0) / 1000;
      const rate = profileRateAt(profile, elapsedS);
      const dt = Math.min(1, (now - (this.lastTick ?? now)) / 1000);
      this.lastTick = now;
      this.carry += rate * dt;
      const n = Math.floor(this.carry);
      this.carry -= n;
      if (n <= 0 || !this.gen) return; // an empty read never flushes a batch
      const rows = this.gen.genFrames(n, rate);
      const batch = projectMirrorBatch(this.seq, rows);
      this.seq += 1;
      for (const cb of this.subscribers) cb(batch);
    }, MIRROR_TICK_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.gen = null;
  }

  subscribe(cb: (b: FrameBatchRaw) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }
}

const mirror = new MirrorCapture();

export function startCapture(profile: RateProfile): Promise<boolean> {
  if (!isDesktop()) {
    mirror.start(profile);
    return Promise.resolve(true);
  }
  return invoke<boolean>("capture_start", { profile });
}

export function stopCapture(): Promise<void> {
  if (!isDesktop()) {
    mirror.stop();
    return Promise.resolve();
  }
  return invoke<void>("capture_stop");
}

/**
 * Restores one backpressure credit (max 3 in flight). Called exactly once per
 * animation frame by the UI while a capture is live; a no-op in the browser.
 */
export function ackFrames(n: number): void {
  if (!isDesktop()) return;
  void invoke("ack_frames", { n }).catch(() => {
    // Stale acks after session stop are expected and ignored.
  });
}

/** Subscribes to batched frames; returns a valid unsubscribe in both modes. */
export function onFrameBatch(cb: (batch: FrameBatchRaw) => void): () => void {
  if (!isDesktop()) return mirror.subscribe(cb);
  let disposed = false;
  let unlisten: (() => void) | null = null;
  // Bounded startup-race retries while Tauri's event plumbing initializes.
  const attempt = (left: number): void => {
    void listen<FrameBatchRaw>(FRAME_EVENT, (e) => cb(e.payload))
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {
        if (left > 0 && !disposed) setTimeout(() => attempt(left - 1), 50);
      });
  };
  attempt(5);
  return () => {
    disposed = true;
    unlisten?.();
  };
}
