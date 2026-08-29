/**
 * Wire-level code tables — the byte-for-byte mirror of
 * `src-tauri/src/codes.rs` (SRS_protocols.md §2b). `wireCodes.test.ts` reads
 * the Rust file and pins both sides; keep every constant on one line in the
 * form `export const NAME = N;` with the same names as the Rust side.
 */

// Protocol class (`p` column).
export const PROTO_SOMEIP = 0;
export const PROTO_SD = 1;
export const PROTO_GPTP = 2;
export const PROTO_ARP = 3;
export const PROTO_UDP = 4;
export const PROTO_TCP = 5;
export const PROTO_ICMP = 6;
export const PROTO_IPV6 = 7;
export const PROTO_IPV4_OTHER = 8;
export const PROTO_OTHER = 9;
export const PROTO_DOIP = 10;
export const PROTO_MALFORMED = 11;
export const PROTO_CLASS_COUNT = 12;

// Direction (`d` column).
export const DIR_TX = 0;
export const DIR_RX = 1;
export const DIR_UNKNOWN = 2;

// SOME/IP message types (`ty` when `p === PROTO_SOMEIP`).
export const SOMEIP_TY_NOTIFICATION = 0;
export const SOMEIP_TY_REQUEST = 1;
export const SOMEIP_TY_REQUEST_NO_RETURN = 2;
export const SOMEIP_TY_RESPONSE = 3;
export const SOMEIP_TY_ERROR = 4;
export const SOMEIP_TY_OTHER = 255;

// SOME/IP-SD message types (`ty` when `p === PROTO_SD`).
export const SD_TY_OFFER = 0;
export const SD_TY_FIND = 1;
export const SD_TY_STOP_OFFER = 2;
export const SD_TY_SUBSCRIBE = 3;
export const SD_TY_STOP_SUBSCRIBE = 4;
export const SD_TY_SUBSCRIBE_ACK = 5;
export const SD_TY_SUBSCRIBE_NACK = 6;
export const SD_TY_EMPTY = 7;
export const SD_TY_OTHER = 255;

// gPTP message types (`ty` when `p === PROTO_GPTP`).
export const GPTP_TY_SYNC = 0;
export const GPTP_TY_FOLLOW_UP = 1;
export const GPTP_TY_PDELAY_REQ = 2;
export const GPTP_TY_PDELAY_RESP = 3;
export const GPTP_TY_PDELAY_RESP_FOLLOW_UP = 4;
export const GPTP_TY_ANNOUNCE = 5;
export const GPTP_TY_SIGNALING = 6;
export const GPTP_TY_OTHER = 255;

// DoIP payload types (`ty` when `p === PROTO_DOIP`).
export const DOIP_TY_HEADER_NACK = 0;
export const DOIP_TY_VEHICLE_ID_REQ = 1;
export const DOIP_TY_VEHICLE_ID_REQ_EID = 2;
export const DOIP_TY_VEHICLE_ID_REQ_VIN = 3;
export const DOIP_TY_VEHICLE_ANNOUNCE = 4;
export const DOIP_TY_ROUTING_ACT_REQ = 5;
export const DOIP_TY_ROUTING_ACT_RES = 6;
export const DOIP_TY_ALIVE_REQ = 7;
export const DOIP_TY_ALIVE_RES = 8;
export const DOIP_TY_ENTITY_STATUS_REQ = 9;
export const DOIP_TY_ENTITY_STATUS_RES = 10;
export const DOIP_TY_POWER_MODE_REQ = 11;
export const DOIP_TY_POWER_MODE_RES = 12;
export const DOIP_TY_DIAG = 13;
export const DOIP_TY_DIAG_ACK = 14;
export const DOIP_TY_DIAG_NACK = 15;
export const DOIP_TY_OTHER = 255;

// ARP operations (`ty` when `p === PROTO_ARP`).
export const ARP_TY_REQUEST = 0;
export const ARP_TY_REPLY = 1;
export const ARP_TY_OTHER = 255;

// `s` column sentinel: the session endpoint table is full.
export const ENDPOINT_OVERFLOW = 255;
export const ENDPOINT_MAX_INDEX = 254;

/** Protocol column tokens (SRS_visual_ui.md §5.2), indexed by PROTO_*. */
export const PROTO_LABELS: readonly string[] = [
  "SOME/IP",
  "SD",
  "gPTP",
  "ARP",
  "UDP",
  "TCP",
  "ICMP",
  "IPv6",
  "IPv4",
  "Other",
  "DoIP",
  "Malformed",
];

export function protoLabel(p: number): string {
  return PROTO_LABELS[p] ?? `Unknown (${p})`;
}
