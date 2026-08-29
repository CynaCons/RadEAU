/**
 * Capture source picker helpers — pure state logic shared by Settings (choice),
 * Trace (degraded link chip), Network (connection truth), and tests. Mirrors
 * the Rust `SourceSpec` tagged union.
 */

import type { RateProfile } from "./devGenMirror";
import type { SessionEndpoint } from "./frameModel";
import { PROTO_CLASS_COUNT } from "./wireCodes";

export type SourceKind = "devgen" | "sim" | "pcap" | "pcapStream";

export type PcapPace = "realtime" | "fast";

export type CaptureSource =
  | { kind: "devgen"; profile: RateProfile }
  | { kind: "sim"; addr: string }
  | { kind: "pcap"; path: string; pace: PcapPace }
  | { kind: "pcapStream"; addr: string };

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
}

/** Sum of loss counters that drive the Trace `Dropped · n` chip. */
export function lossTotal(stats: CaptureStats): number {
  return stats.accumulatorDropped + stats.gapDropped + stats.kernelDropped;
}

/** Empty per-class vector for browser-mirror / test fixtures. */
export function emptyByClass(): number[] {
  return new Array(PROTO_CLASS_COUNT).fill(0);
}

export const DEFAULT_SIM_ADDR = "127.0.0.1:5560";
export const DEFAULT_DEVGEN_PROFILE: RateProfile = "normal";
export const DEFAULT_PCAP_PACE: PcapPace = "realtime";

/** Link states that count as degraded for Trace's status chip (§4.3). */
const DEGRADED_LINK_STATES: ReadonlySet<LinkState> = new Set([
  "connecting",
  "reconnecting",
  "error",
]);

/** Sources that surface a Trace degraded-link chip (sim + pcap stream). */
const DEGRADED_LINK_KINDS: ReadonlySet<SourceKind> = new Set(["sim", "pcapStream"]);

/** Simulator link is a desktop-only source; browser mode keeps it disabled. */
export function simSourceAvailable(desktop: boolean): boolean {
  return desktop;
}

/** pcap file / stream sources are desktop-only. */
export function pcapSourceAvailable(desktop: boolean): boolean {
  return desktop;
}

export function buildCaptureSource(
  kind: SourceKind,
  opts: {
    profile?: RateProfile;
    addr?: string;
    path?: string;
    pace?: PcapPace;
    streamAddr?: string;
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

/**
 * Trace shows a link chip only while a session runs on a degraded sim or
 * pcap-stream link (connecting / reconnecting / error). Closed is never shown
 * on Trace (CP-005); healthy connected and other sources: hidden.
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
    default:
      return "Dev generator";
  }
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
    default:
      return "Start capture · dev generator";
  }
}

export function pcapPaceCaption(pace: PcapPace): string {
  return pace === "fast"
    ? "Fast: read as quickly as the accumulator allows — never drops frames."
    : "Realtime: sleep to each record's timestamp (50 ms sleep cap).";
}
