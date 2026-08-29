/**
 * Network view display helpers (SRS_visual_ui.md §5.8, §1.5): only true
 * session/link data and honest empty-state copy — no fabricated ECUs,
 * counters, or topology.
 */

import {
  linkChipLabel,
  lossTotal,
  sourceKindLabel,
  type CaptureLinkStatus,
  type CaptureSessionInfo,
  type CaptureStats,
  type SourceKind,
  type TimestampSource,
} from "./captureSource";
import { PROTO_LABELS } from "./wireCodes";

/** Honest empty / deferred copy for panels that have no live feed yet. */
export const NETWORK_EMPTY = {
  externalNodes: "no external nodes attached",
  automation: "automation surface arrives v0.7",
  topology: "derived from observed SD traffic — live decode arrives v0.5",
  sdMonitor: "derived from observed SD traffic — live decode arrives v0.5",
  ptp: "derived from observed PTP traffic — live decode arrives v0.5",
} as const;

export const SESSION_STOPPED_HINT = "session stopped — press Start";

export interface ConnectionStatsModel {
  readonly received: number;
  readonly emitted: number;
  readonly dropped: number;
  readonly gaps: number;
  readonly malformed: number;
  /** Non-zero classes only, e.g. "SOME/IP 12,340 · SD 51 · gPTP 800". */
  readonly classLine: string | null;
  /** "last session" when stopped with stats present; otherwise null. */
  readonly caption: string | null;
}

export interface ConnectionPanelModel {
  readonly sourceLabel: string;
  readonly address: string | null;
  readonly scenario: string | null;
  readonly running: boolean;
  readonly sessionChipLabel: string;
  readonly linkChipLabel: string | null;
  readonly linkState: CaptureLinkStatus["state"] | null;
  readonly linkDetail: string | null;
  readonly timestampSource: TimestampSource | null;
  readonly stoppedHint: string | null;
  /** Null when there are no stats to render. */
  readonly stats: ConnectionStatsModel | null;
}

/** Formats only non-zero byClass entries with PROTO_LABELS. */
export function formatClassCounts(byClass: readonly number[]): string | null {
  const parts: string[] = [];
  for (let i = 0; i < byClass.length && i < PROTO_LABELS.length; i += 1) {
    const n = byClass[i];
    if (n > 0) parts.push(`${PROTO_LABELS[i]} ${n.toLocaleString("en-US")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function sourceAddress(input: {
  sourceKind: SourceKind;
  simAddr: string;
  pcapPath?: string;
  pcapStreamAddr?: string;
  liveInterfaceId?: string;
  /** Optional friendly label (description ?? name) for live NIC display. */
  liveInterfaceLabel?: string | null;
}): string | null {
  switch (input.sourceKind) {
    case "sim":
      return input.simAddr;
    case "pcap": {
      const p = (input.pcapPath ?? "").trim();
      return p || null;
    }
    case "pcapStream": {
      const a = (input.pcapStreamAddr ?? "").trim();
      return a || null;
    }
    case "live": {
      const label = (input.liveInterfaceLabel ?? "").trim();
      if (label) return label;
      const id = (input.liveInterfaceId ?? "").trim();
      return id || null;
    }
    default:
      return null;
  }
}

/** Builds the Connection panel model from the shared session snapshot. */
export function connectionPanelModel(input: {
  running: boolean;
  sourceKind: SourceKind;
  simAddr: string;
  pcapPath?: string;
  pcapStreamAddr?: string;
  liveInterfaceId?: string;
  liveInterfaceLabel?: string | null;
  linkStatus: CaptureLinkStatus | null;
  sessionInfo: CaptureSessionInfo | null;
  stats?: CaptureStats | null;
}): ConnectionPanelModel {
  const { running, sourceKind, linkStatus, sessionInfo, stats = null } = input;
  const address = sourceAddress(input);
  const scenario = sessionInfo?.scenario ?? null;
  return {
    sourceLabel: sourceKindLabel(sourceKind),
    address,
    scenario,
    running,
    sessionChipLabel: running ? "Session running" : "Session stopped",
    linkChipLabel: linkStatus ? linkChipLabel(linkStatus.state) : null,
    linkState: linkStatus?.state ?? null,
    linkDetail: linkStatus?.detail ?? null,
    timestampSource: sessionInfo?.timestampSource ?? null,
    stoppedHint: running ? null : SESSION_STOPPED_HINT,
    stats: stats
      ? {
          received: stats.received,
          emitted: stats.emitted,
          dropped: lossTotal(stats),
          gaps: stats.gapRecords,
          malformed: stats.malformed,
          classLine: formatClassCounts(stats.byClass),
          caption: running ? null : "last session",
        }
      : null,
  };
}
