//! Dev frame generator (PRD §3.8) — a seeded, deterministic source of basic
//! Ethernet frames streaming through the exact production path so the Trace
//! view is tuned against *flowing* data long before real channels and
//! `ecu-netsim` exist. Compiled out of release builds (`cfg(debug_assertions)`).
//!
//! Traffic model mirrors the sensor-fusion network used by the static mocks:
//! five SOME/IP event streams, periodic SD offers, gPTP sync from the
//! grandmaster. Every frame is built as real wire bytes (Ethernet II /
//! IPv4 / UDP via `radeau-proto`) and then parsed back through the same
//! bounded codecs — the parse the live capture path will use.

use crate::codes::{
    DIR_RX, DIR_TX, GPTP_TY_SYNC, PROTO_GPTP, PROTO_SD, PROTO_SOMEIP, SD_TY_OFFER,
    SOMEIP_TY_NOTIFICATION,
};
use crate::frame::{GenFrame, SNAP_LEN};
use radeau_proto::ethernet::{self, EthernetFrame};
use radeau_proto::ipv4::{self, Ipv4Packet};
use radeau_proto::udp::UdpDatagram;
use radeau_proto::{gptp, sd, someip};

const UDP_PORT_SOMEIP: u16 = 30490;
const IP_IDENT_MASK: u16 = 0xffff;

struct ServiceSpec {
    svc: u16,
    method: u16,
    src_ep: usize,
    base_len: usize,
    tx: bool,
}

/// Mirrors the fusion network model (TraceView / ecu-netsim scenario).
const SERVICES: [ServiceSpec; 5] = [
    ServiceSpec {
        svc: 0x1101,
        method: 0x8001,
        src_ep: 0,
        base_len: 128,
        tx: false,
    },
    ServiceSpec {
        svc: 0x1102,
        method: 0x8001,
        src_ep: 1,
        base_len: 96,
        tx: false,
    },
    ServiceSpec {
        svc: 0x1103,
        method: 0x8001,
        src_ep: 2,
        base_len: 160,
        tx: false,
    },
    ServiceSpec {
        svc: 0x1104,
        method: 0x8001,
        src_ep: 3,
        base_len: 48,
        tx: false,
    },
    ServiceSpec {
        svc: 0x1201,
        method: 0x8001,
        src_ep: 4,
        base_len: 144,
        tx: true,
    },
];

pub fn endpoint_ip(ep: usize) -> [u8; 4] {
    [10, 42, 0, 11 + ep as u8]
}

fn endpoint_mac(ep: usize) -> [u8; 6] {
    let ip = endpoint_ip(ep);
    [0x02, 0x00, 0x42, 0x00, 0x00, ip[3]]
}

/// Locally administered switch MAC all Rx traffic is delivered through.
const SWITCH_MAC: [u8; 6] = [0x02, 0x00, 0x42, 0x00, 0x00, 0x01];
/// Multicast MAC for 239.255.255.250 (SOME/IP-SD).
const SD_MCAST_MAC: [u8; 6] = [0x01, 0x00, 0x5e, 0x7f, 0xff, 0xfa];
const SD_MCAST_IP: [u8; 4] = [239, 255, 255, 250];

/// Rate profiles exposed to the operator (fps).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateProfile {
    Idle,
    Normal,
    Stress,
    Burst,
}

impl RateProfile {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "idle" => Some(Self::Idle),
            "normal" => Some(Self::Normal),
            "stress" => Some(Self::Stress),
            "burst" => Some(Self::Burst),
            _ => None,
        }
    }

    /// Instantaneous target rate. Deterministic function of elapsed session
    /// time — no wall-clock reads inside the profile itself.
    pub fn rate_at(self, elapsed_s: f64) -> f64 {
        match self {
            Self::Idle => 50.0,
            Self::Normal => 800.0,
            Self::Stress => 5000.0,
            Self::Burst => {
                // 250 fps base with a 200 ms burst to stress rate every 3 s.
                if elapsed_s % 3.0 < 0.2 {
                    5000.0
                } else {
                    250.0
                }
            }
        }
    }
}

/// xorshift64* — tiny, seedable, allocation-free; adequate for synthetic
/// traffic shapes and fully reproducible across runs and across the TS mirror.
struct Xorshift(u64);

impl Xorshift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

pub struct DevGen {
    rng: Xorshift,
    idx: u64,
    t_s: f64,
    sessions: [i32; SERVICES.len()],
    sd_cycle: usize,
    ip_ident: u16,
}

struct FrameScratch {
    body: Vec<u8>,
    payload: Vec<u8>,
    l3: Vec<u8>,
    full: Vec<u8>,
}

impl FrameScratch {
    fn new() -> Self {
        Self {
            body: Vec::with_capacity(192),
            payload: Vec::with_capacity(256),
            l3: Vec::with_capacity(256),
            full: Vec::with_capacity(256),
        }
    }

    fn clear(&mut self) {
        self.body.clear();
        self.payload.clear();
        self.l3.clear();
        self.full.clear();
    }
}

impl DevGen {
    pub fn new(seed: u64) -> Self {
        Self {
            rng: Xorshift(seed.max(1)),
            idx: 0,
            t_s: 0.0,
            sessions: [0; SERVICES.len()],
            sd_cycle: 0,
            ip_ident: 1,
        }
    }

    /// Generates `n` frames spaced ~`1/rate` apart on the synthetic timeline,
    /// appending to `out`. One reusable scratch buffer across all frames.
    #[cfg(test)]
    pub fn gen_frames(&mut self, n: usize, rate: f64, out: &mut Vec<GenFrame>) {
        let mut wire = Vec::with_capacity(256);
        let mut scratch = FrameScratch::new();
        for _ in 0..n {
            self.t_s += (1.0 / rate) * (0.5 + self.rng.below(1000) as f64 / 1000.0);
            let frame = self.gen_one(&mut wire, &mut scratch);
            out.push(frame);
        }
    }

    /// Generates frames with their complete wire bytes for the cold-path frame
    /// ring. The streaming `GenFrame` shape remains unchanged.
    pub fn gen_frames_with_wire(
        &mut self,
        n: usize,
        rate: f64,
        out: &mut Vec<(GenFrame, Vec<u8>)>,
    ) {
        let mut wire = Vec::with_capacity(256);
        let mut scratch = FrameScratch::new();
        for _ in 0..n {
            self.t_s += (1.0 / rate) * (0.5 + self.rng.below(1000) as f64 / 1000.0);
            wire.clear();
            let frame = self.gen_one(&mut wire, &mut scratch);
            out.push((frame, wire.clone()));
        }
    }

    fn gen_one(&mut self, wire: &mut Vec<u8>, scratch: &mut FrameScratch) -> GenFrame {
        let roll = self.rng.below(1000);
        let idx = self.idx;
        let t_s = self.t_s;
        self.idx += 1;
        wire.clear();
        if roll < 40 {
            self.gen_sd_offer(idx, t_s, wire, scratch)
        } else if roll < 80 {
            self.gen_gptp_sync(idx, t_s, wire, scratch)
        } else {
            self.gen_someip_event(idx, t_s, wire, scratch)
        }
    }

    fn gen_someip_event(
        &mut self,
        idx: u64,
        t_s: f64,
        wire: &mut Vec<u8>,
        scratch: &mut FrameScratch,
    ) -> GenFrame {
        scratch.clear();
        let k = (idx % SERVICES.len() as u64) as usize;
        let s = &SERVICES[k];
        let payload_len = s.base_len + ((self.rng.below(4) * 8) as usize);
        let src_ip = endpoint_ip(s.src_ep);
        let dst_ip = endpoint_ip(4); // events flow toward the fusion ECU

        self.sessions[k] = self.sessions[k].wrapping_add(1);
        scratch
            .body
            .extend((0..payload_len).map(|_| (self.rng.next() & 0xff) as u8));
        // A real SOME/IP header in front of the random body so the frame
        // classifies by plausibility like live traffic does.
        someip::build(
            &someip::SomeIpHeader {
                service_id: s.svc,
                method_id: s.method,
                length: 0,
                client_id: 1,
                session_id: (self.sessions[k] & 0xffff) as u16,
                protocol_version: 1,
                interface_version: 1,
                message_type: someip::MSG_NOTIFICATION,
                return_code: 0,
            },
            &scratch.body,
            &mut scratch.payload,
        );
        // UDP datagram, then IPv4 packet around it, then Ethernet II around
        // that — one clean inside-out pass, exactly how the live path builds.
        wire.clear();
        UdpDatagram::build(
            src_ip,
            dst_ip,
            UDP_PORT_SOMEIP,
            UDP_PORT_SOMEIP,
            &scratch.payload,
            &mut scratch.l3,
        );
        Ipv4Packet::build(
            src_ip,
            dst_ip,
            ipv4::PROTOCOL_UDP,
            self.ip_ident,
            64,
            0,
            &scratch.l3,
            wire,
        );
        EthernetFrame::build(
            endpoint_mac(s.src_ep),
            SWITCH_MAC,
            ethernet::ETHERTYPE_IPV4,
            wire,
            &mut scratch.full,
        );
        std::mem::swap(wire, &mut scratch.full);
        self.ip_ident = (self.ip_ident.wrapping_add(7)) & IP_IDENT_MASK | 1;

        let parsed = project_from_wire(wire);
        GenFrame {
            idx,
            t_s,
            dir: if s.tx { DIR_TX } else { DIR_RX },
            src_ep: s.src_ep,
            proto: PROTO_SOMEIP,
            svc: s.svc,
            method: s.method,
            msg_type: SOMEIP_TY_NOTIFICATION,
            session: self.sessions[k],
            wire_len: parsed.0,
            snap: parsed.1,
            src_ip: u32::from_be_bytes(src_ip),
            dst_ip: u32::from_be_bytes(dst_ip),
            src_mac: mac_u64(endpoint_mac(s.src_ep)),
            vlan: -1,
            payload_off: 42,
        }
    }

    fn gen_sd_offer(
        &mut self,
        idx: u64,
        t_s: f64,
        wire: &mut Vec<u8>,
        scratch: &mut FrameScratch,
    ) -> GenFrame {
        scratch.clear();
        let s = &SERVICES[self.sd_cycle % SERVICES.len()];
        self.sd_cycle = self.sd_cycle.wrapping_add(1);
        let src_ep = s.src_ep;
        let src_ip = endpoint_ip(src_ep);
        // A real SD OfferService message (SOME/IP 0xFFFF/0x8100 + one
        // entry) so the frame classifies as SD like live traffic does.
        sd::build_entries(
            0xc0,
            &[sd::SdEntry {
                entry_type: sd::ENTRY_OFFER_SERVICE,
                service_id: s.svc,
                instance_id: 1,
                major_version: 1,
                ttl: 3,
                minor_version: 0,
            }],
            &mut scratch.body,
        );
        someip::build(
            &someip::SomeIpHeader {
                service_id: someip::SD_SERVICE_ID,
                method_id: someip::SD_METHOD_ID,
                length: 0,
                client_id: 0,
                session_id: (self.sd_cycle & 0xffff) as u16,
                protocol_version: 1,
                interface_version: 1,
                message_type: someip::MSG_NOTIFICATION,
                return_code: 0,
            },
            &scratch.body,
            &mut scratch.payload,
        );
        UdpDatagram::build(
            src_ip,
            SD_MCAST_IP,
            UDP_PORT_SOMEIP,
            UDP_PORT_SOMEIP,
            &scratch.payload,
            &mut scratch.l3,
        );
        Ipv4Packet::build(
            src_ip,
            SD_MCAST_IP,
            ipv4::PROTOCOL_UDP,
            self.ip_ident,
            64,
            0,
            &scratch.l3,
            wire,
        );
        self.ip_ident = (self.ip_ident.wrapping_add(7)) & IP_IDENT_MASK | 1;
        EthernetFrame::build(
            SD_MCAST_MAC,
            endpoint_mac(src_ep),
            ethernet::ETHERTYPE_IPV4,
            wire,
            &mut scratch.full,
        );
        std::mem::swap(wire, &mut scratch.full);
        let parsed = project_from_wire(wire);
        GenFrame {
            idx,
            t_s,
            dir: DIR_RX,
            src_ep,
            proto: PROTO_SD,
            svc: 0xffff,
            method: 0x8100,
            msg_type: SD_TY_OFFER,
            session: -1,
            wire_len: parsed.0,
            snap: parsed.1,
            src_ip: u32::from_be_bytes(src_ip),
            dst_ip: u32::from_be_bytes(SD_MCAST_IP),
            src_mac: mac_u64(endpoint_mac(src_ep)),
            vlan: -1,
            payload_off: 42,
        }
    }

    fn gen_gptp_sync(
        &mut self,
        idx: u64,
        t_s: f64,
        wire: &mut Vec<u8>,
        scratch: &mut FrameScratch,
    ) -> GenFrame {
        scratch.clear();
        // gPTP rides directly on Ethernet (EtherType 0x88F7), no IP/UDP. A
        // real Sync header so the frame parses like live traffic does.
        let gm_ep = 0;
        gptp::build(
            &gptp::GptpMessage {
                msg_type: gptp::MSG_SYNC,
                domain: 0,
                sequence_id: (idx & 0xffff) as u16,
                correction_ns: 0,
                origin_timestamp_ns: Some((t_s * 1e9) as u128),
            },
            &mut scratch.payload,
        );
        wire.clear();
        EthernetFrame::build(
            SWITCH_MAC,
            endpoint_mac(gm_ep),
            ethernet::ETHERTYPE_GPTP,
            &scratch.payload,
            wire,
        );
        GenFrame {
            idx,
            t_s,
            dir: DIR_RX,
            src_ep: gm_ep,
            proto: PROTO_GPTP,
            svc: 0,
            method: 0,
            msg_type: GPTP_TY_SYNC,
            session: -1,
            wire_len: wire.len() as u32,
            snap: snap_from(&scratch.payload),
            src_ip: 0,
            dst_ip: 0,
            src_mac: mac_u64(endpoint_mac(gm_ep)),
            vlan: -1,
            payload_off: 14,
        }
    }
}

fn mac_u64(mac: [u8; 6]) -> u64 {
    mac.into_iter()
        .fold(0, |value, byte| (value << 8) | u64::from(byte))
}

/// Runs the wire bytes back through the production codecs and extracts the
/// projection fields every live frame will get the same way.
fn project_from_wire(wire: &[u8]) -> (u32, [u8; SNAP_LEN]) {
    let len = wire.len() as u32;
    let snap = EthernetFrame::parse(wire)
        .ok()
        .and_then(|eth| {
            if eth.ethertype == ethernet::ETHERTYPE_IPV4 {
                Ipv4Packet::parse(eth.payload).ok().and_then(|ip| {
                    if ip.protocol == ipv4::PROTOCOL_UDP {
                        UdpDatagram::parse(ip.payload).ok()
                    } else {
                        None
                    }
                })
            } else {
                None
            }
        })
        .map(|udp| snap_from(udp.payload))
        .unwrap_or([0; SNAP_LEN]);
    (len, snap)
}

fn snap_from(payload: &[u8]) -> [u8; SNAP_LEN] {
    let mut snap = [0; SNAP_LEN];
    let n = payload.len().min(SNAP_LEN);
    snap[..n].copy_from_slice(&payload[..n]);
    snap
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_for_same_seed() {
        let mut a = DevGen::new(42);
        let mut b = DevGen::new(42);
        let (mut va, mut vb) = (Vec::new(), Vec::new());
        a.gen_frames(500, 800.0, &mut va);
        b.gen_frames(500, 800.0, &mut vb);
        assert_eq!(va.len(), vb.len());
        for (x, y) in va.iter().zip(vb.iter()) {
            assert_eq!(x.idx, y.idx);
            assert_eq!(x.wire_len, y.wire_len);
            assert_eq!(x.snap, y.snap);
            assert_eq!(x.proto, y.proto);
            assert_eq!(x.session, y.session);
        }
    }

    #[test]
    fn all_frames_parse_back_with_valid_lengths() {
        let mut gen = DevGen::new(7);
        let mut out = Vec::new();
        gen.gen_frames(300, 800.0, &mut out);
        for f in &out {
            assert!(f.wire_len >= ethernet::HEADER_LEN as u32, "frame {}", f.idx);
            assert!(f.wire_len <= 1522, "frame {} len {}", f.idx, f.wire_len);
            assert!(
                !f.snap.iter().all(|&b| b == 0),
                "empty snap frame {}",
                f.idx
            );
        }
        // All three protocol classes appear within a few hundred frames.
        let protos: std::collections::HashSet<u8> = out.iter().map(|f| f.proto).collect();
        assert!(protos.contains(&PROTO_SOMEIP));
        assert!(protos.contains(&PROTO_SD));
        assert!(protos.contains(&PROTO_GPTP));
    }

    #[test]
    fn profiles_match_contract_rates() {
        assert_eq!(RateProfile::parse("normal"), Some(RateProfile::Normal));
        assert_eq!(RateProfile::parse("nope"), None);
        assert_eq!(RateProfile::Idle.rate_at(0.0), 50.0);
        assert_eq!(RateProfile::Stress.rate_at(9.9), 5000.0);
        assert_eq!(RateProfile::Burst.rate_at(2.9), 250.0);
        assert_eq!(RateProfile::Burst.rate_at(3.05), 5000.0);
    }
}
