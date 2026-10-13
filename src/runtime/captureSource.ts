/**
 * Capture source picker helpers — pure state logic shared by Settings (choice),
 * Trace (degraded link chip), Network (connection truth), and tests. Mirrors
 * the Rust `SourceSpec` tagged union.
 */

import type { RateProfile } from "./devGenMirror";
import type { DependencyStatus } from "./dependencyDisplay";
import type { SessionEndpoint } from "./frameModel";
import { PROTO_CLASS_COUNT } from "./wireCodes";

export type SourceKind = "devgen" | "sim" | "pcap" | "pcapStream" | "live";

export type PcapPace = "realtime" | "fast";

export type CaptureSource =
  | { kind: "devgen"; profile: RateProfile }
  | { kind: "sim"; addr: string }
  | { kind: "pcap"; path: string; pace: PcapPace }
  | { kind: "pcapStream"; addr: string }
  | { kind: "live"; interfaceId: string; filter: string | null };

/** Device row from `capture_list_interfaces` (CP-011). */
export interface InterfaceInfo {
  id: string;
  name: string;
  description: string | null;
  addresses: string[];
  up: boolean;
  loopback: boolean;
}

export type LinkState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "closed";

export type TimestampSource = "host" | "switch" | "file" | "hardware";

export interface CaptureLinkStatus {
  state: LinkState;
  detail: string | null;
}

export interface CaptureSessionInfo {
  sourceKind: SourceKind;
  scenario: string | null;
  endpoints: SessionEndpoint[];
  /** Wall-clock ms of relative time 0; null when the source has no anchor. */
  sessionEpochMs: number | null;
  timestampSource: TimestampSource;
}

/**
 * `capture:stats` payload (SP-010 / codes.rs): 1 Hz while running and once
 * at stop. `byClass` is indexed by PROTO_* and length PROTO_CLASS_COUNT.
 */
export interface CaptureStats {
  seq: number;
  elapsedS: number;
  received: number;
  emitted: number;
  accumulatorDropped: number;
  gapRecords: number;
  gapDropped: number;
  malformed: number;
  kernelDropped: number;
  byClass: number[];
  /** Frames appended to the active pcap recording (CP-016). */
  recordingFrames: number;
  /** Bytes written to the active pcap recording (CP-016). */
  recordingBytes: number;
  /** Frames dropped by the recording writer queue (CP-014). */
  recordingDropped: number;
}

/** Sum of loss counters that drive the Trace `Dropped · n` chip. */
export function lossTotal(stats: CaptureStats): number {
  return (
    stats.accumulatorDropped +
    stats.gapDropped +
    stats.kernelDropped +
    stats.recordingDropped
  );
}

/** Empty per-class vector for browser-mirror / test fixtures. */
export function emptyByClass(): number[] {
  return new Array(PROTO_CLASS_COUNT).fill(0);
}

export const DEFAULT_SIM_ADDR = "127.0.0.1:5560";
export const DEFAULT_DEVGEN_PROFILE: RateProfile = "normal";
export const DEFAULT_PCAP_PACE: PcapPace = "realtime";
/** Default BPF when the live filter field is left empty (CP-012). */
export const DEFAULT_LIVE_BPF_FILTER =
  "udp or ether proto 0x88f7 or arp or vlan";

/** Link states that count as degraded for Trace's status chip (§4.3). */
const DEGRADED_LINK_STATES: ReadonlySet<LinkState> = new Set([
  "connecting",
  "reconnecting",
  "error",
]);

/** Sources that surface a Trace degraded-link chip (sim / pcap stream / live). */
const DEGRADED_LINK_KINDS: ReadonlySet<SourceKind> = new Set([
  "sim",
  "pcapStream",
  "live",
]);

/** Simulator link is a desktop-only source; browser mode keeps it disabled. */
export function simSourceAvailable(desktop: boolean): boolean {
  return desktop;
}

/** pcap file / stream sources are desktop-only. */
export function pcapSourceAvailable(desktop: boolean): boolean {
  return desktop;
}

/**
 * Live NIC capture: desktop app and the platform's npcap/libpcap probe row
 * must both be Installed (§5.7).
 */
export function liveSourceAvailable(
  desktop: boolean,
  liveDepStatus: DependencyStatus | null | undefined,
): boolean {
  return desktop && liveDepStatus === "installed";
}

/** Disabled-option reason for the live Interface entry (§5.7). */
export function liveSourceDisabledReason(
  platform: "windows" | "linux" | "other",
): string {
  if (platform === "linux") return "requires libpcap — see Dependencies";
  return "requires Npcap — see Dependencies";
}

/** Primary label for a live interface option: description, else name. */
export function liveInterfacePrimaryLabel(iface: InterfaceInfo): string {
  const d = iface.description?.trim();
  return d || iface.name;
}

/** Secondary line under a live interface option (addresses joined). */
export function liveInterfaceSecondaryText(iface: InterfaceInfo): string {
  return iface.addresses.join(", ");
}

export function buildCaptureSource(
  kind: SourceKind,
  opts: {
    profile?: RateProfile;
    addr?: string;
    path?: string;
    pace?: PcapPace;
    streamAddr?: string;
    interfaceId?: string;
    filter?: string | null;
  } = {},
): CaptureSource {
  if (kind === "sim") {
    return { kind: "sim", addr: (opts.addr ?? DEFAULT_SIM_ADDR).trim() || DEFAULT_SIM_ADDR };
  }
  if (kind === "pcap") {
    return {
      kind: "pcap",
      path: (opts.path ?? "").trim(),
      pace: opts.pace ?? DEFAULT_PCAP_PACE,
    };
  }
  if (kind === "pcapStream") {
    return { kind: "pcapStream", addr: (opts.streamAddr ?? "").trim() };
  }
  if (kind === "live") {
    const raw =
      opts.filter === null || opts.filter === undefined
        ? ""
        : String(opts.filter).trim();
    return {
      kind: "live",
      interfaceId: (opts.interfaceId ?? "").trim(),
      filter: raw.length > 0 ? raw : null,
    };
  }
  return { kind: "devgen", profile: opts.profile ?? DEFAULT_DEVGEN_PROFILE };
}

/** Address field is shown only for the simulator source. */
export function showSimAddressField(kind: SourceKind): boolean {
  return kind === "sim";
}

export function showPcapPathField(kind: SourceKind): boolean {
  return kind === "pcap";
}

export function showPcapStreamAddrField(kind: SourceKind): boolean {
  return kind === "pcapStream";
}

export function showLiveInterfaceFields(kind: SourceKind): boolean {
  return kind === "live";
}

/**
 * Trace shows a link chip only while a session runs on a degraded sim,
 * pcap-stream, or live link (connecting / reconnecting / error). Closed is
 * never shown on Trace (CP-005); healthy connected and other sources: hidden.
 * Live has no reconnect — error stays until Stop (CP-013).
 */
export function showDegradedLinkChip(
  running: boolean,
  kind: SourceKind,
  state: LinkState | null | undefined,
): boolean {
  if (!running || !state || !DEGRADED_LINK_KINDS.has(kind)) return false;
  return DEGRADED_LINK_STATES.has(state);
}

/** Controls that choose the source are locked while a capture is live. */
export function sourceControlsDisabled(capturing: boolean): boolean {
  return capturing;
}

/** Tooltip when Interface controls are locked (§5.7 — never silently ignored). */
export function interfaceLockedReason(capturing: boolean): string | null {
  return capturing ? "Interface cannot change while a session is running" : null;
}

export function sourceKindLabel(kind: SourceKind): string {
  switch (kind) {
    case "sim":
      return "Simulator link";
    case "pcap":
      return "pcap file";
    case "pcapStream":
      return "pcap stream";
    case "live":
      return "Physical interface";
    case "devgen":
      return "Dev generator";
  }
}

/**
 * Default Interface source: Dev generator when the build exposes it; else
 * Physical interface when Npcap/libpcap is Installed; else pcap file.
 */
export function defaultSourceKind(opts: {
  devgenAvailable: boolean;
  liveCaptureInstalled: boolean;
}): SourceKind {
  if (opts.devgenAvailable) return "devgen";
  if (opts.liveCaptureInstalled) return "live";
  return "pcap";
}

export function linkChipLabel(state: LinkState): string {
  switch (state) {
    case "connecting":
      return "Connecting";
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting";
    case "error":
      return "Error";
    case "closed":
      return "Closed";
  }
}

/** Token CSS variable for the link chip face (never a hex literal). */
export function linkChipColorVar(state: LinkState): string {
  switch (state) {
    case "connected":
      return "var(--success)";
    case "connecting":
    case "reconnecting":
      return "var(--warning)";
    case "error":
      return "var(--error)";
    case "closed":
      return "var(--text-secondary)";
  }
}

export function captureButtonLabel(capturing: boolean, kind: SourceKind): string {
  if (capturing) return "Stop capture";
  switch (kind) {
    case "sim":
      return "Start capture · simulator link";
    case "pcap":
      return "Start capture · pcap file";
    case "pcapStream":
      return "Start capture · pcap stream";
    case "live":
      return "Start capture · physical interface";
    case "devgen":
      return "Start capture · dev generator";
  }
}

/** Dropped-chip tooltip: accumulator + gap + kernel + recording (SP-010 / CP-012 / CP-016). */
export function droppedBreakdownTooltip(stats: CaptureStats): string {
  return [
    `Accumulator ${stats.accumulatorDropped.toLocaleString("en-US")}`,
    `Gap ${stats.gapDropped.toLocaleString("en-US")}`,
    `Kernel ${stats.kernelDropped.toLocaleString("en-US")}`,
    `Recording ${stats.recordingDropped.toLocaleString("en-US")}`,
  ].join(" · ");
}

export function pcapPaceCaption(pace: PcapPace): string {
  return pace === "fast"
    ? "Fast: read as quickly as the accumulator allows — never drops frames."
    : "Realtime: sleep to each record's timestamp (50 ms sleep cap).";
}
