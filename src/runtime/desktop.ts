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

import type {
  CaptureLinkStatus,
  CaptureSessionInfo,
  CaptureSource,
} from "./captureSource";
import { FrameBatchRaw, setSessionEndpoints } from "./frameModel";
import { DevGenMirror, profileRateAt, projectMirrorBatch, RateProfile } from "./devGenMirror";

export type { CaptureLinkStatus, CaptureSessionInfo, CaptureSource } from "./captureSource";

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
// event ("frames:batch", SRS_streaming.md §1) plus capture:session /
// capture:link. Browser: a TS mirror of the generator emits the same batch
// shape on the same cadence; sim is desktop-only.
// ---------------------------------------------------------------------------

const FRAME_EVENT = "frames:batch";
const SESSION_EVENT = "capture:session";
const LINK_EVENT = "capture:link";
const MIRROR_TICK_MS = 16;

class MirrorCapture {
  private timer: ReturnType<typeof setInterval> | null = null;
  private gen: DevGenMirror | null = null;
  private seq = 0;
  private lastTick: number | null = null;
  private carry = 0;
  private subscribers = new Set<(b: FrameBatchRaw) => void>();
  private sessionSubs = new Set<(s: CaptureSessionInfo) => void>();
  private linkSubs = new Set<(s: CaptureLinkStatus) => void>();

  start(profile: RateProfile): void {
    this.stop();
    this.gen = new DevGenMirror();
    this.seq = 0;
    this.carry = 0;
    const endpoints = [0, 1, 2, 3, 4].map((ep) => {
      const ip = `10.42.0.${11 + ep}`;
      return { name: ip, ip };
    });
    const session: CaptureSessionInfo = {
      sourceKind: "devgen",
      scenario: null,
      endpoints,
    };
    setSessionEndpoints(endpoints);
    for (const cb of this.sessionSubs) cb(session);
    for (const cb of this.linkSubs) cb({ state: "connected", detail: null });

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
    setSessionEndpoints(null);
    for (const cb of this.linkSubs) cb({ state: "closed", detail: null });
  }

  subscribe(cb: (b: FrameBatchRaw) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  subscribeSession(cb: (s: CaptureSessionInfo) => void): () => void {
    this.sessionSubs.add(cb);
    return () => this.sessionSubs.delete(cb);
  }

  subscribeLink(cb: (s: CaptureLinkStatus) => void): () => void {
    this.linkSubs.add(cb);
    return () => this.linkSubs.delete(cb);
  }
}

const mirror = new MirrorCapture();

function listenEvent<T>(event: string, cb: (payload: T) => void): () => void {
  if (!isDesktop()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  const attempt = (left: number): void => {
    void listen<T>(event, (e) => cb(e.payload))
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

export function startCapture(source: CaptureSource): Promise<boolean> {
  if (!isDesktop()) {
    if (source.kind === "sim") {
      return Promise.reject(new Error("simulator link is desktop-app only"));
    }
    mirror.start(source.profile);
    return Promise.resolve(true);
  }
  return invoke<boolean>("capture_start", { source });
}

export function stopCapture(): Promise<void> {
  if (!isDesktop()) {
    mirror.stop();
    return Promise.resolve();
  }
  setSessionEndpoints(null);
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
  return listenEvent<FrameBatchRaw>(FRAME_EVENT, cb);
}

/** Session metadata (endpoint table, scenario); no-op-safe in browser mode. */
export function onCaptureSession(cb: (session: CaptureSessionInfo) => void): () => void {
  if (!isDesktop()) return mirror.subscribeSession(cb);
  return listenEvent<CaptureSessionInfo>(SESSION_EVENT, (session) => {
    setSessionEndpoints(session.endpoints);
    cb(session);
  });
}

/** Link-state transitions; no-op-safe in browser mode. */
export function onCaptureLink(cb: (status: CaptureLinkStatus) => void): () => void {
  if (!isDesktop()) return mirror.subscribeLink(cb);
  return listenEvent<CaptureLinkStatus>(LINK_EVENT, cb);
}

// ---------------------------------------------------------------------------
// Frame dissection (cold path). Desktop invokes `frame_detail`; browser mode
// rejects so the UI can show an honest empty state (SRS_visual_ui.md §5.2).
// ---------------------------------------------------------------------------

export interface FrameField {
  name: string;
  value: string;
  offset: number;
  len: number;
}

export interface FrameLayer {
  protocol: string;
  summary: string;
  fields: FrameField[];
}

export interface FrameDetail {
  idx: number;
  tS: number;
  wireLen: number;
  payloadOffset: number;
  /** Wire order: Ethernet II → IPv4 → UDP → SOME/IP → SOME/IP-SD, or Ethernet II → gPTP. */
  layers: FrameLayer[];
  /** Full frame, uppercase hex, no separators. */
  bytes: string;
}

/**
 * Fetches a Wireshark-style layer dissection for one buffered frame.
 * Browser mode rejects with `"desktop app only"`. Core may reject with
 * `"frame no longer buffered"` or `"unknown frame"`.
 */
export function fetchFrameDetail(idx: number): Promise<FrameDetail> {
  if (!isDesktop()) {
    return Promise.reject(new Error("desktop app only"));
  }
  return invoke<FrameDetail>("frame_detail", { idx });
}
