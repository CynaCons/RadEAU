//! Wire-level code tables and the columnar `frames:batch` contract shared with
//! the UI (SRS_protocols.md §2/§2b). `src/runtime/wireCodes.ts` is the
//! byte-for-byte mirror; a vitest reads this file and pins both sides, so
//! every constant here must stay on one line in the form
//! `pub const NAME: u8 = N;`.
//!
//! Classification never drops: every frame a source delivers gets exactly one
//! protocol class and is retained for dissection (SP-006).
//!
//! Batch columns (all arrays index-aligned; `seq: u64` per batch):
//! - `i: u64`  global frame index
//! - `t: f64`  seconds since session start
//! - `d: u8`   DIR_* (relative to RadEAU's host, SP-009)
//! - `s: u8`   endpoint index into the session endpoint table (ENDPOINT_OVERFLOW when full)
//! - `p: u8`   PROTO_*
//! - `sv: u16`, `m: u16`  identity pair, meaning per class:
//!   SOME/IP, SD: service id, method id
//!   gPTP: domain, sequence id
//!   ARP: opcode, 0
//!   UDP, TCP: source port, destination port
//!   ICMP: type, code
//!   IPv6: next header, 0
//!   IPv4 (other protocol): protocol number, 0
//!   Other (non-IP): EtherType, 0
//!   Malformed: 0, 0
//! - `ty: u8`  message type, table per class below (0 for classes without one)
//! - `se: i32` SOME/IP session id; -1 for every other class
//! - `l: u32`  full wire length incl. Ethernet header
//! - `pb: [u8; SNAP_LEN]` preview bytes starting at `po`
//! - `sa: u32`, `da: u32`  source / destination IPv4 (0 when the frame carries none)
//! - `sm: u64` source MAC as a 48-bit integer (exact in an f64)
//! - `vl: i16` VLAN id (-1 untagged; the outer tag when double-tagged)
//! - `po: u16` offset of the preview/payload start: L4 payload for UDP/TCP
//!   (the SOME/IP message for SOME/IP and SD), L2 payload for gPTP/ARP/other,
//!   0 for Malformed
//!
//! `capture:stats` (SP-010), 1 Hz while running and once at stop:
//! `{seq, elapsedS, received, emitted, accumulatorDropped, gapRecords,
//! gapDropped, malformed, kernelDropped, byClass: [u64; PROTO_CLASS_COUNT]}`.
//!
//! Reserved codes are part of the contract before the code that emits them
//! lands, so unused-constant warnings are suppressed for this module.
#![allow(dead_code)]

/// Protocol class (`p` column).
pub const PROTO_SOMEIP: u8 = 0;
pub const PROTO_SD: u8 = 1;
pub const PROTO_GPTP: u8 = 2;
pub const PROTO_ARP: u8 = 3;
/// UDP that is not SOME/IP (nor DoIP once v0.1.9 lands).
pub const PROTO_UDP: u8 = 4;
pub const PROTO_TCP: u8 = 5;
pub const PROTO_ICMP: u8 = 6;
pub const PROTO_IPV6: u8 = 7;
/// IPv4 carrying a protocol other than UDP / TCP / ICMP.
pub const PROTO_IPV4_OTHER: u8 = 8;
/// Any other EtherType.
pub const PROTO_OTHER: u8 = 9;
/// Reserved for v0.1.9; never emitted before then.
#[allow(dead_code)]
pub const PROTO_DOIP: u8 = 10;
/// Ethernet header unparseable (runt frame).
pub const PROTO_MALFORMED: u8 = 11;
/// Standard protocol classes (SRS_protocols.md §7). Identity columns for the
/// application classes: `sv` / `m` = source / destination port, `ty` = the
/// class's message kind, `se` = its secondary id (transaction id, query type,
/// handshake type, status code, stratum) or -1.
pub const PROTO_ICMPV6: u8 = 12;
pub const PROTO_IGMP: u8 = 13;
pub const PROTO_DHCP: u8 = 14;
pub const PROTO_DNS: u8 = 15;
pub const PROTO_NTP: u8 = 16;
pub const PROTO_SSDP: u8 = 17;
/// IEEE 1588 PTP over UDP 319/320 (gPTP over Ethernet stays PROTO_GPTP).
pub const PROTO_PTP: u8 = 18;
pub const PROTO_LLDP: u8 = 19;
/// IEEE 1722 audio/video transport (EtherType 0x22F0).
pub const PROTO_AVTP: u8 = 20;
pub const PROTO_MACSEC: u8 = 21;
pub const PROTO_EAPOL: u8 = 22;
pub const PROTO_HTTP: u8 = 23;
pub const PROTO_TLS: u8 = 24;
pub const PROTO_SSH: u8 = 25;
pub const PROTO_SCTP: u8 = 26;
pub const PROTO_TFTP: u8 = 27;
pub const PROTO_SNMP: u8 = 28;
pub const PROTO_CLASS_COUNT: usize = 29;

/// DHCP message kinds (`ty` when `p == PROTO_DHCP`): DHCPv4 option 53
/// values 1..8 as-is, DHCPv6 message types offset by 100.
pub const DHCP_TY_V6_OFFSET: u8 = 100;

/// DNS message kinds (`ty` when `p == PROTO_DNS`).
pub const DNS_TY_QUERY: u8 = 0;
pub const DNS_TY_RESPONSE: u8 = 1;
pub const DNS_TY_MDNS_QUERY: u8 = 2;
pub const DNS_TY_MDNS_RESPONSE: u8 = 3;
pub const DNS_TY_LLMNR_QUERY: u8 = 4;
pub const DNS_TY_LLMNR_RESPONSE: u8 = 5;

/// SSDP message kinds (`ty` when `p == PROTO_SSDP`).
pub const SSDP_TY_MSEARCH: u8 = 0;
pub const SSDP_TY_NOTIFY: u8 = 1;
pub const SSDP_TY_RESPONSE: u8 = 2;

/// HTTP message kinds (`ty` when `p == PROTO_HTTP`); `se` = method code for
/// requests (1 GET, 2 POST, 3 PUT, 4 DELETE, 5 HEAD, 6 OPTIONS, 7 PATCH,
/// 0 other) or the status code for responses.
pub const HTTP_TY_REQUEST: u8 = 0;
pub const HTTP_TY_RESPONSE: u8 = 1;

/// SSH message kinds (`ty` when `p == PROTO_SSH`).
pub const SSH_TY_BANNER: u8 = 0;
pub const SSH_TY_PACKET: u8 = 1;

/// Direction (`d` column): observed on the wire vs originated by RadEAU.
pub const DIR_TX: u8 = 0;
pub const DIR_RX: u8 = 1;
/// The source cannot say (e.g. a pcap file without direction metadata).
#[allow(dead_code)]
pub const DIR_UNKNOWN: u8 = 2;

/// SOME/IP message types (`ty` when `p == PROTO_SOMEIP`).
pub const SOMEIP_TY_NOTIFICATION: u8 = 0;
pub const SOMEIP_TY_REQUEST: u8 = 1;
pub const SOMEIP_TY_REQUEST_NO_RETURN: u8 = 2;
pub const SOMEIP_TY_RESPONSE: u8 = 3;
pub const SOMEIP_TY_ERROR: u8 = 4;
pub const SOMEIP_TY_OTHER: u8 = 255;

/// SOME/IP-SD message types (`ty` when `p == PROTO_SD`), from the first
/// entry; TTL 0 turns Offer into StopOffer, Subscribe into StopSubscribe,
/// and SubscribeAck into SubscribeNack.
pub const SD_TY_OFFER: u8 = 0;
pub const SD_TY_FIND: u8 = 1;
pub const SD_TY_STOP_OFFER: u8 = 2;
pub const SD_TY_SUBSCRIBE: u8 = 3;
pub const SD_TY_STOP_SUBSCRIBE: u8 = 4;
pub const SD_TY_SUBSCRIBE_ACK: u8 = 5;
pub const SD_TY_SUBSCRIBE_NACK: u8 = 6;
/// No entries in the SD payload.
pub const SD_TY_EMPTY: u8 = 7;
pub const SD_TY_OTHER: u8 = 255;

/// gPTP message types (`ty` when `p == PROTO_GPTP`).
pub const GPTP_TY_SYNC: u8 = 0;
pub const GPTP_TY_FOLLOW_UP: u8 = 1;
pub const GPTP_TY_PDELAY_REQ: u8 = 2;
pub const GPTP_TY_PDELAY_RESP: u8 = 3;
pub const GPTP_TY_PDELAY_RESP_FOLLOW_UP: u8 = 4;
pub const GPTP_TY_ANNOUNCE: u8 = 5;
pub const GPTP_TY_SIGNALING: u8 = 6;
pub const GPTP_TY_OTHER: u8 = 255;

/// DoIP payload types (`ty` when `p == PROTO_DOIP`, ISO 13400-2); `sv` /
/// `m` carry the logical source / target addresses of diagnostic messages
/// (0 otherwise) and `se` the UDS service id of a 0x8001 message (-1
/// otherwise).
pub const DOIP_TY_HEADER_NACK: u8 = 0;
pub const DOIP_TY_VEHICLE_ID_REQ: u8 = 1;
pub const DOIP_TY_VEHICLE_ID_REQ_EID: u8 = 2;
pub const DOIP_TY_VEHICLE_ID_REQ_VIN: u8 = 3;
pub const DOIP_TY_VEHICLE_ANNOUNCE: u8 = 4;
pub const DOIP_TY_ROUTING_ACT_REQ: u8 = 5;
pub const DOIP_TY_ROUTING_ACT_RES: u8 = 6;
pub const DOIP_TY_ALIVE_REQ: u8 = 7;
pub const DOIP_TY_ALIVE_RES: u8 = 8;
pub const DOIP_TY_ENTITY_STATUS_REQ: u8 = 9;
pub const DOIP_TY_ENTITY_STATUS_RES: u8 = 10;
pub const DOIP_TY_POWER_MODE_REQ: u8 = 11;
pub const DOIP_TY_POWER_MODE_RES: u8 = 12;
pub const DOIP_TY_DIAG: u8 = 13;
pub const DOIP_TY_DIAG_ACK: u8 = 14;
pub const DOIP_TY_DIAG_NACK: u8 = 15;
pub const DOIP_TY_OTHER: u8 = 255;

/// ARP operations (`ty` when `p == PROTO_ARP`).
pub const ARP_TY_REQUEST: u8 = 0;
pub const ARP_TY_REPLY: u8 = 1;
pub const ARP_TY_OTHER: u8 = 255;

/// `s` column sentinel: the session endpoint table is full.
pub const ENDPOINT_OVERFLOW: u8 = 255;
/// Highest assignable endpoint index (255 is the overflow bucket).
pub const ENDPOINT_MAX_INDEX: u8 = 254;
