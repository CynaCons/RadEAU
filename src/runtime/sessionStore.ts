/**
 * Global capture-session store (SRS_visual_ui.md §4.3): the app-bar run
 * control owns the session; view-local capture buttons mirror this state.
 * Sole caller of startCapture/stopCapture and sole subscriber of
 * capture:session / capture:link — views read via subscribe/getSnapshot.
 */

import {
  buildCaptureSource,
  DEFAULT_DEVGEN_PROFILE,
  DEFAULT_SIM_ADDR,
  type CaptureLinkStatus,
  type CaptureSessionInfo,
  type CaptureSource,
  type SourceKind,
} from "./captureSource";
import {
  onCaptureLink,
  onCaptureSession,
  startCapture,
  stopCapture,
} from "./desktop";

export interface SessionSnapshot {
  readonly running: boolean;
  readonly sourceKind: SourceKind;
  readonly simAddr: string;
  readonly linkStatus: CaptureLinkStatus | null;
  readonly sessionInfo: CaptureSessionInfo | null;
}

export class SessionStore {
  private running = false;
  private sourceKind: SourceKind = "devgen";
  private simAddr = DEFAULT_SIM_ADDR;
  private linkStatus: CaptureLinkStatus | null = null;
  private sessionInfo: CaptureSessionInfo | null = null;
  private listeners = new Set<() => void>();
  private snapshot: SessionSnapshot;
  private startInFlight: Promise<void> | null = null;

  constructor() {
    this.snapshot = this.buildSnapshot();
    // Own the session/link event channels for the whole app lifetime.
    onCaptureSession((info) => {
      this.sessionInfo = info;
      this.publish();
    });
    onCaptureLink((status) => {
      this.linkStatus = status;
      this.publish();
    });
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  /** Builds the tagged source currently configured (editable only while stopped). */
  currentSource(): CaptureSource {
    return buildCaptureSource(this.sourceKind, {
      profile: DEFAULT_DEVGEN_PROFILE,
      addr: this.simAddr,
    });
  }

  setSourceKind(kind: SourceKind): void {
    if (this.running || kind === this.sourceKind) return;
    this.sourceKind = kind;
    if (kind === "devgen") this.linkStatus = null;
    this.publish();
  }

  setSimAddr(addr: string): void {
    if (this.running || addr === this.simAddr) return;
    this.simAddr = addr;
    this.publish();
  }

  async start(): Promise<void> {
    if (this.running || this.startInFlight) return;
    const source = this.currentSource();
    if (source.kind === "sim") {
      this.linkStatus = { state: "connecting", detail: source.addr };
      this.publish();
    } else {
      this.linkStatus = null;
      this.publish();
    }
    const work = startCapture(source)
      .then(() => {
        this.running = true;
        this.publish();
      })
      .catch(() => {
        this.running = false;
        this.linkStatus = null;
        this.sessionInfo = null;
        this.publish();
      })
      .finally(() => {
        this.startInFlight = null;
      });
    this.startInFlight = work;
    return work;
  }

  async stop(): Promise<void> {
    if (!this.running && !this.startInFlight) return;
    // Flip UI immediately; halt the underlying session next.
    this.running = false;
    this.linkStatus = null;
    this.sessionInfo = null;
    this.publish();
    try {
      await stopCapture();
    } catch {
      /* session already gone */
    }
    // stopCapture may emit a final "closed" link event — keep the chip hidden.
    if (!this.running) {
      this.linkStatus = null;
      this.sessionInfo = null;
      this.publish();
    }
  }

  async toggle(): Promise<void> {
    if (this.running) await this.stop();
    else await this.start();
  }

  private buildSnapshot(): SessionSnapshot {
    return {
      running: this.running,
      sourceKind: this.sourceKind,
      simAddr: this.simAddr,
      linkStatus: this.linkStatus,
      sessionInfo: this.sessionInfo,
    };
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const cb of this.listeners) cb();
  }
}

/** Application-wide capture session singleton. */
export const sessionStore = new SessionStore();
