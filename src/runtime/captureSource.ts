/**
 * Capture source picker helpers — pure state logic shared by Settings (choice),
 * Trace (degraded link chip), Network (connection truth), and tests. Mirrors
 * the Rust `SourceSpec` tagged union.
 */

import type { RateProfile } from "./devGenMirror";
import type { SessionEndpoint } from "./frameModel";

export type SourceKind = "devgen" | "sim";

export type CaptureSource =
  | { kind: "devgen"; profile: RateProfile }
  | { kind: "sim"; addr: string };

export type LinkState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "closed";

export interface CaptureLinkStatus {
  state: LinkState;
  detail: string | null;
}

export interface CaptureSessionInfo {
  sourceKind: SourceKind;
  scenario: string | null;
  endpoints: SessionEndpoint[];
}

export const DEFAULT_SIM_ADDR = "127.0.0.1:5560";
export const DEFAULT_DEVGEN_PROFILE: RateProfile = "normal";

/** Link states that count as degraded for Trace's status chip (§4.3). */
const DEGRADED_LINK_STATES: ReadonlySet<LinkState> = new Set([
  "connecting",
  "reconnecting",
  "error",
]);

/** Simulator link is a desktop-only source; browser mode keeps it disabled. */
export function simSourceAvailable(desktop: boolean): boolean {
  return desktop;
}

export function buildCaptureSource(
  kind: SourceKind,
  opts: { profile?: RateProfile; addr?: string } = {},
): CaptureSource {
  if (kind === "sim") {
    return { kind: "sim", addr: (opts.addr ?? DEFAULT_SIM_ADDR).trim() || DEFAULT_SIM_ADDR };
  }
  return { kind: "devgen", profile: opts.profile ?? DEFAULT_DEVGEN_PROFILE };
}

/** Address field is shown only for the simulator source. */
export function showSimAddressField(kind: SourceKind): boolean {
  return kind === "sim";
}

/**
 * Trace shows a link chip only while a session runs on a degraded sim link
 * (connecting / reconnecting / error). Healthy connected and devgen: hidden.
 */
export function showDegradedLinkChip(
  running: boolean,
  kind: SourceKind,
  state: LinkState | null | undefined,
): boolean {
  if (!running || kind !== "sim" || !state) return false;
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
  return kind === "sim" ? "Simulator link" : "Dev generator";
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
  return kind === "sim"
    ? "Start capture · simulator link"
    : "Start capture · dev generator";
}
