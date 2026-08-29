/**
 * Global capture-session store (SRS_visual_ui.md §4.3): the app-bar run
 * control owns the session; view-local capture buttons mirror this state.
 * Sole caller of startCapture/stopCapture and sole subscriber of
 * capture:session / capture:link / capture:stats — views read via
 * subscribe/getSnapshot.
 */

import {
  buildCaptureSource,
  DEFAULT_DEVGEN_PROFILE,
  DEFAULT_PCAP_PACE,
  DEFAULT_SIM_ADDR,
  type CaptureLinkStatus,
  type CaptureSessionInfo,
  type CaptureSource,
  type CaptureStats,
  type PcapPace,
  type SourceKind,
} from "./captureSource";
import {
  onCaptureLink,
  onCaptureSession,
  onCaptureStats,
  startCapture,
  stopCapture,
} from "./desktop";

export interface SessionSnapshot {
  readonly running: boolean;
  readonly sourceKind: SourceKind;
  readonly simAddr: string;
  readonly pcapPath: string;
  readonly pcapPace: PcapPace;
  readonly pcapStreamAddr: string;
  readonly liveInterfaceId: string;
  /** Empty string means "use the core default BPF". */
  readonly liveFilter: string;
  readonly linkStatus: CaptureLinkStatus | null;
  readonly sessionInfo: CaptureSessionInfo | null;
  /** Live / last-session capture counters; null until the first stats event. */
  readonly stats: CaptureStats | null;
  /** Verbatim start-rejection message; cleared on the next start/stop. */
  readonly lastError: string | null;
}

export class SessionStore {
  private running = false;
  private sourceKind: SourceKind = "devgen";
  private simAddr = DEFAULT_SIM_ADDR;
  private pcapPath = "";
  private pcapPace: PcapPace = DEFAULT_PCAP_PACE;
  private pcapStreamAddr = "";
  private liveInterfaceId = "";
  private liveFilter = "";
  private linkStatus: CaptureLinkStatus | null = null;
  private sessionInfo: CaptureSessionInfo | null = null;
  private stats: CaptureStats | null = null;
  private lastError: string | null = null;
  private listeners = new Set<() => void>();
  private snapshot: SessionSnapshot;
  private startInFlight: Promise<void> | null = null;

  constructor() {
    this.snapshot = this.buildSnapshot();
    // Own the session/link/stats event channels for the whole app lifetime.
    onCaptureSession((info) => {
      this.sessionInfo = info;
      this.publish();
    });
    onCaptureLink((status) => {
      // CP-005: a closed link while running means the session ended itself
      // (end of file / stream). Keep stats and the closed linkStatus so
      // Network can show "Closed · end of file · n frames"; Trace never
      // surfaces the closed chip (showDegradedLinkChip excludes it).
      if (status.state === "closed" && this.running) {
        this.running = false;
        this.linkStatus = status;
        this.lastError = null;
        this.publish();
        return;
      }
      this.linkStatus = status;
      this.publish();
    });
    onCaptureStats((stats) => {
      this.stats = stats;
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
      path: this.pcapPath,
      pace: this.pcapPace,
      streamAddr: this.pcapStreamAddr,
      interfaceId: this.liveInterfaceId,
      filter: this.liveFilter,
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

  setPcapPath(path: string): void {
    if (this.running || path === this.pcapPath) return;
    this.pcapPath = path;
    this.publish();
  }

  setPcapPace(pace: PcapPace): void {
    if (this.running || pace === this.pcapPace) return;
    this.pcapPace = pace;
    this.publish();
  }

  setPcapStreamAddr(addr: string): void {
    if (this.running || addr === this.pcapStreamAddr) return;
    this.pcapStreamAddr = addr;
    this.publish();
  }

  setLiveInterfaceId(id: string): void {
    if (this.running || id === this.liveInterfaceId) return;
    this.liveInterfaceId = id;
    this.publish();
  }

  setLiveFilter(filter: string): void {
    if (this.running || filter === this.liveFilter) return;
    this.liveFilter = filter;
    this.publish();
  }

  /**
   * Configures the session as a pcap-file source (Recorder Replay Browse).
   * No-op while running.
   */
  setPcapSource(path: string, pace: PcapPace = this.pcapPace): void {
    if (this.running) return;
    this.sourceKind = "pcap";
    this.pcapPath = path;
    this.pcapPace = pace;
    this.publish();
  }

  async start(): Promise<void> {
    if (this.running || this.startInFlight) return;
    this.lastError = null;
    this.stats = null; // counters reset when a session starts
    const source = this.currentSource();
    if (source.kind === "sim") {
      this.linkStatus = { state: "connecting", detail: source.addr };
      this.publish();
    } else if (source.kind === "pcapStream") {
      this.linkStatus = {
        state: "connecting",
        detail: source.addr || null,
      };
      this.publish();
    } else if (source.kind === "pcap") {
      this.linkStatus = {
        state: "connecting",
        detail: source.path || null,
      };
      this.publish();
    } else if (source.kind === "live") {
      this.linkStatus = {
        state: "connecting",
        detail: source.interfaceId || null,
      };
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
      .catch((err: unknown) => {
        this.running = false;
        this.linkStatus = null;
        this.sessionInfo = null;
        this.lastError =
          err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
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
    // Stats are retained so the last session's numbers stay readable.
    this.running = false;
    this.linkStatus = null;
    this.sessionInfo = null;
    this.lastError = null;
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
      pcapPath: this.pcapPath,
      pcapPace: this.pcapPace,
      pcapStreamAddr: this.pcapStreamAddr,
      liveInterfaceId: this.liveInterfaceId,
      liveFilter: this.liveFilter,
      linkStatus: this.linkStatus,
      sessionInfo: this.sessionInfo,
      stats: this.stats,
      lastError: this.lastError,
    };
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const cb of this.listeners) cb();
  }
}

/** Application-wide capture session singleton. */
export const sessionStore = new SessionStore();
