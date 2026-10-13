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
  DHCP_TY_V6_OFFSET,
  DIR_RX,
  DIR_TX,
  DNS_TY_LLMNR_QUERY,
  DNS_TY_LLMNR_RESPONSE,
  DNS_TY_MDNS_QUERY,
  DNS_TY_MDNS_RESPONSE,
  DNS_TY_QUERY,
  DNS_TY_RESPONSE,
  DOIP_TY_ALIVE_REQ,
  DOIP_TY_ALIVE_RES,
  DOIP_TY_DIAG,
  DOIP_TY_DIAG_ACK,
  DOIP_TY_DIAG_NACK,
  DOIP_TY_ENTITY_STATUS_REQ,
  DOIP_TY_ENTITY_STATUS_RES,
  DOIP_TY_HEADER_NACK,
  DOIP_TY_OTHER,
  DOIP_TY_POWER_MODE_REQ,
  DOIP_TY_POWER_MODE_RES,
  DOIP_TY_ROUTING_ACT_REQ,
  DOIP_TY_ROUTING_ACT_RES,
  DOIP_TY_VEHICLE_ANNOUNCE,
  DOIP_TY_VEHICLE_ID_REQ,
  DOIP_TY_VEHICLE_ID_REQ_EID,
  DOIP_TY_VEHICLE_ID_REQ_VIN,
  ENDPOINT_OVERFLOW,
  GPTP_TY_ANNOUNCE,
  GPTP_TY_FOLLOW_UP,
  GPTP_TY_PDELAY_REQ,
  GPTP_TY_PDELAY_RESP,
  GPTP_TY_PDELAY_RESP_FOLLOW_UP,
  GPTP_TY_SIGNALING,
  GPTP_TY_SYNC,
  HTTP_TY_REQUEST,
  HTTP_TY_RESPONSE,
  PROTO_ARP,
  PROTO_AVTP,
  PROTO_DHCP,
  PROTO_DNS,
  PROTO_DOIP,
  PROTO_EAPOL,
  PROTO_GPTP,
  PROTO_HTTP,
  PROTO_ICMP,
  PROTO_ICMPV6,
  PROTO_IGMP,
  PROTO_IPV4_OTHER,
  PROTO_IPV6,
  PROTO_LLDP,
  PROTO_MACSEC,
  PROTO_MALFORMED,
  PROTO_NTP,
  PROTO_OTHER,
  PROTO_PTP,
  PROTO_SCTP,
  PROTO_SD,
  PROTO_SNMP,
  PROTO_SOMEIP,
  PROTO_SSDP,
  PROTO_SSH,
  PROTO_TCP,
  PROTO_TFTP,
  PROTO_TLS,
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
  SSDP_TY_MSEARCH,
  SSDP_TY_NOTIFY,
  SSDP_TY_RESPONSE,
  SSH_TY_BANNER,
  SSH_TY_PACKET,
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
  /** Session id (SOME/IP) or secondary id (§7: qtype, status, handshake…). */
  se: number;
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

/** DoIP payload-type display names (SRS_protocols §6 / SRS_visual_ui §5.2). */
export const DOIP_TYPE_NAMES: Readonly<Record<number, string>> = {
  [DOIP_TY_HEADER_NACK]: "Header NACK",
  [DOIP_TY_VEHICLE_ID_REQ]: "Vehicle Identification Request",
  [DOIP_TY_VEHICLE_ID_REQ_EID]: "Vehicle Identification Request (EID)",
  [DOIP_TY_VEHICLE_ID_REQ_VIN]: "Vehicle Identification Request (VIN)",
  [DOIP_TY_VEHICLE_ANNOUNCE]: "Vehicle Announcement",
  [DOIP_TY_ROUTING_ACT_REQ]: "Routing Activation Request",
  [DOIP_TY_ROUTING_ACT_RES]: "Routing Activation Response",
  [DOIP_TY_ALIVE_REQ]: "Alive Check Request",
  [DOIP_TY_ALIVE_RES]: "Alive Check Response",
  [DOIP_TY_ENTITY_STATUS_REQ]: "Entity Status Request",
  [DOIP_TY_ENTITY_STATUS_RES]: "Entity Status Response",
  [DOIP_TY_POWER_MODE_REQ]: "Power Mode Request",
  [DOIP_TY_POWER_MODE_RES]: "Power Mode Response",
  [DOIP_TY_DIAG]: "Diagnostic Message",
  [DOIP_TY_DIAG_ACK]: "Diagnostic Message ACK",
  [DOIP_TY_DIAG_NACK]: "Diagnostic Message NACK",
  [DOIP_TY_OTHER]: "DoIP (unknown type)",
};

/** UDS service-id names for DoIP 0x8001 Type column (SRS_protocols §6). */
export const UDS_SID_NAMES: Readonly<Record<number, string>> = {
  0x10: "DiagnosticSessionControl",
  0x11: "ECUReset",
  0x14: "ClearDiagnosticInformation",
  0x19: "ReadDTCInformation",
  0x22: "ReadDataByIdentifier",
  0x27: "SecurityAccess",
  0x28: "CommunicationControl",
  0x2e: "WriteDataByIdentifier",
  0x31: "RoutineControl",
  0x34: "RequestDownload",
  0x36: "TransferData",
  0x37: "RequestTransferExit",
  0x3e: "TesterPresent",
  0x85: "ControlDTCSetting",
};

/**
 * DoIP Type-column label from the UDS SID in `se` (−1 when absent).
 * Response bit (0x40) folds onto the named request; 0x7F is NRC.
 */
export function udsTypeLabel(se: number): string {
  if (se < 0) return "--";
  if (se === 0x7f) return "NRC";
  if ((se & 0x40) !== 0) {
    const baseName = UDS_SID_NAMES[se & ~0x40];
    if (baseName) return `${baseName} response`;
  }
  const name = UDS_SID_NAMES[se];
  if (name) return name;
  return `SID 0x${se.toString(16).toUpperCase().padStart(2, "0")}`;
}

function isDoipDiagnostic(ty: number): boolean {
  return ty === DOIP_TY_DIAG || ty === DOIP_TY_DIAG_ACK || ty === DOIP_TY_DIAG_NACK;
}

/** ICMPv6 type names (SRS_protocols §7). */
export const ICMPV6_TYPE_NAMES: Readonly<Record<number, string>> = {
  1: "Destination Unreachable",
  2: "Packet Too Big",
  3: "Time Exceeded",
  4: "Parameter Problem",
  128: "Echo Request",
  129: "Echo Reply",
  130: "MLD Query",
  131: "MLD Report",
  132: "MLD Done",
  133: "Router Solicitation",
  134: "Router Advertisement",
  135: "Neighbor Solicitation",
  136: "Neighbor Advertisement",
  137: "Redirect",
  143: "MLDv2 Report",
};

/** IGMP type names (wire type byte). */
export const IGMP_TYPE_NAMES: Readonly<Record<number, string>> = {
  0x11: "Membership Query",
  0x12: "v1 Report",
  0x16: "v2 Report",
  0x17: "Leave Group",
  0x22: "v3 Report",
};

/** DHCPv4 option-53 message kinds. */
export const DHCP_V4_TYPE_NAMES: Readonly<Record<number, string>> = {
  1: "Discover",
  2: "Offer",
  3: "Request",
  4: "Decline",
  5: "Ack",
  6: "Nak",
  7: "Release",
  8: "Inform",
};

/** DHCPv6 message types (ty − DHCP_TY_V6_OFFSET). */
export const DHCP_V6_TYPE_NAMES: Readonly<Record<number, string>> = {
  1: "Solicit",
  2: "Advertise",
  3: "Request",
  4: "Confirm",
  5: "Renew",
  6: "Rebind",
  7: "Reply",
  8: "Release",
  9: "Decline",
  10: "Reconfigure",
  11: "Information-request",
};

/** DNS / mDNS / LLMNR first-question type names (`se`). */
export const DNS_QTYPE_NAMES: Readonly<Record<number, string>> = {
  1: "A",
  2: "NS",
  5: "CNAME",
  6: "SOA",
  12: "PTR",
  15: "MX",
  16: "TXT",
  28: "AAAA",
  33: "SRV",
  255: "ANY",
  257: "CAA",
};

/** DNS response code names (`se` when ty is a response). */
export const DNS_RCODE_NAMES: Readonly<Record<number, string>> = {
  0: "NoError",
  1: "FormErr",
  2: "ServFail",
  3: "NXDomain",
  4: "NotImp",
  5: "Refused",
};

/** NTP mode names (`ty`). */
export const NTP_MODE_NAMES: Readonly<Record<number, string>> = {
  1: "symmetric",
  2: "symmetric",
  3: "client",
  4: "server",
  5: "broadcast",
  6: "control",
  7: "private",
};

/** AVTP subtype names (`ty`). */
export const AVTP_SUBTYPE_NAMES: Readonly<Record<number, string>> = {
  0x00: "61883/IIDC",
  0x01: "MMA",
  0x02: "AAF",
  0x03: "CVF",
  0x04: "CRF",
  0x05: "TSCF",
  0x06: "SVF",
  0x07: "RVF",
  0x6e: "AEF",
  0x7a: "control/ACF",
  0x7f: "VSF",
};

/** EAPOL packet-type names (`ty`). */
export const EAPOL_TYPE_NAMES: Readonly<Record<number, string>> = {
  0: "EAP",
  1: "Start",
  2: "Logoff",
  3: "Key",
  4: "ASF-Alert",
};

/** HTTP request method codes (`se` when ty = request). */
export const HTTP_METHOD_NAMES: Readonly<Record<number, string>> = {
  0: "other",
  1: "GET",
  2: "POST",
  3: "PUT",
  4: "DELETE",
  5: "HEAD",
  6: "OPTIONS",
  7: "PATCH",
};

/** TLS content-type names (`ty`). */
export const TLS_CONTENT_TYPE_NAMES: Readonly<Record<number, string>> = {
  20: "ChangeCipherSpec",
  21: "Alert",
  22: "Handshake",
  23: "Application Data",
};

/** TLS handshake-type names (`se` when content type is Handshake). */
export const TLS_HANDSHAKE_TYPE_NAMES: Readonly<Record<number, string>> = {
  0: "HelloRequest",
  1: "ClientHello",
  2: "ServerHello",
  11: "Certificate",
  12: "ServerKeyExchange",
  13: "CertificateRequest",
  14: "ServerHelloDone",
  15: "CertificateVerify",
  16: "ClientKeyExchange",
  20: "Finished",
};

/** SCTP first-chunk type names (`ty`). */
export const SCTP_CHUNK_NAMES: Readonly<Record<number, string>> = {
  0: "DATA",
  1: "INIT",
  2: "INIT ACK",
  3: "SACK",
  4: "HEARTBEAT",
  5: "HEARTBEAT ACK",
  6: "ABORT",
  7: "SHUTDOWN",
  8: "SHUTDOWN ACK",
  9: "ERROR",
  10: "COOKIE ECHO",
  11: "COOKIE ACK",
  12: "ECNE",
  13: "CWR",
  14: "SHUTDOWN COMPLETE",
};

/** TFTP opcode names (`ty`). */
export const TFTP_OPCODE_NAMES: Readonly<Record<number, string>> = {
  1: "RRQ",
  2: "WRQ",
  3: "DATA",
  4: "ACK",
  5: "ERROR",
  6: "OACK",
};

/** SNMP PDU type names (`ty`, BER tags 0xA0..0xA7). */
export const SNMP_PDU_NAMES: Readonly<Record<number, string>> = {
  0xa0: "GetRequest",
  0xa1: "GetNextRequest",
  0xa2: "Response",
  0xa3: "SetRequest",
  0xa4: "Trap",
  0xa5: "GetBulk",
  0xa6: "Inform",
  0xa7: "TrapV2",
};

function lookupName(table: Readonly<Record<number, string>>, code: number, fallback: string): string {
  return table[code] ?? fallback;
}

function icmpv6TypeName(ty: number): string {
  return lookupName(ICMPV6_TYPE_NAMES, ty, `Type ${ty}`);
}

function igmpTypeName(ty: number): string {
  return lookupName(IGMP_TYPE_NAMES, ty, `Type ${ty}`);
}

function dhcpKindName(ty: number): string {
  if (ty >= DHCP_TY_V6_OFFSET) {
    const v6 = ty - DHCP_TY_V6_OFFSET;
    const kind = lookupName(DHCP_V6_TYPE_NAMES, v6, String(v6));
    return `DHCPv6 ${kind}`;
  }
  const kind = lookupName(DHCP_V4_TYPE_NAMES, ty, String(ty));
  return `DHCP ${kind}`;
}

function dnsFlavor(ty: number): { flavor: string; response: boolean } {
  switch (ty) {
    case DNS_TY_QUERY:
      return { flavor: "DNS", response: false };
    case DNS_TY_RESPONSE:
      return { flavor: "DNS", response: true };
    case DNS_TY_MDNS_QUERY:
      return { flavor: "mDNS", response: false };
    case DNS_TY_MDNS_RESPONSE:
      return { flavor: "mDNS", response: true };
    case DNS_TY_LLMNR_QUERY:
      return { flavor: "LLMNR", response: false };
    case DNS_TY_LLMNR_RESPONSE:
      return { flavor: "LLMNR", response: true };
    default:
      return { flavor: "DNS", response: false };
  }
}

function dnsQtypeName(se: number): string {
  if (se < 0) return String(se);
  return lookupName(DNS_QTYPE_NAMES, se, String(se));
}

function dnsRcodeName(se: number): string {
  if (se < 0) return String(se);
  return lookupName(DNS_RCODE_NAMES, se, String(se));
}

function ntpModeName(ty: number): string {
  return lookupName(NTP_MODE_NAMES, ty, `mode ${ty}`);
}

function ssdpKindName(ty: number): string {
  switch (ty) {
    case SSDP_TY_MSEARCH:
      return "M-SEARCH";
    case SSDP_TY_NOTIFY:
      return "NOTIFY";
    case SSDP_TY_RESPONSE:
      return "response";
    default:
      return `Type ${ty}`;
  }
}

function avtpSubtypeName(ty: number): string {
  return lookupName(AVTP_SUBTYPE_NAMES, ty, `subtype ${ty}`);
}

function eapolTypeName(ty: number): string {
  return lookupName(EAPOL_TYPE_NAMES, ty, `Type ${ty}`);
}

function httpMethodName(se: number): string {
  return lookupName(HTTP_METHOD_NAMES, se, String(se));
}

function tlsContentTypeName(ty: number): string {
  return lookupName(TLS_CONTENT_TYPE_NAMES, ty, `Type ${ty}`);
}

function tlsHandshakeTypeName(se: number): string {
  return lookupName(TLS_HANDSHAKE_TYPE_NAMES, se, `handshake ${se}`);
}

function sctpChunkName(ty: number): string {
  return lookupName(SCTP_CHUNK_NAMES, ty, `chunk ${ty}`);
}

function tftpOpcodeName(ty: number): string {
  return lookupName(TFTP_OPCODE_NAMES, ty, `opcode ${ty}`);
}

function snmpPduName(ty: number): string {
  return lookupName(SNMP_PDU_NAMES, ty, `PDU ${ty}`);
}

/** Application classes over UDP/TCP: Service:Method is source:dest ports. */
function appPorts(sv: number, m: number): string {
  return `${sv}:${m}`;
}

/** True when `se` is a secondary id (not a SOME/IP session). */
function sessionIsSecondary(proto: number): boolean {
  return (
    proto === PROTO_DOIP ||
    proto === PROTO_ICMPV6 ||
    proto === PROTO_DHCP ||
    proto === PROTO_DNS ||
    proto === PROTO_NTP ||
    proto === PROTO_HTTP ||
    proto === PROTO_TLS ||
    proto === PROTO_IGMP ||
    proto === PROTO_SSDP ||
    proto === PROTO_PTP ||
    proto === PROTO_LLDP ||
    proto === PROTO_AVTP ||
    proto === PROTO_MACSEC ||
    proto === PROTO_EAPOL ||
    proto === PROTO_SSH ||
    proto === PROTO_SCTP ||
    proto === PROTO_TFTP ||
    proto === PROTO_SNMP
  );
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
  const p = batch.p[k]!;
  const sv = batch.sv[k]!;
  const m = batch.m[k]!;
  const ty = batch.ty[k]!;
  const sa = batch.sa[k]!;
  const da = batch.da[k]!;
  const sm = batch.sm[k]!;
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
    case PROTO_DOIP: {
      if (isDoipDiagnostic(ty)) {
        // The response travels target→source; order the pair so both
        // directions of one UDS exchange share the live row.
        const se = batch.se[k]!;
        const lo = Math.min(sv, m);
        const hi = Math.max(sv, m);
        return `10:${lo}<>${hi}:${se < 0 ? "x" : se & ~0x40}`;
      }
      return `10:${addr}:${ty}`;
    }
    case PROTO_MALFORMED:
      return `11:${sm}`;
    // SRS_protocols §7 Fixed-mode keys.
    case PROTO_ICMPV6:
    case PROTO_IGMP:
      return `${p}:${addr}:${ty}`;
    case PROTO_DHCP:
    case PROTO_DNS:
    case PROTO_NTP:
    case PROTO_SSDP:
    case PROTO_HTTP:
    case PROTO_TLS:
    case PROTO_SSH:
    case PROTO_SCTP:
    case PROTO_TFTP:
    case PROTO_SNMP:
      return `${p}:${sa}:${sv}>${da}:${m}`;
    case PROTO_PTP:
      return `${p}:${addr}:${ty}`;
    case PROTO_LLDP:
    case PROTO_MACSEC:
    case PROTO_EAPOL:
      return `${p}:${sm}`;
    case PROTO_AVTP:
      return `${p}:${sm}:${ty}`;
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
    out += pb[j]!.toString(16).toUpperCase().padStart(2, "0") + (j < shown - 1 ? " " : "");
  }
  return out + (payloadLen > shown ? " …" : "");
}

/** Projects Name / Type / Service:Method per protocol class (SRS §5.2). */
function classDisplay(
  proto: number,
  sv: number,
  m: number,
  ty: number,
  se: number,
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
    case PROTO_DOIP: {
      const diag = isDoipDiagnostic(ty);
      return {
        protocol,
        serviceMethod: diag ? `${hex4(sv)} → ${hex4(m)}` : "--",
        name: DOIP_TYPE_NAMES[ty] ?? DOIP_TYPE_NAMES[DOIP_TY_OTHER]!,
        type: diag ? udsTypeLabel(se) : "--",
      };
    }
    case PROTO_MALFORMED:
      return {
        protocol,
        serviceMethod: "--",
        name: `runt · ${len} bytes`,
        type: "",
      };
    case PROTO_ICMPV6: {
      const kind = icmpv6TypeName(ty);
      return {
        protocol,
        serviceMethod: "--",
        name: kind,
        type: String(se),
      };
    }
    case PROTO_IGMP: {
      const kind = igmpTypeName(ty);
      return { protocol, serviceMethod: "--", name: kind, type: kind };
    }
    case PROTO_DHCP: {
      const kind = dhcpKindName(ty);
      return {
        protocol,
        serviceMethod: appPorts(sv, m),
        name: kind,
        type: "--",
      };
    }
    case PROTO_DNS: {
      const { flavor, response } = dnsFlavor(ty);
      const secondary = response ? dnsRcodeName(se) : dnsQtypeName(se);
      const kind = response ? "response" : "query";
      // Unknown DNS_TY_* still renders a stable label with the raw ty.
      const known =
        ty === DNS_TY_QUERY ||
        ty === DNS_TY_RESPONSE ||
        ty === DNS_TY_MDNS_QUERY ||
        ty === DNS_TY_MDNS_RESPONSE ||
        ty === DNS_TY_LLMNR_QUERY ||
        ty === DNS_TY_LLMNR_RESPONSE;
      const name = known
        ? `${flavor} ${kind} · ${secondary}`
        : `DNS Type ${ty} · ${secondary}`;
      return {
        protocol,
        serviceMethod: appPorts(sv, m),
        name,
        type: secondary,
      };
    }
    case PROTO_NTP: {
      const mode = ntpModeName(ty);
      return {
        protocol,
        serviceMethod: appPorts(sv, m),
        name: `NTP ${mode} · stratum ${se}`,
        type: `stratum ${se}`,
      };
    }
    case PROTO_SSDP: {
      const kind = ssdpKindName(ty);
      return {
        protocol,
        serviceMethod: appPorts(sv, m),
        name: `SSDP ${kind}`,
        type: kind,
      };
    }
    case PROTO_PTP: {
      const ptpTy = gptpTypeLabel(ty);
      return {
        protocol,
        serviceMethod: "--",
        name: `PTP ${ptpTy} · domain ${sv}`,
        type: `domain ${sv}`,
      };
    }
    case PROTO_LLDP:
      return { protocol, serviceMethod: "--", name: "LLDP", type: "--" };
    case PROTO_AVTP: {
      const subtype = avtpSubtypeName(ty);
      return {
        protocol,
        serviceMethod: "--",
        name: `AVTP ${subtype}`,
        type: subtype,
      };
    }
    case PROTO_MACSEC: {
      const name = `MACsec · AN ${ty}`;
      return { protocol, serviceMethod: "--", name, type: `AN ${ty}` };
    }
    case PROTO_EAPOL: {
      const kind = eapolTypeName(ty);
      return {
        protocol,
        serviceMethod: "--",
        name: `EAPOL ${kind}`,
        type: kind,
      };
    }
    case PROTO_HTTP: {
      if (ty === HTTP_TY_REQUEST) {
        const method = httpMethodName(se);
        return {
          protocol,
          serviceMethod: appPorts(sv, m),
          name: `HTTP ${method}`,
          type: method,
        };
      }
      if (ty === HTTP_TY_RESPONSE) {
        const status = se < 0 ? String(se) : String(se);
        return {
          protocol,
          serviceMethod: appPorts(sv, m),
          name: `HTTP ${status}`,
          type: status,
        };
      }
      return {
        protocol,
        serviceMethod: appPorts(sv, m),
        name: `HTTP Type ${ty}`,
        type: String(ty),
      };
    }
    case PROTO_TLS: {
      // Prefer handshake-type name when present (ClientHello, Certificate…).
      const name =
        ty === 22 && se >= 0
          ? `TLS ${tlsHandshakeTypeName(se)}`
          : `TLS ${tlsContentTypeName(ty)}`;
      const typeLabel =
        ty === 22 && se >= 0 ? tlsHandshakeTypeName(se) : tlsContentTypeName(ty);
      return {
        protocol,
        serviceMethod: appPorts(sv, m),
        name,
        type: typeLabel,
      };
    }
    case PROTO_SSH: {
      const kind =
        ty === SSH_TY_BANNER ? "banner" : ty === SSH_TY_PACKET ? "packet" : `Type ${ty}`;
      return {
        protocol,
        serviceMethod: appPorts(sv, m),
        name: `SSH ${kind}`,
        type: kind,
      };
    }
    case PROTO_SCTP: {
      const chunk = sctpChunkName(ty);
      return {
        protocol,
        serviceMethod: appPorts(sv, m),
        name: `SCTP ${chunk}`,
        type: chunk,
      };
    }
    case PROTO_TFTP: {
      const opcode = tftpOpcodeName(ty);
      return {
        protocol,
        serviceMethod: appPorts(sv, m),
        name: `TFTP ${opcode}`,
        type: opcode,
      };
    }
    case PROTO_SNMP: {
      const pdu = snmpPduName(ty);
      return {
        protocol,
        serviceMethod: appPorts(sv, m),
        name: `SNMP ${pdu}`,
        type: pdu,
      };
    }
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
  const idx = batch.i[k]!;
  const t = batch.t[k]!;
  const dir = dirOf(batch.d[k]!);
  const srcEp = batch.s[k]!;
  const ep = resolveEndpoint(srcEp);
  const source = ep.label;
  const sourceTitle = ep.title;
  const proto = batch.p[k]!;
  const sv = batch.sv[k]!;
  const m = batch.m[k]!;
  const ty = batch.ty[k]!;
  const se = batch.se[k]!;
  const len = batch.l[k]!;
  const sa = batch.sa[k]!;
  const da = batch.da[k]!;
  const sm = batch.sm[k]!;
  const vl = batch.vl[k]!;
  const po = batch.po[k]!;
  const key = frameKey(batch, k);

  const { protocol, serviceMethod, name, type } = classDisplay(
    proto,
    sv,
    m,
    ty,
    se,
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
    // DoIP / §7 classes reuse `se` for a secondary id; Session stays blank.
    session: sessionIsSecondary(proto) || se < 0 ? "--" : String(se),
    length: String(len),
    payload: payloadPreview(batch.pb[k]!, len, po),
    deltaGlobal: prevT === null ? "--" : (t - prevT).toFixed(4),
    deltaKey: lastByKey.get(key) === undefined ? "--" : (t - (lastByKey.get(key) as number)).toFixed(4),
    channel: "1",
    key,
    proto,
    sv,
    m,
    srcEp,
    ty,
    se,
    sa,
    da,
    sm,
    vl,
  };
}
