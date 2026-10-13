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
import type { AnalysisReport, AnalysisStats } from "./desktop";
import { PROTO_LABELS } from "./wireCodes";

/** Honest empty / deferred copy for panels that have no live feed yet. */
export const NETWORK_EMPTY = {
  externalNodes: "no external nodes attached",
  // NV-004: topology is present only as honest deferred copy until passive SD graphing ships.
  topology: "derived from observed SD traffic — live decode arrives v0.5",
  // NV-004: SD state-machine panel is an honest deferred state, not fabricated service data.
  sdMonitor: "derived from observed SD traffic — live decode arrives v0.5",
  // NV-004: PTP status panel is an honest deferred state until offset charts are wired.
  ptp: "derived from observed PTP traffic — live decode arrives v0.5",
  analysis: "run Analyze buffered trace to show this snapshot table",
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
    const label = PROTO_LABELS[i];
    if (n !== undefined && label !== undefined && n > 0) {
      parts.push(`${label} ${n.toLocaleString("en-US")}`);
    }
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
    case "devgen":
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

export interface EndpointAnalysisRow {
  readonly endpoint: string;
  readonly kind: "IPv4" | "MAC";
  readonly framesSent: string;
  readonly bytesSent: string;
  readonly protocols: string;
}

export interface ConversationAnalysisRow {
  readonly peers: string;
  readonly transport: string;
  readonly frames: string;
  readonly bytes: string;
  readonly span: string;
}

export interface SomeIpAnalysisRow {
  readonly testId: string;
  readonly serviceMethod: string;
  readonly name: string;
  readonly sender: string;
  readonly kind: string;
  readonly count: string;
  readonly periodMean: string;
  readonly periodP99: string;
  readonly latencyP99: string;
  readonly gaps: string;
}

export interface SdAnalysisRow {
  readonly serviceInstance: string;
  readonly sender: string;
  readonly offers: string;
  readonly stopOffers: string;
  readonly periodMean: string;
  readonly ttl: string;
  readonly reboots: string;
}

export interface PtpAnalysisRow {
  readonly sender: string;
  readonly sync: string;
  readonly followUp: string;
  readonly pdelay: string;
  readonly announce: string;
  readonly syncMean: string;
  readonly grandmaster: string;
}

export interface NetworkAnalysisTables {
  readonly caption: string;
  readonly endpoints: EndpointAnalysisRow[];
  readonly conversations: ConversationAnalysisRow[];
  readonly someip: SomeIpAnalysisRow[];
  readonly sd: SdAnalysisRow[];
  readonly ptp: PtpAnalysisRow[];
}

export function hexId(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function networkAnalysisCaption(report: AnalysisReport): string {
  const frames = report.overview?.frames ?? 0;
  const generated = new Date(report.generatedAtMs);
  const hh = generated.getHours().toString().padStart(2, "0");
  const mm = generated.getMinutes().toString().padStart(2, "0");
  const ss = generated.getSeconds().toString().padStart(2, "0");
  return `Snapshot of ${frames.toLocaleString("en-US")} frames · ${hh}:${mm}:${ss}`;
}

export function formatNsAsMs(ns: number | null | undefined): string {
  if (ns === null || ns === undefined || !Number.isFinite(ns)) return "—";
  return `${(ns / 1_000_000).toFixed(4)} ms`;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function span(firstNs: number, lastNs: number): string {
  if (!Number.isFinite(firstNs) || !Number.isFinite(lastNs)) return "—";
  return `${formatNsAsMs(firstNs)} - ${formatNsAsMs(lastNs)}`;
}

function statsMean(stats: AnalysisStats | undefined): string {
  return formatNsAsMs(stats?.meanNs);
}

function statsP99(stats: AnalysisStats | undefined): string {
  return formatNsAsMs(stats?.p99Ns);
}

function countsKind(counts: {
  request: number;
  requestNoReturn: number;
  notification: number;
  response: number;
  error: number;
}): string {
  const parts = [
    counts.notification > 0 ? `notification ${count(counts.notification)}` : null,
    counts.request > 0 ? `request ${count(counts.request)}` : null,
    counts.requestNoReturn > 0
      ? `request no return ${count(counts.requestNoReturn)}`
      : null,
    counts.response > 0 ? `response ${count(counts.response)}` : null,
    counts.error > 0 ? `error ${count(counts.error)}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function countsTotal(counts: {
  request: number;
  requestNoReturn: number;
  notification: number;
  response: number;
  error: number;
}): number {
  return (
    counts.request +
    counts.requestNoReturn +
    counts.notification +
    counts.response +
    counts.error
  );
}

export function buildNetworkAnalysisTables(
  report: AnalysisReport,
): NetworkAnalysisTables {
  return {
    caption: networkAnalysisCaption(report),
    endpoints:
      report.overview?.endpoints.map((row) => ({
        endpoint: row.endpoint,
        kind: row.kind === "ipv4" ? "IPv4" : "MAC",
        framesSent: count(row.framesSent),
        bytesSent: count(row.bytesSent),
        protocols: row.protocols.join(", ") || "—",
      })) ?? [],
    conversations:
      report.overview?.conversations.map((row) => ({
        peers: `${row.a} <-> ${row.b}`,
        transport: row.transport,
        frames: count(row.frames),
        bytes: count(row.bytes),
        span: span(row.firstNs, row.lastNs),
      })) ?? [],
    someip:
      report.someip?.services.flatMap((svc) => {
        const serviceMethod = `${hexId(svc.service)} / ${hexId(svc.method)}`;
        const name =
          [svc.serviceName, svc.methodName].filter(Boolean).join(" / ") || "—";
        const senders =
          svc.senders.length > 0
            ? svc.senders
            : [{ sender: "—", count: countsTotal(svc.counts), gaps: [], gapsTotal: 0 }];
        return senders.map((sender) => ({
          testId: `network-someip-row-${hexId(svc.service).toLowerCase()}-${hexId(svc.method).toLowerCase()}`,
          serviceMethod,
          name,
          sender: sender.sender,
          kind: countsKind(svc.counts),
          count: count(sender.count),
          periodMean: statsMean(sender.period),
          periodP99: statsP99(sender.period),
          latencyP99: statsP99(svc.latency),
          gaps: count(sender.gapsTotal),
        }));
      }) ?? [],
    sd:
      report.sd?.instances.map((row) => ({
        serviceInstance: `${hexId(row.service)} / ${hexId(row.instance)}`,
        sender: row.sender,
        offers: count(row.offers),
        stopOffers: count(row.stopOffers),
        periodMean: statsMean(row.period),
        ttl: `${row.lastTtl}s`,
        reboots: count(row.reboots),
      })) ?? [],
    ptp:
      report.ptp?.senders.map((row) => ({
        sender: row.sender,
        sync: count(row.sync),
        followUp: count(row.followUp),
        pdelay: `${count(row.pdelayReq)} / ${count(row.pdelayResp)}`,
        announce: count(row.announce),
        syncMean: statsMean(row.syncPeriod),
        grandmaster: row.grandmaster ?? "—",
      })) ?? [],
  };
}
