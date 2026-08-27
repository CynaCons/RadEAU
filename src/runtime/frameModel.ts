/**
 * Shared frame model for the trace pipeline: the single batched event shape
 * (columnar arrays, mirrored by the Rust core's `FrameBatch`), the endpoint
 * and service tables shared with the dev frame generator (PRD §3.8), and the
 * columnar → row projection the Trace view renders.
 */

export interface TraceFrame {
  id: number;
  time: string;
  dir: "rx" | "tx";
  source: string;
  /** Tooltip / full identity (`name (ip)` when the session table is live). */
  sourceTitle: string;
  protocol: string;
  serviceMethod: string;
  name: string;
  type: string;
  session: string;
  length: string;
  payload: string;
  deltaGlobal: string;
  deltaKey: string;
  channel: string;
}

/** The one batched frame event shape — arrays of primitives, never row objects. */
export interface FrameBatchRaw {
  seq: number;
  /** Global frame index. */
  i: number[];
  /** Seconds since session start. */
  t: number[];
  /** Direction: 1 rx, 0 tx. */
  d: number[];
  /** Endpoint index into ENDPOINTS. */
  s: number[];
  /** Protocol class: PROTO_*. */
  p: number[];
  sv: number[];
  m: number[];
  /** Message type: MSG_*. */
  ty: number[];
  /** Session id, -1 when absent. */
  se: number[];
  /** Full wire length incl. Ethernet header. */
  l: number[];
  /** Payload preview bytes. */
  pb: number[][];
}

export const PROTO_SOMEIP = 0;
export const PROTO_SD = 1;
export const PROTO_GPTP = 2;

export const MSG_EVENT = 0;
export const MSG_OFFER = 1;
export const MSG_SYNC = 2;

/** Fallback endpoint table shared with the generator (10.42.0.11..15). */
export const ENDPOINTS: readonly string[] = [
  "10.42.0.11",
  "10.42.0.12",
  "10.42.0.13",
  "10.42.0.14",
  "10.42.0.15",
];

/** Session endpoint row delivered by `capture:session`. */
export interface SessionEndpoint {
  name: string;
  ip: string;
}

/**
 * Live session endpoint table (from `capture:session`), or null to fall back
 * to the static `ENDPOINTS` names-as-ips table used by the dev generator.
 */
let sessionEndpoints: readonly SessionEndpoint[] | null = null;

export function setSessionEndpoints(endpoints: readonly SessionEndpoint[] | null): void {
  sessionEndpoints = endpoints;
}

export function getSessionEndpoints(): readonly SessionEndpoint[] | null {
  return sessionEndpoints;
}

/** Resolved display label + tooltip for a batch endpoint index. */
export function resolveEndpoint(index: number): { label: string; title: string } {
  const fromSession = sessionEndpoints?.[index];
  if (fromSession) {
    // Prefer the port name in the narrow Source column; IP rides in the tooltip.
    if (fromSession.name && fromSession.name !== fromSession.ip) {
      return {
        label: fromSession.name,
        title: `${fromSession.name} (${fromSession.ip})`,
      };
    }
    return { label: fromSession.ip || fromSession.name, title: fromSession.ip || fromSession.name };
  }
  const fallback = ENDPOINTS[index] ?? `ep-${index}`;
  return { label: fallback, title: fallback };
}

interface ServiceDef {
  svc: number;
  method: number;
  srcEp: number;
  name: string;
  eventName: string;
}

const SERVICES: readonly ServiceDef[] = [
  { svc: 0x1101, method: 0x8001, srcEp: 0, name: "CameraObjects", eventName: "ObjectList" },
  { svc: 0x1102, method: 0x8001, srcEp: 1, name: "RadarTargets", eventName: "TargetList" },
  { svc: 0x1103, method: 0x8001, srcEp: 2, name: "LidarClusters", eventName: "ClusterList" },
  { svc: 0x1104, method: 0x8001, srcEp: 3, name: "VehicleDynamics", eventName: "DynamicsState" },
  { svc: 0x1201, method: 0x8001, srcEp: 4, name: "FusedObjects", eventName: "FusedObjectList" },
];

const SERVICE_BY_KEY = new Map<string, ServiceDef>(
  SERVICES.map((s) => [`${s.svc}:${s.method}`, s]),
);

const SD_SERVICE_METHOD = "0xFFFF:0x8100";

function hex4(n: number): string {
  return "0x" + n.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Per-key identity for Δ-per-key / fixed-mode cycle time.
 * SOME/IP keys by (protocol, service, method); SD and gPTP key by
 * (protocol, source endpoint) so each emitting node keeps its own cycle.
 */
export function deltaKeyOf(p: number, sv: number, m: number, s = 0): string {
  if (p === PROTO_SOMEIP) return `${p}:${sv}:${m}`;
  return `${p}:ep${s}`;
}

/**
 * Payload preview hex from snap bytes + wire length. L3 frames carry
 * Eth+IP+UDP overhead (42 bytes); gPTP rides directly on Ethernet (14).
 */
function payloadPreview(pb: readonly number[], wireLen: number, proto: number): string {
  const payloadLen = proto === PROTO_GPTP ? wireLen - 14 : wireLen - 42;
  const shown = Math.max(0, Math.min(pb.length, payloadLen));
  if (shown === 0) return "--";
  let out = "";
  for (let j = 0; j < shown; j += 1) {
    out += pb[j].toString(16).toUpperCase().padStart(2, "0") + (j < shown - 1 ? " " : "");
  }
  return out + (payloadLen > shown ? " …" : "");
}

/** Projects one columnar entry to the row shape the Trace table renders. */
export function projectRow(
  batch: FrameBatchRaw,
  k: number,
  prevT: number | null,
  lastByKey: Map<string, number>,
): TraceFrame {
  const idx = batch.i[k];
  const t = batch.t[k];
  const dir = batch.d[k] === 1 ? "rx" : "tx";
  const ep = resolveEndpoint(batch.s[k]);
  const source = ep.label;
  const sourceTitle = ep.title;
  const proto = batch.p[k];
  const sv = batch.sv[k];
  const m = batch.m[k];
  const ty = batch.ty[k];
  const se = batch.se[k];
  const len = batch.l[k];
  const key = deltaKeyOf(proto, sv, m, batch.s[k]);

  let protocol: string;
  let serviceMethod: string;
  let name: string;
  let type: string;
  if (proto === PROTO_SOMEIP) {
    const def = SERVICE_BY_KEY.get(`${sv}:${m}`);
    protocol = "SOME/IP";
    serviceMethod = `${hex4(sv)}:${hex4(m)}`;
    name = def ? `${def.name}.${def.eventName}` : `Service ${hex4(sv)}`;
    type = ty === MSG_EVENT ? "Event" : `Type ${ty}`;
  } else if (proto === PROTO_SD) {
    protocol = "SD";
    serviceMethod = SD_SERVICE_METHOD;
    name = "OfferService";
    type = "Offer";
  } else {
    protocol = "gPTP";
    serviceMethod = "--";
    name = `Sync · GM ${source}`;
    type = "Sync";
  }

  return {
    id: idx,
    time: t.toFixed(4),
    dir,
    source,
    sourceTitle,
    protocol,
    serviceMethod,
    name,
    type,
    session: se < 0 ? "--" : String(se),
    length: String(len),
    payload: payloadPreview(batch.pb[k], len, proto),
    deltaGlobal: prevT === null ? "--" : (t - prevT).toFixed(4),
    deltaKey: lastByKey.get(key) === undefined ? "--" : (t - (lastByKey.get(key) as number)).toFixed(4),
    channel: "1",
  };
}
