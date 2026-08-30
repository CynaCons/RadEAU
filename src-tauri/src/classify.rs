//! Source-agnostic, never-dropping wire classification.
use crate::{
    codes::*,
    endpoints::{ipv4_u32, EndpointKey, EndpointTable},
    frame::{GenFrame, SNAP_LEN},
};
use radeau_proto::{
    arp, avtp, dhcp, dns, doip, eapol,
    ethernet::{self, EthernetFrame},
    gptp, http, icmp, icmpv6, igmp,
    ipv4::{self, Ipv4Packet},
    ipv6::{self, Ipv6Packet},
    lldp, macsec, ntp, sctp, sd, snmp,
    someip::{self, SomeIpHeader},
    ssdp, ssh,
    tcp::TcpSegment,
    tftp, tls,
    udp::{self, UdpDatagram},
};

fn set_doip_columns(base: &mut GenFrame, header: doip::DoipHeader, body: &[u8]) {
    base.proto = PROTO_DOIP;
    base.svc = 0;
    base.method = 0;
    base.msg_type = doip::ty_code(header.payload_type);
    base.session = -1;
    if let Ok(payload) = doip::parse_payload(header, body) {
        use doip::DoipPayload::*;
        match payload {
            VehicleAnnouncement {
                logical_address, ..
            } => base.svc = logical_address,
            RoutingActivationRequest { source_address, .. }
            | AliveCheckResponse { source_address } => base.svc = source_address,
            RoutingActivationResponse { entity_address, .. } => base.method = entity_address,
            Diagnostic {
                source_address,
                target_address,
                uds,
            } => {
                base.svc = source_address;
                base.method = target_address;
                base.session = uds.first().copied().map_or(-1, i32::from);
            }
            DiagnosticAck {
                source_address,
                target_address,
                ..
            }
            | DiagnosticNack {
                source_address,
                target_address,
                ..
            } => {
                base.svc = source_address;
                base.method = target_address;
            }
            _ => {}
        }
    }
}

fn mac_u64(mac: [u8; 6]) -> u64 {
    mac.into_iter().fold(0, |v, b| (v << 8) | u64::from(b))
}
fn snap(frame: &[u8], offset: usize) -> [u8; SNAP_LEN] {
    let mut out = [0; SNAP_LEN];
    if let Some(p) = frame.get(offset..) {
        let n = p.len().min(SNAP_LEN);
        out[..n].copy_from_slice(&p[..n]);
    }
    out
}
fn gptp_ty(t: u8) -> u8 {
    match t {
        0x0 => GPTP_TY_SYNC,
        0x8 => GPTP_TY_FOLLOW_UP,
        0x2 => GPTP_TY_PDELAY_REQ,
        0x3 => GPTP_TY_PDELAY_RESP,
        0xa => GPTP_TY_PDELAY_RESP_FOLLOW_UP,
        0xb => GPTP_TY_ANNOUNCE,
        0xc => GPTP_TY_SIGNALING,
        _ => GPTP_TY_OTHER,
    }
}
fn someip_ty(t: u8) -> u8 {
    match t {
        someip::MSG_NOTIFICATION => SOMEIP_TY_NOTIFICATION,
        someip::MSG_REQUEST => SOMEIP_TY_REQUEST,
        someip::MSG_REQUEST_NO_RETURN => SOMEIP_TY_REQUEST_NO_RETURN,
        someip::MSG_RESPONSE => SOMEIP_TY_RESPONSE,
        someip::MSG_ERROR => SOMEIP_TY_ERROR,
        _ => SOMEIP_TY_OTHER,
    }
}
fn sd_ty(payload: &[u8]) -> u8 {
    match sd::parse(payload) {
        Ok(msg) => match msg.entries.first() {
            None => SD_TY_EMPTY,
            Some(e) => match e.entry_type {
                sd::ENTRY_OFFER_SERVICE => {
                    if e.ttl == 0 {
                        SD_TY_STOP_OFFER
                    } else {
                        SD_TY_OFFER
                    }
                }
                sd::ENTRY_FIND_SERVICE => SD_TY_FIND,
                sd::ENTRY_SUBSCRIBE_EVENTGROUP => {
                    if e.ttl == 0 {
                        SD_TY_STOP_SUBSCRIBE
                    } else {
                        SD_TY_SUBSCRIBE
                    }
                }
                sd::ENTRY_SUBSCRIBE_EVENTGROUP_ACK => {
                    if e.ttl == 0 {
                        SD_TY_SUBSCRIBE_NACK
                    } else {
                        SD_TY_SUBSCRIBE_ACK
                    }
                }
                _ => SD_TY_OTHER,
            },
        },
        Err(_) => SD_TY_OTHER,
    }
}
pub fn someip_plausible(payload: &[u8]) -> bool {
    if payload.len() < 16 {
        return false;
    }
    let length = u32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]]) as usize;
    payload[12] == 1
        && length >= 8
        && length <= payload.len() - 8
        && matches!(payload[14], 0x00 | 0x01 | 0x02 | 0x80 | 0x81)
}
pub fn sim_direction(_record_direction: u8) -> u8 {
    DIR_RX
}

pub fn classify_frame(
    frame: &[u8],
    idx: u64,
    t_s: f64,
    dir: u8,
    endpoints: &mut EndpointTable,
) -> GenFrame {
    let wire_len = frame.len() as u32;
    let fallback_mac = if frame.len() >= 12 {
        mac_u64(frame[6..12].try_into().expect("exact"))
    } else {
        0
    };
    let malformed = |src_ep| GenFrame {
        idx,
        t_s,
        dir,
        src_ep,
        proto: PROTO_MALFORMED,
        svc: 0,
        method: 0,
        msg_type: 0,
        session: -1,
        wire_len,
        snap: [0; SNAP_LEN],
        src_ip: 0,
        dst_ip: 0,
        src_mac: fallback_mac,
        vlan: -1,
        payload_off: 0,
    };
    let eth = match EthernetFrame::parse(frame) {
        Ok(e) => e,
        Err(_) => {
            let ep = if frame.len() >= 12 {
                endpoints.assign(EndpointKey::Mac(fallback_mac)).0 as usize
            } else {
                ENDPOINT_OVERFLOW as usize
            };
            return malformed(ep);
        }
    };
    let src_mac = mac_u64(eth.src);
    let vlan = eth.vlan.map_or(-1, |v| v.vid as i16);
    let l2off = eth.header_len;
    let mut base = GenFrame {
        idx,
        t_s,
        dir,
        src_ep: 0,
        proto: PROTO_OTHER,
        svc: eth.ethertype,
        method: 0,
        msg_type: 0,
        session: -1,
        wire_len,
        snap: snap(frame, l2off),
        src_ip: 0,
        dst_ip: 0,
        src_mac,
        vlan,
        payload_off: l2off as u16,
    };
    match eth.ethertype {
        ethernet::ETHERTYPE_GPTP => {
            base.proto = PROTO_GPTP;
            if let Ok(p) = gptp::parse(eth.payload) {
                base.svc = p.domain as u16;
                base.method = p.sequence_id;
                base.msg_type = gptp_ty(p.msg_type)
            } else {
                base.msg_type = GPTP_TY_OTHER
            }
            base.src_ep = endpoints.assign(EndpointKey::Mac(src_mac)).0 as usize;
        }
        ethernet::ETHERTYPE_ARP => {
            base.proto = PROTO_ARP;
            if let Ok(p) = arp::ArpPacket::parse(eth.payload) {
                base.svc = p.opcode;
                base.msg_type = match p.opcode {
                    arp::OPCODE_REQUEST => ARP_TY_REQUEST,
                    arp::OPCODE_REPLY => ARP_TY_REPLY,
                    _ => ARP_TY_OTHER,
                };
                base.src_ip = ipv4_u32(p.sender_ip);
                base.dst_ip = ipv4_u32(p.target_ip);
                let key = if base.src_ip != 0 {
                    EndpointKey::Ipv4(base.src_ip)
                } else {
                    EndpointKey::Mac(src_mac)
                };
                base.src_ep = endpoints.assign(key).0 as usize;
            } else {
                base.msg_type = ARP_TY_OTHER;
                base.src_ep = endpoints.assign(EndpointKey::Mac(src_mac)).0 as usize;
            }
        }
        ethernet::ETHERTYPE_IPV6 => {
            base.src_ep = endpoints.assign(EndpointKey::Mac(src_mac)).0 as usize;
            classify_ipv6(&mut base, frame, eth.payload, l2off);
        }
        ethernet::ETHERTYPE_IPV4 => classify_ipv4(&mut base, frame, eth.payload, l2off, endpoints),
        lldp::ETHERTYPE => {
            base.proto = PROTO_LLDP;
            base.svc = 0;
            base.msg_type = 0;
            base.src_ep = endpoints.assign(EndpointKey::Mac(src_mac)).0 as usize;
        }
        avtp::ETHERTYPE => {
            base.proto = PROTO_AVTP;
            if let Ok(h) = avtp::parse(eth.payload) {
                base.msg_type = h.subtype;
            }
            base.src_ep = endpoints.assign(EndpointKey::Mac(src_mac)).0 as usize;
        }
        macsec::ETHERTYPE => {
            base.proto = PROTO_MACSEC;
            base.msg_type = 0;
            base.src_ep = endpoints.assign(EndpointKey::Mac(src_mac)).0 as usize;
        }
        eapol::ETHERTYPE => {
            base.proto = PROTO_EAPOL;
            if let Ok(h) = eapol::parse(eth.payload) {
                base.msg_type = h.packet_type;
            }
            base.src_ep = endpoints.assign(EndpointKey::Mac(src_mac)).0 as usize;
        }
        _ => base.src_ep = endpoints.assign(EndpointKey::Mac(src_mac)).0 as usize,
    }
    base
}

fn classify_ipv4(
    base: &mut GenFrame,
    frame: &[u8],
    payload: &[u8],
    l2off: usize,
    endpoints: &mut EndpointTable,
) {
    let ip = match Ipv4Packet::parse(payload) {
        Ok(p) => p,
        Err(_) => {
            base.proto = PROTO_IPV4_OTHER;
            base.svc = 0;
            base.src_ep = endpoints.assign(EndpointKey::Mac(base.src_mac)).0 as usize;
            return;
        }
    };
    base.src_ip = ipv4_u32(ip.src);
    base.dst_ip = ipv4_u32(ip.dst);
    base.src_ep = endpoints.assign(EndpointKey::Ipv4(base.src_ip)).0 as usize;
    let ihl = (payload[0] & 15) as usize * 4;
    let l4off = l2off + ihl;
    match ip.protocol {
        ipv4::PROTOCOL_UDP => {
            base.proto = PROTO_UDP;
            base.payload_off = (l4off + udp::HEADER_LEN) as u16;
            if let Ok(u) = UdpDatagram::parse(ip.payload) {
                classify_udp(
                    base,
                    frame,
                    u.src_port,
                    u.dst_port,
                    u.payload,
                    l4off + udp::HEADER_LEN,
                );
            }
        }
        ipv4::PROTOCOL_TCP => {
            base.proto = PROTO_TCP;
            if let Ok(t) = TcpSegment::parse(ip.payload) {
                classify_tcp(
                    base,
                    frame,
                    t.src_port,
                    t.dst_port,
                    t.payload,
                    l4off + t.data_offset as usize * 4,
                );
            } else {
                base.payload_off = l4off as u16;
                base.snap = snap(frame, l4off)
            }
        }
        ipv4::PROTOCOL_ICMP => {
            base.proto = PROTO_ICMP;
            base.payload_off = (l4off + icmp::HEADER_LEN) as u16;
            if let Ok(i) = icmp::IcmpPacket::parse(ip.payload) {
                base.svc = i.icmp_type as u16;
                base.method = i.code as u16;
                base.snap = snap(frame, base.payload_off as usize)
            }
        }
        2 => {
            base.proto = PROTO_IGMP;
            base.payload_off = l4off as u16;
            base.snap = snap(frame, l4off);
            if let Ok(packet) = igmp::IgmpMessage::parse(ip.payload) {
                base.svc = packet.msg_type as u16;
                base.msg_type = packet.msg_type;
            }
        }
        132 => classify_sctp(base, frame, ip.payload, l4off),
        p => {
            base.proto = PROTO_IPV4_OTHER;
            base.svc = p as u16;
            base.method = 0;
            base.payload_off = l4off as u16;
            base.snap = snap(frame, l4off)
        }
    }
}

fn classify_ipv6(base: &mut GenFrame, frame: &[u8], payload: &[u8], l2off: usize) {
    base.proto = PROTO_IPV6;
    let Ok(ip) = Ipv6Packet::parse(payload) else {
        return;
    };
    let Ok(walk) = ipv6::walk_extensions(ip.next_header, ip.payload) else {
        base.svc = ip.next_header as u16;
        return;
    };
    base.svc = walk.final_next_header as u16;
    let l4off = l2off + ipv6::HEADER_LEN + walk.payload_offset;
    base.payload_off = l4off as u16;
    base.snap = snap(frame, l4off);
    if walk
        .headers
        .iter()
        .any(|h| h.fragment.is_some_and(|f| f.offset > 0))
    {
        return;
    }
    match walk.final_next_header {
        17 => {
            if let Ok(u) = UdpDatagram::parse(walk.payload) {
                classify_udp(
                    base,
                    frame,
                    u.src_port,
                    u.dst_port,
                    u.payload,
                    l4off + udp::HEADER_LEN,
                )
            }
        }
        6 => {
            if let Ok(t) = TcpSegment::parse(walk.payload) {
                classify_tcp(
                    base,
                    frame,
                    t.src_port,
                    t.dst_port,
                    t.payload,
                    l4off + t.data_offset as usize * 4,
                )
            }
        }
        58 => {
            base.proto = PROTO_ICMPV6;
            base.payload_off = (l4off + icmpv6::HEADER_LEN) as u16;
            base.snap = snap(frame, base.payload_off as usize);
            if let Ok(p) = icmpv6::Icmpv6Message::parse(walk.payload) {
                base.svc = p.msg_type as u16;
                base.method = p.code as u16;
                base.msg_type = p.msg_type;
                base.session = i32::from(p.code);
            }
        }
        132 => classify_sctp(base, frame, walk.payload, l4off),
        _ => {}
    }
}

fn ports_match(src: u16, dst: u16, ports: &[u16]) -> bool {
    ports.contains(&src) || ports.contains(&dst)
}

fn classify_udp(
    base: &mut GenFrame,
    frame: &[u8],
    src: u16,
    dst: u16,
    payload: &[u8],
    payload_off: usize,
) {
    base.proto = PROTO_UDP;
    base.svc = src;
    base.method = dst;
    base.session = -1;
    base.payload_off = payload_off as u16;
    base.snap = snap(frame, payload_off);
    if someip_plausible(payload) {
        let (h, p): (SomeIpHeader, &[u8]) =
            someip::parse(payload).expect("plausibility bounds header");
        base.svc = h.service_id;
        base.method = h.method_id;
        base.session = h.session_id as i32;
        base.msg_type = someip_ty(h.message_type);
        if h.service_id == someip::SD_SERVICE_ID && h.method_id == someip::SD_METHOD_ID {
            base.proto = PROTO_SD;
            base.msg_type = sd_ty(p);
        } else {
            base.proto = PROTO_SOMEIP;
        }
    } else if ports_match(src, dst, &[doip::DOIP_PORT]) {
        if let Ok((h, body)) = doip::parse_header(payload) {
            base.payload_off = (payload_off + doip::HEADER_LEN) as u16;
            base.snap = snap(frame, base.payload_off as usize);
            set_doip_columns(base, h, body);
        }
    } else if ports_match(src, dst, &[67, 68]) {
        if let Ok(p) = dhcp::parse(payload) {
            base.proto = PROTO_DHCP;
            base.msg_type = p.message_type.unwrap_or(0);
            base.session = (p.xid & 0x7fff_ffff) as i32;
        }
    } else if ports_match(src, dst, &[546, 547]) {
        if let Ok(p) = dhcp::parse_v6(payload) {
            if (1..=11).contains(&p.msg_type) {
                base.proto = PROTO_DHCP;
                base.msg_type = p.msg_type.saturating_add(DHCP_TY_V6_OFFSET);
                base.session = p.transaction_id as i32;
            }
        }
    } else if ports_match(src, dst, &[53, 5353, 5355]) {
        if let Ok(p) = dns::parse(payload) {
            base.proto = PROTO_DNS;
            let flavor = if ports_match(src, dst, &[5353]) {
                2
            } else if ports_match(src, dst, &[5355]) {
                4
            } else {
                0
            };
            base.msg_type = flavor + u8::from(p.is_response);
            base.session = p.questions.first().map_or(-1, |q| i32::from(q.qtype));
        }
    } else if ports_match(src, dst, &[123]) {
        if let Ok(p) = ntp::parse(payload) {
            base.proto = PROTO_NTP;
            base.msg_type = p.mode;
            base.session = i32::from(p.stratum);
        }
    } else if ports_match(src, dst, &[1900]) {
        if let Ok(p) = ssdp::parse(payload) {
            base.proto = PROTO_SSDP;
            base.msg_type = match p.kind {
                ssdp::SsdpKind::MSearch => SSDP_TY_MSEARCH,
                ssdp::SsdpKind::Notify => SSDP_TY_NOTIFY,
                ssdp::SsdpKind::Response => SSDP_TY_RESPONSE,
            };
        }
    } else if ports_match(src, dst, &[319, 320]) {
        if let Ok(p) = gptp::parse(payload) {
            base.proto = PROTO_PTP;
            base.msg_type = gptp_ty(p.msg_type);
        }
    } else if ports_match(src, dst, &[69]) {
        if let Ok(p) = tftp::parse(payload) {
            base.proto = PROTO_TFTP;
            base.msg_type = match p {
                tftp::TftpPacket::ReadRequest { .. } => 1,
                tftp::TftpPacket::WriteRequest { .. } => 2,
                tftp::TftpPacket::Data { .. } => 3,
                tftp::TftpPacket::Ack { .. } => 4,
                tftp::TftpPacket::Error { .. } => 5,
            };
        }
    } else if ports_match(src, dst, &[161, 162]) {
        if let Ok(p) = snmp::parse(payload) {
            base.proto = PROTO_SNMP;
            base.msg_type = p.pdu_type;
        }
    }
}

fn classify_tcp(
    base: &mut GenFrame,
    frame: &[u8],
    src: u16,
    dst: u16,
    payload: &[u8],
    payload_off: usize,
) {
    base.proto = PROTO_TCP;
    base.svc = src;
    base.method = dst;
    base.session = -1;
    base.payload_off = payload_off as u16;
    base.snap = snap(frame, payload_off);
    if payload.is_empty() {
        return;
    }
    if ports_match(src, dst, &[doip::DOIP_PORT]) && doip::plausible(payload) {
        let (h, body) = doip::parse_header(payload).expect("plausibility checked");
        base.payload_off = (payload_off + doip::HEADER_LEN) as u16;
        base.snap = snap(frame, base.payload_off as usize);
        set_doip_columns(base, h, body);
    } else if ports_match(src, dst, &[80, 8080, 8000]) || http::looks_like_http(payload) {
        if let Ok(p) = http::parse(payload) {
            base.proto = PROTO_HTTP;
            match p {
                http::HttpMessage::Request { method, .. } => {
                    base.msg_type = HTTP_TY_REQUEST;
                    base.session = i32::from(http::method_code(&method));
                }
                http::HttpMessage::Response { status, .. } => {
                    base.msg_type = HTTP_TY_RESPONSE;
                    base.session = i32::from(status);
                }
            }
        }
    } else if ports_match(src, dst, &[443, 8443]) || tls::looks_like_tls(payload) {
        if let Ok(p) = tls::parse(payload) {
            base.proto = PROTO_TLS;
            base.msg_type = p.content_type;
            base.session = match p.handshake {
                Some(tls::Handshake::ClientHello { .. }) => 1,
                Some(tls::Handshake::ServerHello { .. }) => 2,
                Some(tls::Handshake::Other { handshake_type }) => i32::from(handshake_type),
                None => -1,
            };
        }
    } else if ports_match(src, dst, &[22]) {
        if let Ok(p) = ssh::parse(payload) {
            base.proto = PROTO_SSH;
            base.msg_type = match p {
                ssh::SshMessage::Banner { .. } => SSH_TY_BANNER,
                ssh::SshMessage::Packet { .. } => SSH_TY_PACKET,
            };
        }
    }
}

fn classify_sctp(base: &mut GenFrame, frame: &[u8], payload: &[u8], offset: usize) {
    base.proto = PROTO_SCTP;
    base.payload_off = (offset + sctp::HEADER_LEN) as u16;
    base.snap = snap(frame, base.payload_off as usize);
    if let Ok(p) = sctp::SctpPacket::parse(payload) {
        base.svc = p.source_port;
        base.method = p.destination_port;
        base.msg_type = p.chunks.first().map_or(0, |c| c.chunk_type);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use radeau_proto::ethernet::EthernetFrame;

    fn ip_frame(protocol: u8, transport: &[u8]) -> Vec<u8> {
        let mut ip = Vec::new();
        Ipv4Packet::build(
            [10, 42, 0, 99],
            [10, 42, 0, 20],
            protocol,
            1,
            64,
            0,
            transport,
            &mut ip,
        );
        let mut wire = Vec::new();
        EthernetFrame::build(
            [2, 0x52, 0x41, 0x44, 0, 2],
            [2, 0x52, 0x41, 0x44, 0, 1],
            ethernet::ETHERTYPE_IPV4,
            &ip,
            &mut wire,
        );
        wire
    }

    fn classified(protocol: u8, transport: &[u8]) -> GenFrame {
        let mut endpoints = EndpointTable::default();
        classify_frame(
            &ip_frame(protocol, transport),
            0,
            0.0,
            DIR_RX,
            &mut endpoints,
        )
    }

    fn udp_frame(src: u16, dst: u16, payload: &[u8]) -> GenFrame {
        let mut bytes = vec![];
        UdpDatagram::build(
            [10, 42, 0, 99],
            [10, 42, 0, 20],
            src,
            dst,
            payload,
            &mut bytes,
        );
        classified(ipv4::PROTOCOL_UDP, &bytes)
    }

    fn tcp_frame(src: u16, dst: u16, payload: &[u8]) -> GenFrame {
        let mut bytes = vec![];
        TcpSegment::build(src, dst, 1, 0, 0x18, 4096, payload, &mut bytes);
        classified(ipv4::PROTOCOL_TCP, &bytes)
    }

    fn l2_frame(ethertype: u16, payload: &[u8]) -> GenFrame {
        let mut wire = vec![];
        EthernetFrame::build([1; 6], [2; 6], ethertype, payload, &mut wire);
        let mut endpoints = EndpointTable::default();
        classify_frame(&wire, 0, 0.0, DIR_RX, &mut endpoints)
    }

    fn ipv6_frame(next: u8, payload: &[u8]) -> GenFrame {
        let mut ip = vec![];
        Ipv6Packet::build([1; 16], [2; 16], next, 64, payload, &mut ip);
        l2_frame(ethernet::ETHERTYPE_IPV6, &ip)
    }

    fn columns(f: &GenFrame) -> (u8, u16, u16, u8, i32, u16) {
        (
            f.proto,
            f.svc,
            f.method,
            f.msg_type,
            f.session,
            f.payload_off,
        )
    }
    #[test]
    fn direction_is_always_observed() {
        for b in [0, 1, 255] {
            assert_eq!(sim_direction(b), DIR_RX)
        }
    }
    #[test]
    fn runt_never_drops() {
        let mut e = EndpointTable::default();
        let f = classify_frame(&[0; 10], 0, 0.0, DIR_RX, &mut e);
        assert_eq!(f.proto, PROTO_MALFORMED);
        assert_eq!(f.src_ep, ENDPOINT_OVERFLOW as usize);
    }

    #[test]
    fn udp_doip_discovery_is_classified() {
        let mut message = Vec::new();
        doip::build_message(2, 0x0001, &[], &mut message);
        let mut datagram = Vec::new();
        UdpDatagram::build(
            [10, 42, 0, 99],
            [10, 42, 0, 20],
            doip::DOIP_PORT,
            doip::DOIP_PORT,
            &message,
            &mut datagram,
        );
        let frame = classified(ipv4::PROTOCOL_UDP, &datagram);
        assert_eq!(
            (frame.proto, frame.msg_type),
            (PROTO_DOIP, DOIP_TY_VEHICLE_ID_REQ)
        );
        assert_eq!(frame.payload_off, 50);
    }

    #[test]
    fn tcp_diagnostic_columns_and_midstream_fallback() {
        let mut message = Vec::new();
        doip::build_message(2, 0x8001, &[0x0e, 0x80, 0x12, 0x34, 0x3e, 0], &mut message);
        let mut segment = Vec::new();
        TcpSegment::build(
            doip::DOIP_PORT,
            50_000,
            1,
            0,
            0x18,
            4096,
            &message,
            &mut segment,
        );
        let frame = classified(ipv4::PROTOCOL_TCP, &segment);
        assert_eq!((frame.proto, frame.msg_type), (PROTO_DOIP, DOIP_TY_DIAG));
        assert_eq!(
            (frame.svc, frame.method, frame.session),
            (0x0e80, 0x1234, 0x3e)
        );
        assert_eq!(frame.payload_off, 62);

        let mut middle = Vec::new();
        TcpSegment::build(
            doip::DOIP_PORT,
            50_000,
            2,
            0,
            0x18,
            4096,
            &[1; 12],
            &mut middle,
        );
        assert_eq!(classified(ipv4::PROTOCOL_TCP, &middle).proto, PROTO_TCP);
    }

    #[test]
    fn someip_on_sd_port_is_untouched() {
        let mut message = Vec::new();
        someip::build(
            &SomeIpHeader {
                service_id: 0x1234,
                method_id: 0x8001,
                length: 0,
                client_id: 1,
                session_id: 2,
                protocol_version: 1,
                interface_version: 1,
                message_type: someip::MSG_NOTIFICATION,
                return_code: 0,
            },
            &[],
            &mut message,
        );
        let mut datagram = Vec::new();
        UdpDatagram::build([1; 4], [2; 4], 30_490, 30_490, &message, &mut datagram);
        assert_eq!(
            classified(ipv4::PROTOCOL_UDP, &datagram).proto,
            PROTO_SOMEIP
        );
    }

    #[test]
    fn classifies_icmpv6_columns() {
        assert_eq!(
            columns(&ipv6_frame(58, &[128, 0, 0, 0, 0, 1, 0, 2])),
            (PROTO_ICMPV6, 128, 0, 128, 0, 58)
        );
    }

    #[test]
    fn classifies_igmp_columns() {
        let mut p = vec![];
        igmp::build(0x16, 0, [239, 1, 2, 3], &mut p);
        assert_eq!(
            columns(&classified(2, &p)),
            (PROTO_IGMP, 0x16, 0, 0x16, -1, 34)
        );
    }

    #[test]
    fn classifies_dhcp_columns() {
        let mut p = vec![];
        dhcp::build_discover(0x9234_5678, [0, 1, 2, 3, 4, 5], &mut p);
        assert_eq!(
            columns(&udp_frame(68, 67, &p)),
            (PROTO_DHCP, 68, 67, 1, 0x1234_5678, 42)
        );
    }

    #[test]
    fn classifies_dns_columns() {
        let mut p = vec![];
        dns::build_query(7, "example.test", 1, &mut p).unwrap();
        assert_eq!(
            columns(&udp_frame(50_000, 53, &p)),
            (PROTO_DNS, 50_000, 53, DNS_TY_QUERY, 1, 42)
        );
    }

    #[test]
    fn classifies_ntp_columns() {
        let mut p = vec![];
        ntp::build(
            &ntp::NtpPacket {
                li: 0,
                version: 4,
                mode: 4,
                stratum: 2,
                poll: 6,
                precision: 0xec,
                root_delay: 0,
                root_dispersion: 0,
                reference_id: *b"GPS\0",
                reference_ts: 0,
                origin_ts: 0,
                receive_ts: 0,
                transmit_ts: 0x83aa_7e80_8000_0000,
            },
            &mut p,
        );
        assert_eq!(
            columns(&udp_frame(50_000, 123, &p)),
            (PROTO_NTP, 50_000, 123, 4, 2, 42)
        );
    }

    #[test]
    fn classifies_ssdp_columns() {
        let mut p = vec![];
        ssdp::build_notify(&[("NT", "upnp:rootdevice")], &mut p);
        assert_eq!(
            columns(&udp_frame(50_000, 1900, &p)),
            (PROTO_SSDP, 50_000, 1900, SSDP_TY_NOTIFY, -1, 42)
        );
    }

    #[test]
    fn classifies_ptp_columns() {
        let mut p = vec![];
        gptp::build(
            &gptp::GptpMessage {
                msg_type: gptp::MSG_SYNC,
                domain: 3,
                sequence_id: 9,
                correction_ns: 0,
                origin_timestamp_ns: Some(1),
            },
            &mut p,
        );
        assert_eq!(
            columns(&udp_frame(319, 320, &p)),
            (PROTO_PTP, 319, 320, GPTP_TY_SYNC, -1, 42)
        );
    }

    #[test]
    fn classifies_lldp_columns() {
        let p = lldp::build([0, 1, 2, 3, 4, 5], "eth0", 120, "ecu");
        assert_eq!(
            columns(&l2_frame(lldp::ETHERTYPE, &p)),
            (PROTO_LLDP, 0, 0, 0, -1, 14)
        );
    }

    #[test]
    fn classifies_avtp_columns() {
        let p = avtp::build_aaf(7, 2, 3, 4, 5, 2, 24, &[1, 2]);
        assert_eq!(
            columns(&l2_frame(avtp::ETHERTYPE, &p)),
            (PROTO_AVTP, avtp::ETHERTYPE, 0, avtp::AAF_SUBTYPE, -1, 14)
        );
    }

    #[test]
    fn classifies_macsec_columns() {
        let p = [0x2e, 0x12, 0, 0, 0, 7, 1, 2, 3, 4, 5, 6, 0, 9];
        assert_eq!(
            columns(&l2_frame(macsec::ETHERTYPE, &p)),
            (PROTO_MACSEC, macsec::ETHERTYPE, 0, 0, -1, 14)
        );
    }

    #[test]
    fn classifies_eapol_columns() {
        let p = [2, 3, 0, 13, 2, 0x13, 0xca, 0, 16, 0, 0, 0, 0, 0, 0, 0, 42];
        assert_eq!(
            columns(&l2_frame(eapol::ETHERTYPE, &p)),
            (PROTO_EAPOL, eapol::ETHERTYPE, 0, 3, -1, 14)
        );
    }

    #[test]
    fn classifies_http_columns() {
        let f = tcp_frame(50_000, 80, b"GET /status HTTP/1.1\r\nHost: ecu\r\n\r\n");
        assert_eq!(
            columns(&f),
            (
                PROTO_HTTP,
                50_000,
                80,
                HTTP_TY_REQUEST,
                i32::from(http::method_code("GET")),
                54
            )
        );
    }

    #[test]
    fn classifies_tls_columns() {
        let p = tls::build_client_hello("ecu.test", &["h2"]);
        assert_eq!(
            columns(&tcp_frame(50_000, 443, &p)),
            (PROTO_TLS, 50_000, 443, 22, 1, 54)
        );
    }

    #[test]
    fn classifies_ssh_columns() {
        assert_eq!(
            columns(&tcp_frame(50_000, 22, b"SSH-2.0-RadEAU\r\n")),
            (PROTO_SSH, 50_000, 22, SSH_TY_BANNER, -1, 54)
        );
    }

    #[test]
    fn classifies_sctp_columns() {
        let mut chunks = vec![];
        sctp::build_data_chunk(7, 1, 2, 3, 4, &[5], &mut chunks);
        let mut p = vec![];
        sctp::build(5000, 5001, 9, 10, &chunks, &mut p);
        assert_eq!(
            columns(&classified(132, &p)),
            (PROTO_SCTP, 5000, 5001, 0, -1, 46)
        );
    }

    #[test]
    fn classifies_tftp_columns() {
        assert_eq!(
            columns(&udp_frame(50_000, 69, b"\0\x01boot.bin\0octet\0")),
            (PROTO_TFTP, 50_000, 69, 1, -1, 42)
        );
    }

    #[test]
    fn classifies_snmp_columns() {
        let p = [
            0x30, 0x26, 0x02, 0x01, 0x01, 0x04, 0x06, b'p', b'u', b'b', b'l', b'i', b'c', 0xa0,
            0x19, 0x02, 0x01, 0x7b, 0x02, 0x01, 0, 0x02, 0x01, 0, 0x30, 0x0e, 0x30, 0x0c, 0x06,
            0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0, 0x05, 0,
        ];
        assert_eq!(
            columns(&udp_frame(50_000, 161, &p)),
            (PROTO_SNMP, 50_000, 161, 0xa0, -1, 42)
        );
    }

    #[test]
    fn someip_over_ipv6_and_nonfirst_fragment_rules() {
        let mut p = vec![];
        someip::build(
            &SomeIpHeader {
                service_id: 0x1234,
                method_id: 0x8001,
                length: 0,
                client_id: 1,
                session_id: 2,
                protocol_version: 1,
                interface_version: 1,
                message_type: someip::MSG_NOTIFICATION,
                return_code: 0,
            },
            &[],
            &mut p,
        );
        let mut udp = vec![];
        UdpDatagram::build([0; 4], [0; 4], 30_490, 30_490, &p, &mut udp);
        assert_eq!(
            columns(&ipv6_frame(17, &udp)),
            (PROTO_SOMEIP, 0x1234, 0x8001, SOMEIP_TY_NOTIFICATION, 2, 62)
        );

        let mut fragment = vec![17, 0, 0, 8, 0, 0, 0, 1];
        fragment.extend_from_slice(&udp);
        assert_eq!(ipv6_frame(44, &fragment).proto, PROTO_IPV6);
    }

    #[test]
    fn random_application_port_payloads_remain_transport() {
        for port in [
            53, 67, 68, 69, 123, 161, 162, 546, 547, 1900, 319, 320, 5353, 5355,
        ] {
            assert_eq!(
                udp_frame(50_000, port, &[0xde, 0xad, 0xbe, 0xef]).proto,
                PROTO_UDP,
                "UDP port {port}"
            );
        }
        for port in [22, 80, 443, 8000, 8080, 8443] {
            assert_eq!(
                tcp_frame(50_000, port, &[0xde, 0xad, 0xbe, 0xef]).proto,
                PROTO_TCP,
                "TCP port {port}"
            );
        }
    }
}
