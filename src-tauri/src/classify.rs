//! Source-agnostic, never-dropping wire classification.
use crate::{
    codes::*,
    endpoints::{ipv4_u32, EndpointKey, EndpointTable},
    frame::{GenFrame, SNAP_LEN},
};
use radeau_proto::{
    arp,
    ethernet::{self, EthernetFrame},
    gptp, icmp,
    ipv4::{self, Ipv4Packet},
    ipv6::Ipv6Packet,
    sd,
    someip::{self, SomeIpHeader},
    tcp::TcpSegment,
    udp::{self, UdpDatagram},
};

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
            base.proto = PROTO_IPV6;
            if let Ok(p) = Ipv6Packet::parse(eth.payload) {
                base.svc = p.next_header as u16;
            }
            base.src_ep = endpoints.assign(EndpointKey::Mac(src_mac)).0 as usize;
        }
        ethernet::ETHERTYPE_IPV4 => classify_ipv4(&mut base, frame, eth.payload, l2off, endpoints),
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
                base.svc = u.src_port;
                base.method = u.dst_port;
                base.snap = snap(frame, base.payload_off as usize);
                if someip_plausible(u.payload) {
                    let (h, p): (SomeIpHeader, &[u8]) =
                        someip::parse(u.payload).expect("plausibility bounds header");
                    base.svc = h.service_id;
                    base.method = h.method_id;
                    base.session = h.session_id as i32;
                    base.msg_type = someip_ty(h.message_type);
                    if h.service_id == someip::SD_SERVICE_ID && h.method_id == someip::SD_METHOD_ID
                    {
                        base.proto = PROTO_SD;
                        base.msg_type = sd_ty(p)
                    } else {
                        base.proto = PROTO_SOMEIP
                    }
                }
            }
        }
        ipv4::PROTOCOL_TCP => {
            base.proto = PROTO_TCP;
            if let Ok(t) = TcpSegment::parse(ip.payload) {
                base.svc = t.src_port;
                base.method = t.dst_port;
                base.payload_off = (l4off + t.data_offset as usize * 4) as u16;
                base.snap = snap(frame, base.payload_off as usize)
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
        p => {
            base.proto = PROTO_IPV4_OTHER;
            base.svc = p as u16;
            base.method = 0;
            base.payload_off = l4off as u16;
            base.snap = snap(frame, l4off)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
