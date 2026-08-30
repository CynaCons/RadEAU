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
  CaptureStats,
  InterfaceInfo,
} from "./captureSource";
import { emptyByClass } from "./captureSource";
import {
  browserDependencyRows,
  type DependencyRow,
} from "./dependencyDisplay";
import { FrameBatchRaw, setSessionEndpoints } from "./frameModel";
import { DevGenMirror, profileRateAt, projectMirrorBatch, RateProfile } from "./devGenMirror";
import { PROTO_CLASS_COUNT } from "./wireCodes";

export type {
  CaptureLinkStatus,
  CaptureSessionInfo,
  CaptureSource,
  CaptureStats,
  InterfaceInfo,
} from "./captureSource";
export type { DependencyRow } from "./dependencyDisplay";

export type BuildProfile = "debug" | "release" | "browser";

/** Shape of the core `app_info` command (camelCase). */
export interface AppInfo {
  version: string;
  buildProfile: BuildProfile;
  os: string;
  devgenAvailable: boolean;
}

function browserAppInfo(): AppInfo {
  const envVersion =
    typeof import.meta !== "undefined"
      ? (import.meta.env?.PACKAGE_VERSION as string | undefined)
      : undefined;
  return {
    version: envVersion && envVersion.length > 0 ? envVersion : "browser",
    buildProfile: "browser",
    os: typeof navigator !== "undefined" ? navigator.platform : "browser",
    devgenAvailable: true,
  };
}

/**
 * App identity from the core (`app_info`). Browser mode returns a local
 * fallback so About and Settings can render without a native build.
 */
export function appInfo(): Promise<AppInfo> {
  if (!isDesktop()) {
    return Promise.resolve(browserAppInfo());
  }
  return invoke<AppInfo>("app_info");
}

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
const STATS_EVENT = "capture:stats";
const MIRROR_TICK_MS = 16;
const MIRROR_STATS_MS = 1000;

class MirrorCapture {
  private timer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private gen: DevGenMirror | null = null;
  private seq = 0;
  private statsSeq = 0;
  private lastTick: number | null = null;
  private carry = 0;
  private t0 = 0;
  private received = 0;
  private emitted = 0;
  private byClass: number[] = emptyByClass();
  private subscribers = new Set<(b: FrameBatchRaw) => void>();
  private sessionSubs = new Set<(s: CaptureSessionInfo) => void>();
  private linkSubs = new Set<(s: CaptureLinkStatus) => void>();
  private statsSubs = new Set<(s: CaptureStats) => void>();

  start(profile: RateProfile): void {
    this.stop();
    this.gen = new DevGenMirror();
    this.seq = 0;
    this.statsSeq = 0;
    this.carry = 0;
    this.received = 0;
    this.emitted = 0;
    this.byClass = emptyByClass();
    const endpoints = [0, 1, 2, 3, 4].map((ep) => {
      const ip = `10.42.0.${11 + ep}`;
      return { name: ip, ip };
    });
    this.t0 = Date.now();
    const session: CaptureSessionInfo = {
      sourceKind: "devgen",
      scenario: null,
      endpoints,
      sessionEpochMs: this.t0,
      timestampSource: "host",
    };
    setSessionEndpoints(endpoints);
    for (const cb of this.sessionSubs) cb(session);
    for (const cb of this.linkSubs) cb({ state: "connected", detail: null });

    this.lastTick = this.t0;
    this.timer = setInterval(() => {
      const now = Date.now();
      const elapsedS = (now - this.t0) / 1000;
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
      this.received += rows.length;
      this.emitted += rows.length;
      for (const r of rows) {
        if (r.proto >= 0 && r.proto < PROTO_CLASS_COUNT) {
          this.byClass[r.proto] += 1;
        }
      }
      for (const cb of this.subscribers) cb(batch);
    }, MIRROR_TICK_MS);

    this.statsTimer = setInterval(() => this.emitStats(), MIRROR_STATS_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    // Final truthful stats at stop (SP-010), then tear down the ticker.
    if (this.gen !== null) this.emitStats();
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.gen = null;
    setSessionEndpoints(null);
    for (const cb of this.linkSubs) cb({ state: "closed", detail: null });
  }

  private emitStats(): void {
    const stats: CaptureStats = {
      seq: this.statsSeq,
      elapsedS: (Date.now() - this.t0) / 1000,
      received: this.received,
      emitted: this.emitted,
      accumulatorDropped: 0,
      gapRecords: 0,
      gapDropped: 0,
      malformed: 0,
      kernelDropped: 0,
      byClass: this.byClass.slice(),
      recordingFrames: 0,
      recordingBytes: 0,
      recordingDropped: 0,
    };
    this.statsSeq += 1;
    for (const cb of this.statsSubs) cb(stats);
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

  subscribeStats(cb: (s: CaptureStats) => void): () => void {
    this.statsSubs.add(cb);
    return () => this.statsSubs.delete(cb);
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
    if (source.kind === "pcap") {
      return Promise.reject(new Error("pcap file is desktop-app only"));
    }
    if (source.kind === "pcapStream") {
      return Promise.reject(new Error("pcap stream is desktop-app only"));
    }
    if (source.kind === "live") {
      return Promise.reject(new Error("physical interface is desktop-app only"));
    }
    mirror.start(source.profile);
    return Promise.resolve(true);
  }
  return invoke<boolean>("capture_start", { source });
}

/**
 * Enumerates capture devices (CP-011). Browser mode rejects honestly.
 * Desktop rejects with a remedy message when Npcap/libpcap is missing.
 */
export function listInterfaces(): Promise<InterfaceInfo[]> {
  if (!isDesktop()) {
    return Promise.reject(new Error("desktop app only"));
  }
  return invoke<InterfaceInfo[]>("capture_list_interfaces");
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

/** Capture statistics (1 Hz + once at stop); no-op-safe in browser mode. */
export function onCaptureStats(cb: (stats: CaptureStats) => void): () => void {
  if (!isDesktop()) return mirror.subscribeStats(cb);
  return listenEvent<CaptureStats>(STATS_EVENT, cb);
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

export interface DecodedSignal {
  name: string;
  rawHex: string;
  rawDec: string;
  scaled: number;
  unit: string;
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
  /**
   * Catalog-decoded payload signals when the loaded catalog knows this
   * frame's (service, event); otherwise null (hex dump only).
   */
  decoded: DecodedSignal[] | null;
}

/**
 * Fetches a Wireshark-style layer dissection for one buffered frame.
 * Browser mode rejects with `"desktop app only"`. Core may reject with
 * `"frame no longer buffered"` or `"unknown frame"`.
 */
/** Round-trip record of one `frame_detail` call, readable at `window.__radeauFrameDetail`. */
export interface FrameDetailTiming {
  idx: number;
  /** `performance.now()` when the command was sent. */
  start: number;
  /** Round-trip in ms once settled. */
  ms: number | null;
  ok: boolean | null;
}

const FRAME_DETAIL_TIMINGS_KEPT = 20;
const frameDetailTimings: FrameDetailTiming[] = [];
(globalThis as { __radeauFrameDetail?: FrameDetailTiming[] }).__radeauFrameDetail =
  frameDetailTimings;

export function fetchFrameDetail(idx: number): Promise<FrameDetail> {
  if (!isDesktop()) {
    return Promise.reject(new Error("desktop app only"));
  }
  const rec: FrameDetailTiming = {
    idx,
    start: Math.round(performance.now()),
    ms: null,
    ok: null,
  };
  frameDetailTimings.push(rec);
  if (frameDetailTimings.length > FRAME_DETAIL_TIMINGS_KEPT) frameDetailTimings.shift();
  const settle = (ok: boolean) => {
    rec.ms = Math.round(performance.now() - rec.start);
    rec.ok = ok;
  };
  return invoke<FrameDetail>("frame_detail", { idx }).then(
    (detail) => {
      settle(true);
      return detail;
    },
    (err: unknown) => {
      settle(false);
      throw err;
    },
  );
}

// ---------------------------------------------------------------------------
// Service catalog. Desktop: catalog_model / catalog_load / catalog_unload /
// catalog_import / catalog_reload / catalog_diagnostics + catalog:state.
// Browser: every command rejects; the UI stays unloaded and uses the static
// SERVICES fallback in frameModel.
// ---------------------------------------------------------------------------

const CATALOG_STATE_EVENT = "catalog:state";

export interface CatalogSignal {
  name: string;
  byteOffset: number;
  byteLen: number;
  base: string;
  factor: number;
  offset: number;
  unit: string;
}

export interface CatalogEvent {
  eventId: number;
  name: string;
  signals: CatalogSignal[];
}

export interface CatalogMethod {
  methodId: number;
  name: string;
}

export interface CatalogService {
  serviceId: number;
  name: string;
  instanceId: number;
  events: CatalogEvent[];
  methods: CatalogMethod[];
}

export interface CatalogModel {
  loaded: boolean;
  source: string;
  services: CatalogService[];
}

export type CatalogSourceKind = "embedded" | "file" | "env";

export type CatalogDiagnosticSeverity = "error" | "warn" | "info";

/** Per-element import diagnostic (SRS_protocols.md §4). */
export interface CatalogDiagnostic {
  severity: CatalogDiagnosticSeverity;
  path: string;
  message: string;
}

/** Successful catalog_import / catalog_reload summary. */
export interface CatalogImportSummary {
  source: string;
  services: number;
  signals: number;
  diagnostics: CatalogDiagnostic[];
}

export interface CatalogStateEvent {
  loaded: boolean;
  serviceCount: number;
  signalCount: number;
  source: string;
  sourceKind: CatalogSourceKind;
  errors: number;
  warnings: number;
  lastError: string | null;
}

export function fetchCatalogModel(): Promise<CatalogModel> {
  if (!isDesktop()) {
    return Promise.reject(new Error("desktop app only"));
  }
  return invoke<CatalogModel>("catalog_model");
}

export function catalogLoad(): Promise<void> {
  if (!isDesktop()) {
    return Promise.reject(new Error("desktop app only"));
  }
  return invoke<void>("catalog_load");
}

export function catalogUnload(): Promise<void> {
  if (!isDesktop()) {
    return Promise.reject(new Error("desktop app only"));
  }
  return invoke<void>("catalog_unload");
}

/**
 * Imports an ARXML extract. On success replaces the active catalog; on fatal
 * error rejects with the message and keeps the previous catalog.
 */
export function catalogImport(path: string): Promise<CatalogImportSummary> {
  if (!isDesktop()) {
    return Promise.reject(new Error("desktop app only"));
  }
  return invoke<CatalogImportSummary>("catalog_import", { path });
}

/** Re-imports the current source. Rejects for embedded / browser. */
export function catalogReload(): Promise<CatalogImportSummary> {
  if (!isDesktop()) {
    return Promise.reject(new Error("desktop app only"));
  }
  return invoke<CatalogImportSummary>("catalog_reload");
}

/** Last import's diagnostics list. */
export function catalogDiagnostics(): Promise<CatalogDiagnostic[]> {
  if (!isDesktop()) {
    return Promise.reject(new Error("desktop app only"));
  }
  return invoke<CatalogDiagnostic[]>("catalog_diagnostics");
}

/**
 * Native open dialog for `.arxml`. Returns null on cancel; rejects when the
 * dialog cannot run (browser / plugin unavailable).
 */
export async function pickArxmlFile(): Promise<string | null> {
  if (!isDesktop()) {
    return Promise.reject(new Error("desktop app only"));
  }
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [{ name: "AUTOSAR", extensions: ["arxml"] }],
    });
    if (typeof selected === "string") return selected;
    return null;
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
    return Promise.reject(new Error(msg || "open dialog unavailable"));
  }
}

/** Fires at startup and on each load/unload/import; no-op-safe in browser mode. */
export function onCatalogState(cb: (state: CatalogStateEvent) => void): () => void {
  return listenEvent<CatalogStateEvent>(CATALOG_STATE_EVENT, cb);
}

// ---------------------------------------------------------------------------
// Capture backends I (v0.1.6): dependency probes, diagnostics report, ring
// export, file dialogs, open_url. Browser mode stays honest — never fakes
// installed drivers or exported bytes.
// ---------------------------------------------------------------------------

const EXPORT_EVENT = "capture:export";

export interface ExportRingResult {
  frames: number;
  bytes: number;
  firstTsMs: number;
  lastTsMs: number;
}

export interface CaptureExportProgress {
  done: number;
  total: number;
}

const BROWSER_DIAG_REPORT = [
  "RadEAU diagnostic report",
  "mode       browser",
  "build      frontend only",
  "log path   (desktop app only)",
  "",
  "Dependency probes, the on-disk log, and ring→pcap export require the",
  "desktop app. Open Settings › Diagnostics there for a pasteable report.",
].join("\n");

/** Read-only dependency probe rows (CP-008). */
export function dependencyProbe(): Promise<DependencyRow[]> {
  if (!isDesktop()) {
    return Promise.resolve(browserDependencyRows());
  }
  return invoke<DependencyRow[]>("dependency_probe");
}

/** Plain-text diagnostics report for Settings › Diagnostics (CP-008). */
export function diagnosticsReport(): Promise<string> {
  if (!isDesktop()) {
    return Promise.resolve(BROWSER_DIAG_REPORT);
  }
  return invoke<string>("diagnostics_report");
}

/** Absolute path of radeau.log (CP-007). */
export function logPath(): Promise<string> {
  if (!isDesktop()) {
    return Promise.resolve("(desktop app only)");
  }
  return invoke<string>("log_path");
}

/**
 * Writes the frame ring as classic pcap (CP-006). Browser mode rejects.
 */
export function exportRing(path: string): Promise<ExportRingResult> {
  if (!isDesktop()) {
    return Promise.reject(new Error("desktop app only"));
  }
  return invoke<ExportRingResult>("export_ring", { path });
}

/** Progress while export_ring runs; no-op-safe in browser mode. */
export function onCaptureExport(
  cb: (progress: CaptureExportProgress) => void,
): () => void {
  return listenEvent<CaptureExportProgress>(EXPORT_EVENT, cb);
}

/**
 * Opens a URL in the system browser via `open_url`, falling back to
 * `window.open` when the command is unavailable.
 */
export async function openUrl(url: string): Promise<void> {
  if (!isDesktop()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    await invoke<void>("open_url", { url });
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Native open dialog for .pcap / .pcapng. Returns null on cancel or when
 * the dialog plugin is unavailable (caller keeps a plain editable path).
 */
export async function pickPcapFile(): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [{ name: "pcap", extensions: ["pcap", "pcapng"] }],
    });
    if (typeof selected === "string") return selected;
    return null;
  } catch {
    return null;
  }
}

/**
 * Native save dialog defaulting to `defaultName`. Returns null on cancel;
 * rejects with an honest message when the dialog cannot run at all.
 */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!isDesktop()) {
    return Promise.reject(new Error("desktop app only"));
  }
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const selected = await save({
      defaultPath: defaultName,
      filters: [{ name: "pcap", extensions: ["pcap"] }],
    });
    return typeof selected === "string" ? selected : null;
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
    return Promise.reject(new Error(msg || "save dialog unavailable"));
  }
}

// ---------------------------------------------------------------------------
// Continuous pcap recording (CP-014..016). Desktop: recording_* commands +
// recording:state. Browser: in-memory arm toggle; empty list; dir "browser".
// ---------------------------------------------------------------------------

const RECORDING_STATE_EVENT = "recording:state";

/** Shape of `recording_state` / `recording:state` (camelCase). */
export interface RecordingState {
  armed: boolean;
  active: boolean;
  path: string | null;
  frames: number;
  bytes: number;
  dropped: number;
  error: string | null;
  dir: string;
  startedMs: number | null;
}

/** One row from `recording_list` (newest first). */
export interface RecordingInfo {
  path: string;
  bytes: number;
  frames: number | null;
  startedMs: number;
}

function idleRecordingState(dir = "browser"): RecordingState {
  return {
    armed: false,
    active: false,
    path: null,
    frames: 0,
    bytes: 0,
    dropped: 0,
    error: null,
    dir,
    startedMs: null,
  };
}

/** Browser-mode in-memory recording mirror (arm toggles only). */
class BrowserRecording {
  private state: RecordingState = idleRecordingState();
  private subscribers = new Set<(s: RecordingState) => void>();

  snapshot(): RecordingState {
    return { ...this.state };
  }

  arm(armed: boolean): RecordingState {
    this.state = {
      ...this.state,
      armed,
      // Browser never opens a file; keep active/path idle.
      active: false,
      path: null,
      frames: 0,
      bytes: 0,
      dropped: 0,
      error: null,
      startedMs: null,
    };
    this.emit();
    return this.snapshot();
  }

  setDir(path: string): string {
    this.state = { ...this.state, dir: path };
    this.emit();
    return this.state.dir;
  }

  subscribe(cb: (s: RecordingState) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const cb of this.subscribers) cb(snap);
  }
}

const browserRecording = new BrowserRecording();

export function recordingState(): Promise<RecordingState> {
  if (!isDesktop()) {
    return Promise.resolve(browserRecording.snapshot());
  }
  return invoke<RecordingState>("recording_state");
}

export function recordingArm(armed: boolean): Promise<RecordingState> {
  if (!isDesktop()) {
    return Promise.resolve(browserRecording.arm(armed));
  }
  return invoke<RecordingState>("recording_arm", { armed });
}

export function recordingDirGet(): Promise<string> {
  if (!isDesktop()) {
    return Promise.resolve(browserRecording.snapshot().dir);
  }
  return invoke<string>("recording_dir_get");
}

export function recordingDirSet(path: string): Promise<string> {
  if (!isDesktop()) {
    return Promise.resolve(browserRecording.setDir(path));
  }
  return invoke<string>("recording_dir_set", { path });
}

export function recordingList(): Promise<RecordingInfo[]> {
  if (!isDesktop()) {
    return Promise.resolve([]);
  }
  return invoke<RecordingInfo[]>("recording_list");
}

/** Fires on every recording transition and at 1 Hz while active. */
export function onRecordingState(cb: (state: RecordingState) => void): () => void {
  if (!isDesktop()) return browserRecording.subscribe(cb);
  return listenEvent<RecordingState>(RECORDING_STATE_EVENT, cb);
}

/**
 * Native directory picker. Returns null on cancel; rejects when the dialog
 * cannot run (browser / plugin unavailable).
 */
export async function pickDirectory(): Promise<string | null> {
  if (!isDesktop()) {
    return Promise.reject(new Error("desktop app only"));
  }
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") return selected;
    return null;
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
    return Promise.reject(new Error(msg || "directory dialog unavailable"));
  }
}

