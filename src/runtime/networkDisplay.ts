/**
 * Network view display helpers (SRS_visual_ui.md §5.8, §1.5): only true
 * session/link data and honest empty-state copy — no fabricated ECUs,
 * counters, or topology.
 */

import {
  linkChipLabel,
  sourceKindLabel,
  type CaptureLinkStatus,
  type CaptureSessionInfo,
  type SourceKind,
} from "./captureSource";

/** Honest empty / deferred copy for panels that have no live feed yet. */
export const NETWORK_EMPTY = {
  externalNodes: "no external nodes attached",
  automation: "automation surface arrives v0.7",
  topology: "derived from observed SD traffic — live decode arrives v0.5",
  sdMonitor: "derived from observed SD traffic — live decode arrives v0.5",
  ptp: "derived from observed PTP traffic — live decode arrives v0.5",
} as const;

export const SESSION_STOPPED_HINT = "session stopped — press Start";

export interface ConnectionPanelModel {
  readonly sourceLabel: string;
  readonly address: string | null;
  readonly scenario: string | null;
  readonly running: boolean;
  readonly sessionChipLabel: string;
  readonly linkChipLabel: string | null;
  readonly linkState: CaptureLinkStatus["state"] | null;
  readonly linkDetail: string | null;
  readonly stoppedHint: string | null;
}

/** Builds the Connection panel model from the shared session snapshot. */
export function connectionPanelModel(input: {
  running: boolean;
  sourceKind: SourceKind;
  simAddr: string;
  linkStatus: CaptureLinkStatus | null;
  sessionInfo: CaptureSessionInfo | null;
}): ConnectionPanelModel {
  const { running, sourceKind, simAddr, linkStatus, sessionInfo } = input;
  const address = sourceKind === "sim" ? simAddr : null;
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
    stoppedHint: running ? null : SESSION_STOPPED_HINT,
  };
}
