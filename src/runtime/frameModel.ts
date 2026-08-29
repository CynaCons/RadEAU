/**
 * Shared frame model for the trace pipeline: the single batched event shape
 * (columnar arrays, mirrored by the Rust core's `FrameBatch`), the endpoint
 * and service tables shared with the dev frame generator (PRD §3.8), and the
 * columnar → row projection the Trace view renders.
 *
 * SOME/IP display names resolve catalog-first via `setCatalogNames` (fed by
 * catalogStore); the static SERVICES table is the unloaded / browser fallback.
 * Wire codes live in `wireCodes.ts` (byte-for-byte mirror of codes.rs).
 */

import {
  ARP_TY_REPLY,
  ARP_TY_REQUEST,
  DIR_RX,
  DIR_TX,
  ENDPOINT_OVERFLOW,
  GPTP_TY_ANNOUNCE,
  GPTP_TY_FOLLOW_UP,
  GPTP_TY_PDELAY_REQ,
  GPTP_TY_PDELAY_RESP,
  GPTP_TY_PDELAY_RESP_FOLLOW_UP,
  GPTP_TY_SIGNALING,
  GPTP_TY_SYNC,
  PROTO_ARP,
  PROTO_GPTP,
  PROTO_ICMP,
  PROTO_IPV4_OTHER,
  PROTO_IPV6,
  PROTO_MALFORMED,
  PROTO_OTHER,
  PROTO_SD,
  PROTO_SOMEIP,
  PROTO_TCP,
  PROTO_UDP,
  SD_TY_EMPTY,
  SD_TY_FIND,
  SD_TY_OFFER,
  SD_TY_STOP_OFFER,
  SD_TY_STOP_SUBSCRIBE,
  SD_TY_SUBSCRIBE,
  SD_TY_SUBSCRIBE_ACK,
  SD_TY_SUBSCRIBE_NACK,
  SOMEIP_TY_ERROR,
  SOMEIP_TY_NOTIFICATION,
  SOMEIP_TY_REQUEST,
  SOMEIP_TY_REQUEST_NO_RETURN,
  SOMEIP_TY_RESPONSE,
  protoLabel,
} from "./wireCodes";

export interface TraceFrame {
  id: number;
  /** Session-relative seconds (raw); Time column formats from this. */
  tS: number;
  /** Default session-relative display (`tS.toFixed(4)`). */
  time: string;
  dir: "rx" | "tx" | "unknown";
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
  /** Display / Δ-per-key identity, computed once in projectRow. */
  key: string;
  /** Raw protocol class (PROTO_*). */
  proto: number;
  sv: number;
  m: number;
  /** Endpoint index from the batch `s` column. */
  srcEp: number;
  ty: number;
  sa: number;
  da: number;
  sm: number;
  vl: number;
}

/** The one batched frame event shape — arrays of primitives, never row objects. */
export interface FrameBatchRaw {
  seq: number;
  /** Global frame index. */
  i: number[];
  /** Seconds since session start. */
  t: number[];
  /** Direction: DIR_* . */
  d: number[];
  /** Endpoint index into the session endpoint table. */
  s: number[];
  /** Protocol class: PROTO_*. */
  p: number[];
  sv: number[];
  m: number[];
  /** Message type: per-class TY_* tables. */
  ty: number[];
  /** Session id, -1 when absent. */
  se: number[];
  /** Full wire length incl. Ethernet header. */
  l: number[];
  /** Payload preview bytes (starting at `po`). */
  pb: number[][];
  /** Source IPv4 as u32 (0 when absent). */
  sa: number[];
  /** Destination IPv4 as u32 (0 when absent). */
  da: number[];
  /** Source MAC as a 48-bit integer. */
  sm: number[];
  /** VLAN id (-1 untagged). */
  vl: number[];
  /** Offset of the preview/payload start. */
  po: number[];
}

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

/** Catalog-resolved (service, method) → display names; null when unloaded. */
export interface CatalogNameEntry {
  serviceName: string;
  eventName: string;
}

let catalogNames: ReadonlyMap<string, CatalogNameEntry> | null = null;

/**
 * Installs or clears the catalog name map. `null` restores the static
 * SERVICES fallback (browser / unloaded). Non-null means the catalog is
 * loaded — unknown ids stay honest as `Service 0x…`.
 */
export function setCatalogNames(
  names: ReadonlyMap<string, CatalogNameEntry> | null,
): void {
  catalogNames = names;
}

export function getCatalogNames(): ReadonlyMap<string, CatalogNameEntry> | null {
  return catalogNames;
}

export function isCatalogNamesLoaded(): boolean {
  return catalogNames !== null;
}

/** IPv4 u32 (network byte order) → dotted decimal. */
export function ipv4String(n: number): string {
  const v = n >>> 0;
  return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
}

/**
 * 48-bit MAC integer → `aa:bb:cc:dd:ee:ff`. Uses Math.floor division (not
 * bit ops) above 32 bits so values near 2^48 stay exact in JS numbers.
 */
export function macString(n: number): string {
  let v = n;
  const parts: string[] = new Array(6);
  for (let i = 5; i >= 0; i -= 1) {
    parts[i] = (Math.floor(v) % 256).toString(16).padStart(2, "0");
    v = Math.floor(v / 256);
  }
  return parts.join(":");
}

/** Resolved display label + tooltip for a batch endpoint index. */
export function resolveEndpoint(index: number): { label: string; title: string } {
  if (index === ENDPOINT_OVERFLOW) {
    return { label: "other", title: "endpoint table full" };
  }
  const fromSession = sessionEndpoints?.[index];
  if (fromSession) {
    // MAC-only entries carry an empty ip — render the name alone.
    if (!fromSession.ip) {
      const name = fromSession.name || "ep";
      return { label: name, title: name };
    }
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

function hex4(n: number): string {
  return "0x" + n.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Catalog-first SOME/IP name. Unknown ids stay honest as `Service 0x…`
 * when the catalog is loaded; otherwise the static SERVICES table fills in.
 */
export function resolveSomeIpName(sv: number, m: number): string {
  if (catalogNames !== null) {
    const fromCatalog = catalogNames.get(`${sv}:${m}`);
    if (fromCatalog) return `${fromCatalog.serviceName}.${fromCatalog.eventName}`;
    return `Service ${hex4(sv)}`;
  }
  const def = SERVICE_BY_KEY.get(`${sv}:${m}`);
  return def ? `${def.name}.${def.eventName}` : `Service ${hex4(sv)}`;
}

/** Source-address key for fixed-mode / Δ-per-key: IPv4 when present, else MAC. */
export function srcAddrKey(sa: number, sm: number): number {
  return sa !== 0 ? sa : sm;
}

/**
 * Per-row identity for Δ-per-key / fixed-mode collapse (SRS_visual_ui §5.2).
 * Computed once in projectRow and stored on TraceFrame.key.
 */
export function frameKey(batch: FrameBatchRaw, k: number): string {
  const p = batch.p[k];
  const sv = batch.sv[k];
  const m = batch.m[k];
  const ty = batch.ty[k];
  const sa = batch.sa[k];
  const da = batch.da[k];
  const sm = batch.sm[k];
  const addr = srcAddrKey(sa, sm);
  switch (p) {
    case PROTO_SOMEIP:
      return `0:${sv}:${m}`;
    case PROTO_SD:
      return `1:${addr}`;
    case PROTO_GPTP:
      return `2:${addr}:${ty}`;
    case PROTO_ARP:
      return `3:${addr}`;
    case PROTO_UDP:
    case PROTO_TCP:
      return `${p}:${sa}:${sv}>${da}:${m}`;
    case PROTO_ICMP:
      return `6:${sa}>${da}`;
    case PROTO_IPV6:
    case PROTO_IPV4_OTHER:
    case PROTO_OTHER:
      return `${p}:${sm}:${sv}`;
    case PROTO_MALFORMED:
      return `11:${sm}`;
    default:
      return `${p}:${addr}`;
  }
}

function someIpTypeLabel(ty: number): string {
  switch (ty) {
    case SOMEIP_TY_NOTIFICATION:
      return "Notification";
    case SOMEIP_TY_REQUEST:
      return "Request";
    case SOMEIP_TY_REQUEST_NO_RETURN:
      return "Request-no-return";
    case SOMEIP_TY_RESPONSE:
      return "Response";
    case SOMEIP_TY_ERROR:
      return "Error";
    default:
      return `Type ${ty}`;
  }
}

function sdKindLabel(ty: number): string {
  switch (ty) {
    case SD_TY_OFFER:
      return "Offer";
    case SD_TY_FIND:
      return "Find";
    case SD_TY_STOP_OFFER:
      return "StopOffer";
    case SD_TY_SUBSCRIBE:
      return "Subscribe";
    case SD_TY_STOP_SUBSCRIBE:
      return "StopSubscribe";
    case SD_TY_SUBSCRIBE_ACK:
      return "SubscribeAck";
    case SD_TY_SUBSCRIBE_NACK:
      return "SubscribeNack";
    case SD_TY_EMPTY:
      return "Empty";
    default:
      return `Type ${ty}`;
  }
}

function gptpTypeLabel(ty: number): string {
  switch (ty) {
    case GPTP_TY_SYNC:
      return "Sync";
    case GPTP_TY_FOLLOW_UP:
      return "Follow_Up";
    case GPTP_TY_PDELAY_REQ:
      return "Pdelay_Req";
    case GPTP_TY_PDELAY_RESP:
      return "Pdelay_Resp";
    case GPTP_TY_PDELAY_RESP_FOLLOW_UP:
      return "Pdelay_Resp_Follow_Up";
    case GPTP_TY_ANNOUNCE:
      return "Announce";
    case GPTP_TY_SIGNALING:
      return "Signaling";
    default:
      return `Type ${ty}`;
  }
}

function arpTypeLabel(ty: number): string {
  switch (ty) {
    case ARP_TY_REQUEST:
      return "Request";
    case ARP_TY_REPLY:
      return "Reply";
    default:
      return `Type ${ty}`;
  }
}

function dirOf(d: number): "rx" | "tx" | "unknown" {
  if (d === DIR_RX) return "rx";
  if (d === DIR_TX) return "tx";
  return "unknown";
}

/**
 * Payload preview hex from snap bytes + wire length, starting at the
 * core-supplied payload offset (`po`).
 */
function payloadPreview(pb: readonly number[], wireLen: number, po: number): string {
  const payloadLen = Math.max(0, wireLen - po);
  const shown = Math.max(0, Math.min(pb.length, payloadLen));
  if (shown === 0) return "--";
  let out = "";
  for (let j = 0; j < shown; j += 1) {
    out += pb[j].toString(16).toUpperCase().padStart(2, "0") + (j < shown - 1 ? " " : "");
  }
  return out + (payloadLen > shown ? " …" : "");
}

/** Projects Name / Type / Service:Method per protocol class (SRS §5.2). */
function classDisplay(
  proto: number,
  sv: number,
  m: number,
  ty: number,
  sa: number,
  da: number,
  len: number,
  source: string,
): { protocol: string; serviceMethod: string; name: string; type: string } {
  const protocol = protoLabel(proto);
  switch (proto) {
    case PROTO_SOMEIP: {
      return {
        protocol,
        serviceMethod: `${hex4(sv)}:${hex4(m)}`,
        name: resolveSomeIpName(sv, m),
        type: someIpTypeLabel(ty),
      };
    }
    case PROTO_SD: {
      const kind = sdKindLabel(ty);
      return {
        protocol,
        serviceMethod: `${hex4(sv)}:${hex4(m)}`,
        name: `${kind} · ${source}`,
        type: kind,
      };
    }
    case PROTO_GPTP: {
      const gptpTy = gptpTypeLabel(ty);
      return {
        protocol,
        serviceMethod: "--",
        name: `${gptpTy} · ${source}`,
        type: gptpTy,
      };
    }
    case PROTO_ARP: {
      const arpTy = arpTypeLabel(ty);
      const name =
        ty === ARP_TY_REQUEST
          ? `who-has ${ipv4String(da)}`
          : ty === ARP_TY_REPLY
            ? `${ipv4String(sa)} is-at`
            : arpTy;
      return { protocol, serviceMethod: "--", name, type: arpTy };
    }
    case PROTO_UDP:
    case PROTO_TCP:
      return {
        protocol,
        serviceMethod: `${sv}:${m}`,
        name: `${ipv4String(sa)}:${sv} → ${ipv4String(da)}:${m}`,
        type: "",
      };
    case PROTO_ICMP:
      return {
        protocol,
        serviceMethod: "--",
        name: `type ${sv} code ${m}`,
        type: "",
      };
    case PROTO_IPV6:
      return {
        protocol,
        serviceMethod: "--",
        name: `next header ${sv}`,
        type: "",
      };
    case PROTO_IPV4_OTHER:
      return {
        protocol,
        serviceMethod: "--",
        name: `protocol ${sv}`,
        type: "",
      };
    case PROTO_OTHER:
      return {
        protocol,
        serviceMethod: "--",
        name: `EtherType ${hex4(sv)}`,
        type: "",
      };
    case PROTO_MALFORMED:
      return {
        protocol,
        serviceMethod: "--",
        name: `runt · ${len} bytes`,
        type: "",
      };
    default:
      return { protocol, serviceMethod: "--", name: "", type: "" };
  }
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
  const dir = dirOf(batch.d[k]);
  const srcEp = batch.s[k];
  const ep = resolveEndpoint(srcEp);
  const source = ep.label;
  const sourceTitle = ep.title;
  const proto = batch.p[k];
  const sv = batch.sv[k];
  const m = batch.m[k];
  const ty = batch.ty[k];
  const se = batch.se[k];
  const len = batch.l[k];
  const sa = batch.sa[k];
  const da = batch.da[k];
  const sm = batch.sm[k];
  const vl = batch.vl[k];
  const po = batch.po[k];
  const key = frameKey(batch, k);

  const { protocol, serviceMethod, name, type } = classDisplay(
    proto,
    sv,
    m,
    ty,
    sa,
    da,
    len,
    source,
  );

  return {
    id: idx,
    tS: t,
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
    payload: payloadPreview(batch.pb[k], len, po),
    deltaGlobal: prevT === null ? "--" : (t - prevT).toFixed(4),
    deltaKey: lastByKey.get(key) === undefined ? "--" : (t - (lastByKey.get(key) as number)).toFixed(4),
    channel: "1",
    key,
    proto,
    sv,
    m,
    srcEp,
    ty,
    sa,
    da,
    sm,
    vl,
  };
}
