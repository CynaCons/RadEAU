//! Deterministic background traffic commonly present on an automotive Ethernet link.

use radeau_proto::{
    avtp, dhcp,
    ethernet::{EthernetFrame, ETHERTYPE_IPV4, ETHERTYPE_IPV6},
    icmpv6,
    ipv4::{self, Ipv4Packet},
    ipv6::Ipv6Packet,
    lldp, ntp,
    tcp::TcpSegment,
    tls,
    udp::UdpDatagram,
};

pub struct ScheduledFrame {
    pub port: u16,
    pub frame: Vec<u8>,
}

#[derive(Default)]
pub struct StandardTraffic {
    avtp_sequence: u8,
}

const CAMERA_PORT: u16 = 1;
const FUSION_PORT: u16 = 5;
const TESTER_PORT: u16 = 6;
const CAMERA_MAC: [u8; 6] = [0x02, 0x52, 0x41, 0x44, 0, 1];
const FUSION_MAC: [u8; 6] = [0x02, 0x52, 0x41, 0x44, 0, 5];
const TESTER_MAC: [u8; 6] = [0x02, 0x52, 0x41, 0x44, 0, 0x99];
const CLOCK_MAC: [u8; 6] = [0x02, 0x52, 0x41, 0x44, 0, 0x30];
const SWITCH_MAC: [u8; 6] = [0x02, 0x52, 0x41, 0x44, 0xff, 1];
const CAMERA_IP: [u8; 4] = [10, 42, 0, 11];
const FUSION_IP: [u8; 4] = [10, 42, 0, 20];
const TESTER_IP: [u8; 4] = [10, 42, 0, 99];
const CLOCK_IP: [u8; 4] = [10, 42, 0, 30];
const ALL_HOSTS_V6: [u8; 16] = [0xff, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
const ALL_ROUTERS_V6: [u8; 16] = [0xff, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
const CAMERA_V6: [u8; 16] = [
    0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0x52, 0x41, 0xff, 0xfe, 0x44, 0, 1,
];
const CLOCK_V6: [u8; 16] = [
    0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0x52, 0x41, 0xff, 0xfe, 0x44, 0, 0x30,
];

impl StandardTraffic {
    /// Called once per simulated millisecond in both accelerated and wall-clock paths.
    pub fn frames_at(&mut self, ms: u64, ident: &mut u16) -> Vec<ScheduledFrame> {
        let mut frames = Vec::new();
        match ms {
            0 => frames.push(frame(CAMERA_PORT, ndp_rs())),
            50 => frames.push(frame(FUSION_PORT, ndp_ra())),
            100 => {
                frames.push(frame(CAMERA_PORT, ndp_ns()));
                frames.push(frame(CAMERA_PORT, mdns_announcement(ident)));
            }
            150 => {
                frames.push(frame(FUSION_PORT, ndp_na()));
                frames.push(frame(TESTER_PORT, mdns_query(ident)));
            }
            200 => frames.push(frame(CAMERA_PORT, dhcp4(1, ident))),
            225 => frames.push(frame(CAMERA_PORT, dhcp6_solicit())),
            250 => frames.push(frame(FUSION_PORT, dhcp4(2, ident))),
            300 => frames.push(frame(CAMERA_PORT, dhcp4(3, ident))),
            350 => frames.push(frame(FUSION_PORT, dhcp4(5, ident))),
            3_000 => frames.push(frame(TESTER_PORT, http_tcp(0, ident))),
            3_010 => frames.push(frame(FUSION_PORT, http_tcp(1, ident))),
            3_020 => {
                frames.push(frame(TESTER_PORT, http_tcp(2, ident)));
                frames.push(frame(TESTER_PORT, http_tcp(3, ident)));
            }
            3_030 => frames.push(frame(FUSION_PORT, http_tcp(4, ident))),
            4_000 => frames.push(frame(TESTER_PORT, tls_tcp(0, ident))),
            4_010 => frames.push(frame(FUSION_PORT, tls_tcp(1, ident))),
            4_020 => {
                frames.push(frame(TESTER_PORT, tls_tcp(2, ident)));
                frames.push(frame(TESTER_PORT, tls_tcp(3, ident)));
            }
            4_030 => frames.push(frame(FUSION_PORT, tls_tcp(4, ident))),
            _ => {}
        }

        if ms % 20_000 == 0 {
            frames.push(frame(CAMERA_PORT, ntp_frame(false, ident)));
            frames.push(frame(FUSION_PORT, ntp_frame(true, ident)));
        }
        if ms % 30_000 == 0 {
            frames.push(frame(FUSION_PORT, lldp_frame()));
        }
        if ms % 2_000 == 0 {
            frames.push(frame(FUSION_PORT, ptp_udp(true, ms, ident)));
        }
        if ms % 1_000 == 0 {
            frames.push(frame(FUSION_PORT, ptp_udp(false, ms, ident)));
        }
        // A 48-byte audio payload keeps a five-second capture well below 2 MiB,
        // so the requested 1 kHz cadence is retained.
        let seq = self.avtp_sequence;
        self.avtp_sequence = self.avtp_sequence.wrapping_add(1);
        frames.push(frame(CAMERA_PORT, avtp_frame(seq, ms)));
        frames
    }
}

fn frame(port: u16, frame: Vec<u8>) -> ScheduledFrame {
    ScheduledFrame { port, frame }
}

fn ethernet(dst: [u8; 6], src: [u8; 6], ethertype: u16, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    EthernetFrame::build(dst, src, ethertype, payload, &mut out);
    out
}

fn ipv6_frame(
    dst_mac: [u8; 6],
    src_mac: [u8; 6],
    src: [u8; 16],
    dst: [u8; 16],
    next: u8,
    payload: &[u8],
) -> Vec<u8> {
    let mut ip = Vec::new();
    Ipv6Packet::build(src, dst, next, 255, payload, &mut ip);
    ethernet(dst_mac, src_mac, ETHERTYPE_IPV6, &ip)
}

fn ndp_rs() -> Vec<u8> {
    let mut p = Vec::new();
    icmpv6::build_router_solicitation(
        CAMERA_V6,
        ALL_ROUTERS_V6,
        &[1, 1, 0x02, 0x52, 0x41, 0x44, 0, 1],
        &mut p,
    );
    ipv6_frame(
        [0x33, 0x33, 0, 0, 0, 2],
        CAMERA_MAC,
        CAMERA_V6,
        ALL_ROUTERS_V6,
        58,
        &p,
    )
}

fn ndp_ra() -> Vec<u8> {
    let mut p = Vec::new();
    icmpv6::build_router_advertisement(
        CLOCK_V6,
        ALL_HOSTS_V6,
        64,
        false,
        false,
        1800,
        0,
        0,
        &[1, 1, 0x02, 0x52, 0x41, 0x44, 0, 0x30],
        &mut p,
    );
    ipv6_frame(
        [0x33, 0x33, 0, 0, 0, 1],
        CLOCK_MAC,
        CLOCK_V6,
        ALL_HOSTS_V6,
        58,
        &p,
    )
}

fn ndp_ns() -> Vec<u8> {
    let dst = [0xff, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0xff, 0, 0, 0x30];
    let mut p = Vec::new();
    icmpv6::build_neighbor_solicitation(
        CAMERA_V6,
        dst,
        CLOCK_V6,
        &[1, 1, 0x02, 0x52, 0x41, 0x44, 0, 1],
        &mut p,
    );
    ipv6_frame(
        [0x33, 0x33, 0xff, 0, 0, 0x30],
        CAMERA_MAC,
        CAMERA_V6,
        dst,
        58,
        &p,
    )
}

fn ndp_na() -> Vec<u8> {
    let mut p = Vec::new();
    icmpv6::build_neighbor_advertisement(
        CLOCK_V6,
        CAMERA_V6,
        true,
        true,
        true,
        CLOCK_V6,
        &[2, 1, 0x02, 0x52, 0x41, 0x44, 0, 0x30],
        &mut p,
    );
    ipv6_frame(CAMERA_MAC, CLOCK_MAC, CLOCK_V6, CAMERA_V6, 58, &p)
}

fn udp4(
    src_mac: [u8; 6],
    dst_mac: [u8; 6],
    src: [u8; 4],
    dst: [u8; 4],
    sport: u16,
    dport: u16,
    payload: &[u8],
    ident: &mut u16,
) -> Vec<u8> {
    let mut udp = Vec::new();
    UdpDatagram::build(src, dst, sport, dport, payload, &mut udp);
    let mut ip = Vec::new();
    Ipv4Packet::build(src, dst, ipv4::PROTOCOL_UDP, *ident, 64, 0, &udp, &mut ip);
    *ident = ident.wrapping_add(1).max(1);
    ethernet(dst_mac, src_mac, ETHERTYPE_IPV4, &ip)
}

fn udp6(
    src_mac: [u8; 6],
    dst_mac: [u8; 6],
    src: [u8; 16],
    dst: [u8; 16],
    sport: u16,
    dport: u16,
    payload: &[u8],
) -> Vec<u8> {
    let len = (8 + payload.len()) as u16;
    let mut udp = Vec::with_capacity(len as usize);
    udp.extend_from_slice(&sport.to_be_bytes());
    udp.extend_from_slice(&dport.to_be_bytes());
    udp.extend_from_slice(&len.to_be_bytes());
    udp.extend_from_slice(&[0, 0]);
    udp.extend_from_slice(payload);
    let mut pseudo = Vec::with_capacity(40);
    pseudo.extend_from_slice(&src);
    pseudo.extend_from_slice(&dst);
    pseudo.extend_from_slice(&(u32::from(len)).to_be_bytes());
    pseudo.extend_from_slice(&[0, 0, 0, 17]);
    let checksum = radeau_proto::internet_checksum(&[&pseudo, &udp]);
    udp[6..8].copy_from_slice(&checksum.to_be_bytes());
    ipv6_frame(dst_mac, src_mac, src, dst, 17, &udp)
}

fn dns_name(name: &str, out: &mut Vec<u8>) {
    for label in name.split('.') {
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
}

fn mdns_query(ident: &mut u16) -> Vec<u8> {
    let mut dns = vec![0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    dns_name("_radeau._udp.local", &mut dns);
    dns.extend_from_slice(&[0, 12, 0, 1]);
    udp4(
        TESTER_MAC,
        [1, 0, 0x5e, 0, 0, 0xfb],
        TESTER_IP,
        [224, 0, 0, 251],
        5353,
        5353,
        &dns,
        ident,
    )
}

fn mdns_announcement(ident: &mut u16) -> Vec<u8> {
    let mut dns = vec![0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0];
    dns_name("camera.local", &mut dns);
    dns.extend_from_slice(&[0, 1, 0x80, 1, 0, 0, 0, 120, 0, 4]);
    dns.extend_from_slice(&CAMERA_IP);
    udp4(
        CAMERA_MAC,
        [1, 0, 0x5e, 0, 0, 0xfb],
        CAMERA_IP,
        [224, 0, 0, 251],
        5353,
        5353,
        &dns,
        ident,
    )
}

fn dhcp_payload(kind: u8) -> Vec<u8> {
    let xid = 0x5241_4445;
    let mut out = Vec::new();
    match kind {
        1 => dhcp::build_discover(xid, CAMERA_MAC, &mut out),
        2 => dhcp::build_offer(xid, CAMERA_MAC, CAMERA_IP, FUSION_IP, &mut out),
        3 => build_dhcp_v4(
            1,
            xid,
            [0; 4],
            &[(53, &[3]), (50, &CAMERA_IP), (54, &FUSION_IP)],
            &mut out,
        ),
        5 => build_dhcp_v4(
            2,
            xid,
            CAMERA_IP,
            &[(53, &[5]), (54, &FUSION_IP), (51, &[0, 0, 0x0e, 0x10])],
            &mut out,
        ),
        _ => unreachable!(),
    }
    out
}

fn build_dhcp_v4(op: u8, xid: u32, yiaddr: [u8; 4], options: &[(u8, &[u8])], out: &mut Vec<u8>) {
    out.extend_from_slice(&[op, 1, 6, 0]);
    out.extend_from_slice(&xid.to_be_bytes());
    out.extend_from_slice(&[0, 0, 0x80, 0]);
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&yiaddr);
    out.extend_from_slice(&[0; 8]);
    out.extend_from_slice(&CAMERA_MAC);
    out.extend_from_slice(&[0; 202]);
    out.extend_from_slice(&[0x63, 0x82, 0x53, 0x63]);
    for (code, data) in options {
        out.extend_from_slice(&[*code, data.len() as u8]);
        out.extend_from_slice(data);
    }
    out.push(255);
}

fn dhcp4(kind: u8, ident: &mut u16) -> Vec<u8> {
    let server = kind == 2 || kind == 5;
    udp4(
        if server { FUSION_MAC } else { CAMERA_MAC },
        [0xff; 6],
        if server { FUSION_IP } else { [0; 4] },
        [255; 4],
        if server { 67 } else { 68 },
        if server { 68 } else { 67 },
        &dhcp_payload(kind),
        ident,
    )
}

fn dhcp6_solicit() -> Vec<u8> {
    let mut payload = Vec::new();
    dhcp::build_solicit(
        0x524144,
        &[0, 3, 0, 1, 0x02, 0x52, 0x41, 0x44, 0, 1],
        &mut payload,
    );
    let dst = [0xff, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2];
    udp6(
        CAMERA_MAC,
        [0x33, 0x33, 0, 1, 0, 2],
        CAMERA_V6,
        dst,
        546,
        547,
        &payload,
    )
}

fn ntp_frame(server: bool, ident: &mut u16) -> Vec<u8> {
    let request_ts = 0xe93c_7f00_0000_0000;
    let packet = ntp::NtpPacket {
        li: 0,
        version: 4,
        mode: if server { 4 } else { 3 },
        stratum: if server { 2 } else { 0 },
        poll: 6,
        precision: 0xec,
        root_delay: if server { 0x0001_0000 } else { 0 },
        root_dispersion: 0x0000_8000,
        reference_id: if server { *b"GPS\0" } else { [0; 4] },
        reference_ts: if server { request_ts - (1 << 32) } else { 0 },
        origin_ts: if server { request_ts } else { 0 },
        receive_ts: if server { request_ts + 1 } else { 0 },
        transmit_ts: if server { request_ts + 2 } else { request_ts },
    };
    let mut payload = Vec::new();
    ntp::build(&packet, &mut payload);
    if server {
        udp4(
            FUSION_MAC, CAMERA_MAC, FUSION_IP, CAMERA_IP, 123, 49123, &payload, ident,
        )
    } else {
        udp4(
            CAMERA_MAC, FUSION_MAC, CAMERA_IP, FUSION_IP, 49123, 123, &payload, ident,
        )
    }
}

fn lldp_frame() -> Vec<u8> {
    ethernet(
        [1, 0x80, 0xc2, 0, 0, 0x0e],
        SWITCH_MAC,
        lldp::ETHERTYPE,
        &lldp::build(SWITCH_MAC, "swp1", 120, "RadEAU-Switch"),
    )
}

fn ptp_payload(announce: bool, ms: u64) -> Vec<u8> {
    let len = if announce { 64 } else { 44 };
    let mut p = vec![0; len];
    p[0] = if announce { 0x0b } else { 0x00 };
    p[1] = 2;
    p[2..4].copy_from_slice(&(len as u16).to_be_bytes());
    p[6..8].copy_from_slice(&(if announce { 0x0008u16 } else { 0x0200u16 }).to_be_bytes());
    p[20..28].copy_from_slice(&[0x02, 0x52, 0x41, 0xff, 0xfe, 0x44, 0, 0x30]);
    p[28..30].copy_from_slice(&1u16.to_be_bytes());
    p[30..32].copy_from_slice(&((ms / if announce { 2000 } else { 1000 }) as u16).to_be_bytes());
    p[32] = if announce { 5 } else { 0 };
    p[33] = if announce { 1 } else { 0 };
    if announce {
        p[47..49].copy_from_slice(&37u16.to_be_bytes());
        p[53] = 128;
        p[54] = 248;
        p[55] = 0x22;
        p[56..58].copy_from_slice(&0xffffu16.to_be_bytes());
        p[58] = 128;
        p[61] = 0xa0;
    }
    p
}

fn ptp_udp(announce: bool, ms: u64, ident: &mut u16) -> Vec<u8> {
    udp4(
        CLOCK_MAC,
        [1, 0, 0x5e, 0, 1, 129],
        CLOCK_IP,
        [224, 0, 1, 129],
        if announce { 320 } else { 319 },
        if announce { 320 } else { 319 },
        &ptp_payload(announce, ms),
        ident,
    )
}

fn avtp_frame(seq: u8, ms: u64) -> Vec<u8> {
    let mut samples = [0u8; 48];
    for (i, sample) in samples.iter_mut().enumerate() {
        *sample = seq.wrapping_add(i as u8);
    }
    let payload = avtp::build_aaf(
        0x0252_4144_0001_0001,
        seq,
        (ms * 1_000_000) as u32,
        4,
        5,
        2,
        24,
        &samples,
    );
    ethernet(
        [0x91, 0xe0, 0xf0, 0, 0, 1],
        CAMERA_MAC,
        avtp::ETHERTYPE,
        &payload,
    )
}

#[allow(clippy::too_many_arguments)]
fn tcp4(
    src_mac: [u8; 6],
    dst_mac: [u8; 6],
    src: [u8; 4],
    dst: [u8; 4],
    sport: u16,
    dport: u16,
    seq: u32,
    ack: u32,
    flags: u16,
    payload: &[u8],
    ident: &mut u16,
) -> Vec<u8> {
    let mut tcp = Vec::new();
    TcpSegment::build(sport, dport, seq, ack, flags, 64240, payload, &mut tcp);
    let length = (tcp.len() as u16).to_be_bytes();
    let pseudo = [
        src[0],
        src[1],
        src[2],
        src[3],
        dst[0],
        dst[1],
        dst[2],
        dst[3],
        0,
        ipv4::PROTOCOL_TCP,
        length[0],
        length[1],
    ];
    let checksum = radeau_proto::internet_checksum(&[&pseudo, &tcp]);
    tcp[16..18].copy_from_slice(&checksum.to_be_bytes());
    let mut ip = Vec::new();
    Ipv4Packet::build(src, dst, ipv4::PROTOCOL_TCP, *ident, 64, 0, &tcp, &mut ip);
    *ident = ident.wrapping_add(1).max(1);
    ethernet(dst_mac, src_mac, ETHERTYPE_IPV4, &ip)
}

fn session_frame(
    step: u8,
    server_port: u16,
    client_seq: u32,
    server_seq: u32,
    client_payload: &[u8],
    server_payload: &[u8],
    ident: &mut u16,
) -> Vec<u8> {
    const SYN: u16 = 0x02;
    const ACK: u16 = 0x10;
    const PSH: u16 = 0x08;
    let cp = 50_000 + server_port % 1000;
    match step {
        0 => tcp4(
            TESTER_MAC,
            FUSION_MAC,
            TESTER_IP,
            FUSION_IP,
            cp,
            server_port,
            client_seq,
            0,
            SYN,
            &[],
            ident,
        ),
        1 => tcp4(
            FUSION_MAC,
            TESTER_MAC,
            FUSION_IP,
            TESTER_IP,
            server_port,
            cp,
            server_seq,
            client_seq + 1,
            SYN | ACK,
            &[],
            ident,
        ),
        2 => tcp4(
            TESTER_MAC,
            FUSION_MAC,
            TESTER_IP,
            FUSION_IP,
            cp,
            server_port,
            client_seq + 1,
            server_seq + 1,
            ACK,
            &[],
            ident,
        ),
        3 => tcp4(
            TESTER_MAC,
            FUSION_MAC,
            TESTER_IP,
            FUSION_IP,
            cp,
            server_port,
            client_seq + 1,
            server_seq + 1,
            PSH | ACK,
            client_payload,
            ident,
        ),
        4 => tcp4(
            FUSION_MAC,
            TESTER_MAC,
            FUSION_IP,
            TESTER_IP,
            server_port,
            cp,
            server_seq + 1,
            client_seq + 1 + client_payload.len() as u32,
            PSH | ACK,
            server_payload,
            ident,
        ),
        _ => unreachable!(),
    }
}

fn http_tcp(step: u8, ident: &mut u16) -> Vec<u8> {
    session_frame(step, 80, 0x1000_0000, 0x2000_0000, b"GET /status HTTP/1.1\r\nHost: fusion.local\r\nUser-Agent: RadEAU\r\n\r\n", b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}", ident)
}

fn client_hello() -> Vec<u8> {
    tls::build_client_hello("fusion.local", &["http/1.1"])
}

fn server_hello() -> Vec<u8> {
    let mut body = vec![0x03, 0x03];
    body.extend(32u8..64);
    body.extend_from_slice(&[0, 0x13, 1, 0, 0, 0]);
    tls_record(2, &body)
}

fn tls_record(handshake_type: u8, body: &[u8]) -> Vec<u8> {
    let handshake_len = body.len() as u32;
    let record_len = body.len() + 4;
    let mut out = vec![
        22,
        3,
        3,
        (record_len >> 8) as u8,
        record_len as u8,
        handshake_type,
        (handshake_len >> 16) as u8,
        (handshake_len >> 8) as u8,
        handshake_len as u8,
    ];
    out.extend_from_slice(body);
    out
}

fn tls_tcp(step: u8, ident: &mut u16) -> Vec<u8> {
    session_frame(
        step,
        443,
        0x3000_0000,
        0x4000_0000,
        &client_hello(),
        &server_hello(),
        ident,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_has_required_cadences_and_exchanges() {
        let mut traffic = StandardTraffic::default();
        let mut ident = 1;
        let counts = (0..=40_000)
            .map(|ms| (ms, traffic.frames_at(ms, &mut ident).len()))
            .collect::<Vec<_>>();
        assert!(counts[0].1 >= 6);
        assert_eq!(counts[1].1, 1); // AVTP at 1 kHz
        assert!(counts[2_000].1 >= 3); // AVTP + PTP Sync + Announce
        assert!(counts[20_000].1 >= 4); // AVTP + PTP + NTP pair
        assert!(counts[30_000].1 >= 3); // AVTP + PTP + LLDP
        assert!(counts[3_000].1 >= 2 && counts[3_030].1 >= 2);
        assert!(counts[4_000].1 >= 3 && counts[4_030].1 >= 2);
    }

    #[test]
    fn ndp_checksums_are_valid() {
        for wire in [ndp_rs(), ndp_ra(), ndp_ns(), ndp_na()] {
            let eth = EthernetFrame::parse(&wire).unwrap();
            let ip = Ipv6Packet::parse(eth.payload).unwrap();
            assert!(icmpv6::checksum_ok(&ip.src, &ip.dst, ip.payload));
        }
    }

    #[test]
    fn representative_frames_are_byte_exact() {
        // Full-frame FNV-1a goldens make every locally encoded/builder-backed
        // frame kind byte-exact without embedding several kilobytes of hex.
        fn hash(bytes: &[u8]) -> u64 {
            bytes.iter().fold(0xcbf29ce484222325, |h, b| {
                (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
            })
        }
        let mut ident = 1;
        let vectors = [
            ndp_rs(),
            ndp_ra(),
            ndp_ns(),
            ndp_na(),
            mdns_announcement(&mut ident),
            mdns_query(&mut ident),
            dhcp4(1, &mut ident),
            dhcp4(2, &mut ident),
            dhcp4(3, &mut ident),
            dhcp4(5, &mut ident),
            dhcp6_solicit(),
            ntp_frame(false, &mut ident),
            ntp_frame(true, &mut ident),
            lldp_frame(),
            ptp_udp(true, 0, &mut ident),
            ptp_udp(false, 0, &mut ident),
            avtp_frame(0, 0),
            http_tcp(0, &mut ident),
            http_tcp(1, &mut ident),
            http_tcp(2, &mut ident),
            http_tcp(3, &mut ident),
            http_tcp(4, &mut ident),
            tls_tcp(0, &mut ident),
            tls_tcp(1, &mut ident),
            tls_tcp(2, &mut ident),
            tls_tcp(3, &mut ident),
            tls_tcp(4, &mut ident),
        ];
        let actual = vectors.iter().map(|v| hash(v)).collect::<Vec<_>>();
        assert_eq!(
            actual,
            vec![
                314718772672205376,
                6572476219794967372,
                13191536383904594914,
                2333512857049666707,
                4065741243843360906,
                12425233882866029299,
                6248041287568820988,
                10057016627540680813,
                17166926244807185193,
                12042097979876828351,
                14881175686169342558,
                6984346182929935968,
                7488499704495916415,
                6201116551728594026,
                450982032859915922,
                2838172723874747123,
                7978532694214786069,
                10067452268498207307,
                18163268838590668203,
                6559559796493653449,
                2157504006211106250,
                2628686481137324881,
                4476518858784378401,
                5260007075483505249,
                17348565843674940979,
                1384222731442708880,
                454808260701682488,
            ]
        );
    }
}
