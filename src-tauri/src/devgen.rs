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

use radeau_proto::ethernet::{self, EthernetFrame};
use radeau_proto::ipv4::{self, Ipv4Packet};
use radeau_proto::udp::{self, UdpDatagram};

/// Protocol classification codes shared with the UI.
pub const PROTO_SOMEIP: u8 = 0;
pub const PROTO_SD: u8 = 1;
pub const PROTO_GPTP: u8 = 2;

/// Message-type codes shared with the UI.
pub const MSG_EVENT: u8 = 0;
pub const MSG_OFFER: u8 = 1;
pub const MSG_SYNC: u8 = 2;

/// Payload preview bytes carried per frame in the batched event.
pub const SNAP_LEN: usize = 12;

const UDP_PORT_SOMEIP: u16 = 30490;
const IP_IDENT_MASK: u16 = 0xffff;

/// One generated frame: wire bytes plus the projection the UI consumes.
#[derive(Debug, Clone)]
pub struct GenFrame {
    pub idx: u64,
    /// Seconds since session start (session timebase, decision D3).
    pub t_s: f64,
    pub rx: bool,
    /// Index into the endpoint table (10.42.0.11..15).
    pub src_ep: usize,
    pub proto: u8,
    pub svc: u16,
    pub method: u16,
    pub msg_type: u8,
    /// -1 when the frame kind carries no session id (gPTP).
    pub session: i32,
    /// Full wire length incl. Ethernet header.
    pub wire_len: u32,
    /// First payload bytes (UDP payload for L3 frames; L2 payload for gPTP).
    pub snap: [u8; SNAP_LEN],
}

struct ServiceSpec {
    svc: u16,
    method: u16,
    src_ep: usize,
    base_len: usize,
    tx: bool,
}

/// Mirrors the fusion network model (TraceView / ecu-netsim scenario).
const SERVICES: [ServiceSpec; 5] = [
    ServiceSpec { svc: 0x1101, method: 0x8001, src_ep: 0, base_len: 128, tx: false },
    ServiceSpec { svc: 0x1102, method: 0x8001, src_ep: 1, base_len: 96, tx: false },
    ServiceSpec { svc: 0x1103, method: 0x8001, src_ep: 2, base_len: 160, tx: false },
    ServiceSpec { svc: 0x1104, method: 0x8001, src_ep: 3, base_len: 48, tx: false },
    ServiceSpec { svc: 0x1201, method: 0x8001, src_ep: 4, base_len: 144, tx: true },
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
                if elapsed_s % 3.0 < 0.2 { 5000.0 } else { 250.0 }
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
        let mut scratch = Vec::with_capacity(256);
        for _ in 0..n {
            self.t_s += (1.0 / rate) * (0.5 + self.rng.below(1000) as f64 / 1000.0);
            let frame = self.gen_one(&mut scratch);
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
        let mut scratch = Vec::with_capacity(256);
        for _ in 0..n {
            self.t_s += (1.0 / rate) * (0.5 + self.rng.below(1000) as f64 / 1000.0);
            scratch.clear();
            let frame = self.gen_one(&mut scratch);
            out.push((frame, scratch.clone()));
        }
    }

    fn gen_one(&mut self, wire: &mut Vec<u8>) -> GenFrame {
        let roll = self.rng.below(1000);
        let idx = self.idx;
        let t_s = self.t_s;
        self.idx += 1;
        wire.clear();
        if roll < 40 {
            self.gen_sd_offer(idx, t_s, wire)
        } else if roll < 80 {
            self.gen_gptp_sync(idx, t_s, wire)
        } else {
            self.gen_someip_event(idx, t_s, wire)
        }
    }

    fn gen_someip_event(&mut self, idx: u64, t_s: f64, wire: &mut Vec<u8>) -> GenFrame {
        let k = (idx % SERVICES.len() as u64) as usize;
        let s = &SERVICES[k];
        let payload_len = s.base_len + ((self.rng.below(4) * 8) as usize);
        let src_ip = endpoint_ip(s.src_ep);
        let dst_ip = endpoint_ip(4); // events flow toward the fusion ECU

        let payload: Vec<u8> = (0..payload_len)
            .map(|_| (self.rng.next() & 0xff) as u8)
            .collect();
        // UDP datagram, then IPv4 packet around it, then Ethernet II around
        // that — one clean inside-out pass, exactly how the live path builds.
        wire.clear();
        let mut l3 = Vec::with_capacity(
            ipv4::Ipv4Packet::encoded_len(udp::UdpDatagram::encoded_len(payload_len)),
        );
        UdpDatagram::build(src_ip, dst_ip, UDP_PORT_SOMEIP, UDP_PORT_SOMEIP, &payload, &mut l3);
        Ipv4Packet::build(
            src_ip,
            dst_ip,
            ipv4::PROTOCOL_UDP,
            self.ip_ident,
            64,
            0,
            &l3,
            wire,
        );
        let mut full = Vec::with_capacity(EthernetFrame::encoded_len(wire.len()));
        EthernetFrame::build(endpoint_mac(s.src_ep), SWITCH_MAC, ethernet::ETHERTYPE_IPV4, wire, &mut full);
        *wire = full;
        self.ip_ident = (self.ip_ident.wrapping_add(7)) & IP_IDENT_MASK | 1;

        self.sessions[k] = self.sessions[k].wrapping_add(1);
        let parsed = project_from_wire(wire);
        GenFrame {
            idx,
            t_s,
            rx: !s.tx,
            src_ep: s.src_ep,
            proto: PROTO_SOMEIP,
            svc: s.svc,
            method: s.method,
            msg_type: MSG_EVENT,
            session: self.sessions[k],
            wire_len: parsed.0,
            snap: parsed.1,
        }
    }

    fn gen_sd_offer(&mut self, idx: u64, t_s: f64, wire: &mut Vec<u8>) -> GenFrame {
        let s = &SERVICES[self.sd_cycle % SERVICES.len()];
        self.sd_cycle = self.sd_cycle.wrapping_add(1);
        let src_ep = s.src_ep;
        let src_ip = endpoint_ip(src_ep);
        let payload_len = 36;
        let payload: Vec<u8> = (0..payload_len)
            .map(|_| (self.rng.next() & 0xff) as u8)
            .collect();
        let mut l3 = Vec::with_capacity(64);
        UdpDatagram::build(src_ip, SD_MCAST_IP, UDP_PORT_SOMEIP, UDP_PORT_SOMEIP, &payload, &mut l3);
        Ipv4Packet::build(src_ip, SD_MCAST_IP, ipv4::PROTOCOL_UDP, self.ip_ident, 64, 0, &l3, wire);
        self.ip_ident = (self.ip_ident.wrapping_add(7)) & IP_IDENT_MASK | 1;
        let mut full = Vec::with_capacity(EthernetFrame::encoded_len(wire.len()));
        EthernetFrame::build(
            SD_MCAST_MAC,
            endpoint_mac(src_ep),
            ethernet::ETHERTYPE_IPV4,
            wire,
            &mut full,
        );
        *wire = full;
        let parsed = project_from_wire(wire);
        GenFrame {
            idx,
            t_s,
            rx: true,
            src_ep,
            proto: PROTO_SD,
            svc: 0xffff,
            method: 0x8100,
            msg_type: MSG_OFFER,
            session: -1,
            wire_len: parsed.0,
            snap: parsed.1,
        }
    }

    fn gen_gptp_sync(&mut self, idx: u64, t_s: f64, wire: &mut Vec<u8>) -> GenFrame {
        // gPTP rides directly on Ethernet (EtherType 0x88F7), no IP/UDP.
        let gm_ep = 0;
        let payload_len = 30;
        let payload: Vec<u8> = (0..payload_len)
            .map(|_| (self.rng.next() & 0xff) as u8)
            .collect();
        wire.clear();
        EthernetFrame::build(
            SWITCH_MAC,
            endpoint_mac(gm_ep),
            ethernet::ETHERTYPE_GPTP,
            &payload,
            wire,
        );
        GenFrame {
            idx,
            t_s,
            rx: true,
            src_ep: gm_ep,
            proto: PROTO_GPTP,
            svc: 0,
            method: 0,
            msg_type: MSG_SYNC,
            session: -1,
            wire_len: wire.len() as u32,
            snap: snap_from(&payload),
        }
    }
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
            assert!(!f.snap.iter().all(|&b| b == 0), "empty snap frame {}", f.idx);
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
