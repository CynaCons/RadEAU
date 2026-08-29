//! Cold-path raw-frame retention and protocol dissection.  The reader only
//! takes the ring lock long enough to append one already-built wire frame.

use std::collections::VecDeque;

use radeau_proto::{arp, ethernet, gptp, icmp, ipv4, ipv6, sd, someip, tcp, udp, ParseError};
use serde::Serialize;
use tauri::State;

/// Maximum retained frames; byte capacity is enforced independently.
pub const FRAME_RING_CAP: usize = 65_536;
/// Maximum retained raw-wire bytes (96 MiB).
pub const FRAME_RING_BYTES: usize = 96 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameField {
    pub name: String,
    pub value: String,
    pub offset: usize,
    pub len: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameLayer {
    pub protocol: String,
    pub summary: String,
    pub fields: Vec<FrameField>,
}

/// On-demand detail sent to the UI. `bytes` is unseparated uppercase hex.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDetail {
    pub idx: u64,
    #[serde(rename = "tS")]
    pub t_s: f64,
    pub wire_len: usize,
    pub payload_offset: usize,
    pub layers: Vec<FrameLayer>,
    pub bytes: String,
    pub decoded: Option<Vec<radeau_catalog::DecodedSignal>>,
}

#[derive(Debug)]
struct BufferedFrame {
    idx: u64,
    t_s: f64,
    wire: Vec<u8>,
}

/// Session-local FIFO. Frames are assigned continuous indexes by both readers,
/// so the greatest seen index distinguishes an evicted frame from an unknown one
/// without retaining unbounded metadata.
#[derive(Debug)]
pub struct FrameRing {
    frames: VecDeque<BufferedFrame>,
    total_bytes: usize,
    greatest_seen: Option<u64>,
    frame_cap: usize,
    byte_cap: usize,
}

impl Default for FrameRing {
    fn default() -> Self {
        Self::with_limits(FRAME_RING_CAP, FRAME_RING_BYTES)
    }
}

impl FrameRing {
    fn with_limits(frame_cap: usize, byte_cap: usize) -> Self {
        Self {
            frames: VecDeque::new(),
            total_bytes: 0,
            greatest_seen: None,
            frame_cap,
            byte_cap,
        }
    }
    pub fn clear(&mut self) {
        self.frames.clear();
        self.total_bytes = 0;
        self.greatest_seen = None;
    }

    /// Appends a full frame and evicts oldest frames for either hard bound.
    pub fn push(&mut self, idx: u64, t_s: f64, wire: Vec<u8>) {
        self.greatest_seen = Some(self.greatest_seen.map_or(idx, |seen| seen.max(idx)));
        self.total_bytes = self.total_bytes.saturating_add(wire.len());
        self.frames.push_back(BufferedFrame { idx, t_s, wire });
        while self.frames.len() > self.frame_cap || self.total_bytes > self.byte_cap {
            if let Some(evicted) = self.frames.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(evicted.wire.len());
            } else {
                break;
            }
        }
    }

    pub fn detail(
        &self,
        idx: u64,
        catalog: Option<&radeau_catalog::Catalog>,
    ) -> Result<FrameDetail, String> {
        if let Some(frame) = self.frames.iter().find(|frame| frame.idx == idx) {
            return Ok(dissect_with_catalog(
                frame.idx,
                frame.t_s,
                &frame.wire,
                catalog,
            ));
        }
        match self.greatest_seen {
            Some(seen) if idx <= seen => Err("frame no longer buffered".into()),
            _ => Err("unknown frame".into()),
        }
    }
}

fn field(name: &str, value: String, offset: usize, len: usize) -> FrameField {
    FrameField {
        name: name.into(),
        value,
        offset,
        len,
    }
}

fn mac(value: &[u8]) -> String {
    value
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn ip(value: &[u8]) -> String {
    format!("{}.{}.{}.{}", value[0], value[1], value[2], value[3])
}

fn malformed(name: &str, error: ParseError) -> FrameLayer {
    let reason = match error {
        ParseError::Truncated => "truncated",
        ParseError::Malformed => "invalid",
    };
    FrameLayer {
        protocol: name.into(),
        summary: format!("malformed: {reason}"),
        fields: Vec::new(),
    }
}

/// Dissects only successful codec layers. A codec error becomes the final
/// layer; malformed input is therefore still inspectable and never an IPC err.
#[cfg(test)]
pub fn dissect(idx: u64, t_s: f64, wire: &[u8]) -> FrameDetail {
    dissect_with_catalog(idx, t_s, wire, None)
}
pub fn dissect_with_catalog(
    idx: u64,
    t_s: f64,
    wire: &[u8],
    catalog: Option<&radeau_catalog::Catalog>,
) -> FrameDetail {
    let mut layers = Vec::new();
    let mut payload_offset = wire.len();
    let eth = match ethernet::EthernetFrame::parse(wire) {
        Ok(value) => value,
        Err(error) => {
            layers.push(malformed("Ethernet II", error));
            return detail(idx, t_s, wire, payload_offset, layers);
        }
    };
    let mut type_offset = 12usize;
    layers.push(FrameLayer {
        protocol: "Ethernet II".into(),
        summary: format!(
            "{} → {} · EtherType 0x{:04X}",
            mac(&eth.src),
            mac(&eth.dst),
            eth.ethertype
        ),
        fields: vec![
            field("Destination", mac(&eth.dst), 0, 6),
            field("Source", mac(&eth.src), 6, 6),
            field("EtherType", format!("0x{:04X}", eth.ethertype), 12, 2),
        ],
    });
    let mut cursor = 14usize;
    let mut tag_no = 0;
    let mut outer_type = u16::from_be_bytes([wire[12], wire[13]]);
    while matches!(
        outer_type,
        ethernet::ETHERTYPE_VLAN | ethernet::ETHERTYPE_QINQ
    ) && cursor + 4 <= wire.len()
    {
        let tci = u16::from_be_bytes([wire[cursor], wire[cursor + 1]]);
        let inner = u16::from_be_bytes([wire[cursor + 2], wire[cursor + 3]]);
        tag_no += 1;
        layers.push(FrameLayer {
            protocol: "802.1Q".into(),
            summary: format!("VLAN {} · PCP {}", tci & 0x0fff, tci >> 13),
            fields: vec![
                field("PCP", (tci >> 13).to_string(), cursor, 2),
                field("DEI", ((tci >> 12) & 1).to_string(), cursor, 2),
                field("VID", (tci & 0x0fff).to_string(), cursor, 2),
                field("Inner EtherType", format!("0x{inner:04X}"), cursor + 2, 2),
            ],
        });
        type_offset = cursor + 2;
        cursor += 4;
        outer_type = inner;
        if tag_no == 2 {
            break;
        }
    }
    layers[0].fields[2].offset = type_offset;
    let l3_offset = eth.header_len;
    if eth.ethertype == ethernet::ETHERTYPE_GPTP {
        return dissect_gptp(idx, t_s, wire, eth.payload, l3_offset, layers);
    }
    if eth.ethertype == ethernet::ETHERTYPE_ARP {
        match arp::ArpPacket::parse(eth.payload) {
            Ok(p) => layers.push(FrameLayer {
                protocol: "ARP".into(),
                summary: format!(
                    "{} → {} · opcode {}",
                    ip(&p.sender_ip),
                    ip(&p.target_ip),
                    p.opcode
                ),
                fields: vec![
                    field("Opcode", p.opcode.to_string(), l3_offset + 6, 2),
                    field("Sender MAC", mac(&p.sender_mac), l3_offset + 8, 6),
                    field("Sender IP", ip(&p.sender_ip), l3_offset + 14, 4),
                    field("Target MAC", mac(&p.target_mac), l3_offset + 18, 6),
                    field("Target IP", ip(&p.target_ip), l3_offset + 24, 4),
                ],
            }),
            Err(e) => layers.push(malformed("ARP", e)),
        }
        return detail(idx, t_s, wire, l3_offset, layers);
    }
    if eth.ethertype == ethernet::ETHERTYPE_IPV6 {
        match ipv6::Ipv6Packet::parse(eth.payload) {
            Ok(p) => {
                let src = std::net::Ipv6Addr::from(p.src).to_string();
                let dst = std::net::Ipv6Addr::from(p.dst).to_string();
                layers.push(FrameLayer {
                    protocol: "IPv6".into(),
                    summary: format!("{src} → {dst} · next header {}", p.next_header),
                    fields: vec![
                        field("Source", src, l3_offset + 8, 16),
                        field("Destination", dst, l3_offset + 24, 16),
                        field("Next header", p.next_header.to_string(), l3_offset + 6, 1),
                        field("Hop limit", p.hop_limit.to_string(), l3_offset + 7, 1),
                    ],
                });
                payload_offset = l3_offset + ipv6::HEADER_LEN;
                if p.next_header == 58 {
                    add_icmp(&mut layers, p.payload, payload_offset, "ICMPv6");
                    payload_offset += icmp::HEADER_LEN.min(p.payload.len());
                }
            }
            Err(e) => layers.push(malformed("IPv6", e)),
        }
        return detail(idx, t_s, wire, payload_offset, layers);
    }
    if eth.ethertype != ethernet::ETHERTYPE_IPV4 {
        return detail(idx, t_s, wire, l3_offset, layers);
    }
    let ip_packet = match ipv4::Ipv4Packet::parse(eth.payload) {
        Ok(value) => value,
        Err(error) => {
            layers.push(malformed("IPv4", error));
            return detail(idx, t_s, wire, payload_offset, layers);
        }
    };
    let ihl = ((eth.payload[0] & 0x0f) as usize) * 4;
    layers.push(FrameLayer {
        protocol: "IPv4".into(),
        summary: format!(
            "{} → {} · protocol {}",
            ip(&ip_packet.src),
            ip(&ip_packet.dst),
            ip_packet.protocol
        ),
        fields: vec![
            field("Source", ip(&ip_packet.src), l3_offset + 12, 4),
            field("Destination", ip(&ip_packet.dst), l3_offset + 16, 4),
            field("TTL", ip_packet.ttl.to_string(), l3_offset + 8, 1),
            field("Protocol", ip_packet.protocol.to_string(), l3_offset + 9, 1),
        ],
    });
    let l4_offset = l3_offset + ihl;
    if ip_packet.protocol == ipv4::PROTOCOL_TCP {
        match tcp::TcpSegment::parse(ip_packet.payload) {
            Ok(s) => {
                let names = [
                    (0x100, "NS"),
                    (0x80, "CWR"),
                    (0x40, "ECE"),
                    (0x20, "URG"),
                    (0x10, "ACK"),
                    (8, "PSH"),
                    (4, "RST"),
                    (2, "SYN"),
                    (1, "FIN"),
                ]
                .into_iter()
                .filter_map(|(b, n)| (s.flags & b != 0).then_some(n))
                .collect::<Vec<_>>()
                .join(" ");
                layers.push(FrameLayer {
                    protocol: "TCP".into(),
                    summary: format!("{} → {} · {names}", s.src_port, s.dst_port),
                    fields: vec![
                        field("Source port", s.src_port.to_string(), l4_offset, 2),
                        field("Destination port", s.dst_port.to_string(), l4_offset + 2, 2),
                        field("Sequence", s.seq.to_string(), l4_offset + 4, 4),
                        field("Acknowledgment", s.ack.to_string(), l4_offset + 8, 4),
                        field("Flags", names, l4_offset + 12, 2),
                        field("Window", s.window.to_string(), l4_offset + 14, 2),
                        field(
                            "Payload length",
                            s.payload.len().to_string(),
                            l4_offset + s.data_offset as usize * 4,
                            0,
                        ),
                    ],
                });
                payload_offset = l4_offset + s.data_offset as usize * 4;
            }
            Err(e) => layers.push(malformed("TCP", e)),
        }
        return detail(idx, t_s, wire, payload_offset, layers);
    }
    if ip_packet.protocol == ipv4::PROTOCOL_ICMP {
        add_icmp(&mut layers, ip_packet.payload, l4_offset, "ICMP");
        return detail(
            idx,
            t_s,
            wire,
            (l4_offset + icmp::HEADER_LEN).min(wire.len()),
            layers,
        );
    }
    if ip_packet.protocol != ipv4::PROTOCOL_UDP {
        return detail(idx, t_s, wire, l4_offset, layers);
    }
    let udp_offset = l4_offset;
    let datagram = match udp::UdpDatagram::parse(ip_packet.payload) {
        Ok(value) => value,
        Err(error) => {
            layers.push(malformed("UDP", error));
            return detail(idx, t_s, wire, payload_offset, layers);
        }
    };
    layers.push(FrameLayer {
        protocol: "UDP".into(),
        summary: format!(
            "{} → {} · length {}",
            datagram.src_port,
            datagram.dst_port,
            ip_packet.payload.len()
        ),
        fields: vec![
            field("Source port", datagram.src_port.to_string(), udp_offset, 2),
            field(
                "Destination port",
                datagram.dst_port.to_string(),
                udp_offset + 2,
                2,
            ),
            field(
                "Length",
                (datagram.payload.len() + udp::HEADER_LEN).to_string(),
                udp_offset + 4,
                2,
            ),
        ],
    });
    let someip_offset = udp_offset + udp::HEADER_LEN;
    if !crate::classify::someip_plausible(datagram.payload) {
        layers.push(FrameLayer {
            protocol: "Data".into(),
            summary: format!("{} bytes", datagram.payload.len()),
            fields: vec![],
        });
        return detail(idx, t_s, wire, someip_offset, layers);
    }
    let (header, payload) = someip::parse(datagram.payload).expect("plausibility checked");
    payload_offset = someip_offset + someip::HEADER_LEN;
    add_someip_layer(&mut layers, &header, someip_offset, 1);
    if header.service_id == someip::SD_SERVICE_ID && header.method_id == someip::SD_METHOD_ID {
        match sd::parse(payload) {
            Ok(message) => {
                let fields = message
                    .entries
                    .iter()
                    .enumerate()
                    .map(|(n, entry)| {
                        let kind = if entry.entry_type == sd::ENTRY_OFFER_SERVICE {
                            "OfferService"
                        } else {
                            "FindService"
                        };
                        field(
                            &format!("Entry {}", n + 1),
                            format!(
                                "{kind} 0x{:04X}:{:X} v{}.{} TTL {}",
                                entry.service_id,
                                entry.instance_id,
                                entry.major_version,
                                entry.minor_version,
                                entry.ttl
                            ),
                            payload_offset + 8 + n * 16,
                            16,
                        )
                    })
                    .collect();
                layers.push(FrameLayer {
                    protocol: "SOME/IP-SD".into(),
                    summary: format!("{} service entries", message.entries.len()),
                    fields,
                });
            }
            Err(error) => layers.push(malformed("SOME/IP-SD", error)),
        }
    }
    let decoded = catalog
        .and_then(|c| c.event(header.service_id, header.method_id))
        .map(|event| radeau_catalog::decode(&event.signals, payload));
    let first_len = 8usize.saturating_add(header.length as usize);
    let mut remaining = datagram.payload.get(first_len..).unwrap_or_default();
    let mut offset = someip_offset + first_len;
    let mut number = 2;
    while crate::classify::someip_plausible(remaining) {
        let (next, _) = someip::parse(remaining).expect("plausibility checked");
        add_someip_layer(&mut layers, &next, offset, number);
        let size = 8usize.saturating_add(next.length as usize);
        remaining = remaining.get(size..).unwrap_or_default();
        offset += size;
        number += 1;
    }
    detail_with_decoded(idx, t_s, wire, payload_offset, layers, decoded)
}

fn add_someip_layer(
    layers: &mut Vec<FrameLayer>,
    h: &someip::SomeIpHeader,
    offset: usize,
    number: usize,
) {
    layers.push(FrameLayer {
        protocol: if number == 1 {
            "SOME/IP".into()
        } else {
            format!("SOME/IP ({number})")
        },
        summary: format!(
            "0x{:04X}:0x{:04X} · session 0x{:04X}",
            h.service_id, h.method_id, h.session_id
        ),
        fields: vec![
            field("Service ID", format!("0x{:04X}", h.service_id), offset, 2),
            field("Method ID", format!("0x{:04X}", h.method_id), offset + 2, 2),
            field("Length", h.length.to_string(), offset + 4, 4),
            field("Client ID", format!("0x{:04X}", h.client_id), offset + 8, 2),
            field(
                "Session ID",
                format!("0x{:04X}", h.session_id),
                offset + 10,
                2,
            ),
            field(
                "Message type",
                format!("0x{:02X}", h.message_type),
                offset + 14,
                1,
            ),
        ],
    });
}
fn add_icmp(layers: &mut Vec<FrameLayer>, bytes: &[u8], offset: usize, name: &str) {
    match icmp::IcmpPacket::parse(bytes) {
        Ok(p) => layers.push(FrameLayer {
            protocol: name.into(),
            summary: format!("type {} · code {}", p.icmp_type, p.code),
            fields: vec![
                field("Type", p.icmp_type.to_string(), offset, 1),
                field("Code", p.code.to_string(), offset + 1, 1),
            ],
        }),
        Err(e) => layers.push(malformed(name, e)),
    }
}

fn dissect_gptp(
    idx: u64,
    t_s: f64,
    wire: &[u8],
    payload: &[u8],
    l2_len: usize,
    mut layers: Vec<FrameLayer>,
) -> FrameDetail {
    match gptp::parse(payload) {
        Ok(message) => {
            let payload_offset = l2_len
                + gptp::HEADER_LEN
                + if message.origin_timestamp_ns.is_some() {
                    10
                } else {
                    0
                };
            layers.push(FrameLayer {
                protocol: "gPTP".into(),
                summary: format!(
                    "{} · sequence {}",
                    gptp_name(message.msg_type),
                    message.sequence_id
                ),
                fields: vec![
                    field(
                        "Message type",
                        gptp_name(message.msg_type).into(),
                        l2_len,
                        1,
                    ),
                    field("Domain", message.domain.to_string(), l2_len + 4, 1),
                    field(
                        "Sequence ID",
                        message.sequence_id.to_string(),
                        l2_len + 30,
                        2,
                    ),
                    field(
                        "Correction",
                        message.correction_ns.to_string(),
                        l2_len + 8,
                        8,
                    ),
                ],
            });
            detail(idx, t_s, wire, payload_offset.min(wire.len()), layers)
        }
        Err(error) => {
            layers.push(malformed("gPTP", error));
            detail(idx, t_s, wire, wire.len(), layers)
        }
    }
}

fn gptp_name(kind: u8) -> &'static str {
    match kind {
        gptp::MSG_SYNC => "Sync",
        gptp::MSG_FOLLOW_UP => "FollowUp",
        gptp::MSG_PDELAY_REQ => "PdelayReq",
        gptp::MSG_PDELAY_RESP => "PdelayResp",
        gptp::MSG_ANNOUNCE => "Announce",
        _ => "Other",
    }
}

fn detail(
    idx: u64,
    t_s: f64,
    wire: &[u8],
    payload_offset: usize,
    layers: Vec<FrameLayer>,
) -> FrameDetail {
    detail_with_decoded(idx, t_s, wire, payload_offset, layers, None)
}
fn detail_with_decoded(
    idx: u64,
    t_s: f64,
    wire: &[u8],
    payload_offset: usize,
    layers: Vec<FrameLayer>,
    decoded: Option<Vec<radeau_catalog::DecodedSignal>>,
) -> FrameDetail {
    FrameDetail {
        idx,
        t_s,
        wire_len: wire.len(),
        payload_offset,
        layers,
        bytes: wire.iter().map(|byte| format!("{byte:02X}")).collect(),
        decoded,
    }
}

/// Returns a retained raw frame's cold-path protocol dissection.
#[tauri::command]
pub fn frame_detail(
    state: State<crate::capture::CaptureState>,
    catalog: State<crate::catalog::CatalogState>,
    idx: u64,
) -> Result<FrameDetail, String> {
    let active = catalog.active_catalog();
    state.frame_detail(idx, active.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use radeau_proto::{
        ethernet::EthernetFrame,
        gptp::GptpMessage,
        ipv4::Ipv4Packet,
        sd::{SdEntry, SdMessage},
        someip::SomeIpHeader,
        udp::UdpDatagram,
    };

    fn someip_wire(payload: &[u8], service_id: u16, method_id: u16) -> Vec<u8> {
        let mut message = Vec::new();
        someip::build(
            &SomeIpHeader {
                service_id,
                method_id,
                length: 0,
                client_id: 1,
                session_id: 2,
                protocol_version: 1,
                interface_version: 1,
                message_type: someip::MSG_NOTIFICATION,
                return_code: 0,
            },
            payload,
            &mut message,
        );
        let src = [10, 42, 0, 11];
        let dst = [10, 42, 0, 20];
        let mut udp_bytes = Vec::new();
        UdpDatagram::build(src, dst, 30490, 30490, &message, &mut udp_bytes);
        let mut ip_bytes = Vec::new();
        Ipv4Packet::build(
            src,
            dst,
            ipv4::PROTOCOL_UDP,
            1,
            64,
            0,
            &udp_bytes,
            &mut ip_bytes,
        );
        let mut wire = Vec::new();
        EthernetFrame::build(
            [1, 0, 0x5e, 0x7f, 0xff, 0xff],
            [2, 0x52, 0x41, 0x44, 0, 1],
            ethernet::ETHERTYPE_IPV4,
            &ip_bytes,
            &mut wire,
        );
        wire
    }

    #[test]
    fn dissects_someip_event_with_wire_offsets() {
        let detail = dissect(123, 1.0421, &someip_wire(&[0xde, 0xad], 0x1101, 0x8001));
        assert_eq!(detail.payload_offset, 58);
        assert_eq!(
            detail
                .layers
                .iter()
                .map(|layer| layer.protocol.as_str())
                .collect::<Vec<_>>(),
            ["Ethernet II", "IPv4", "UDP", "SOME/IP"]
        );
        assert_eq!(
            detail.layers[0].summary,
            "02:52:41:44:00:01 → 01:00:5E:7F:FF:FF · EtherType 0x0800"
        );
        assert_eq!(detail.layers[3].fields[0].offset, 42);
        assert_eq!(detail.layers[3].fields[0].value, "0x1101");
    }

    #[test]
    fn catalog_decodes_only_when_loaded() {
        let catalog = radeau_catalog::from_arxml(include_str!("../../catalog/sensor-fusion.arxml"))
            .map(|(catalog, _)| catalog)
            .expect("checked-in extract");
        let wire = someip_wire(&[4, 0, 10, 0xff, 0xf6], 0x1102, 0x8001);
        let decoded = dissect_with_catalog(0, 0.0, &wire, Some(&catalog));
        assert_eq!(decoded.decoded.as_ref().map(Vec::len), Some(3));
        assert_eq!(decoded.decoded.as_ref().expect("decoded")[1].unit, "m");
        assert!(dissect_with_catalog(0, 0.0, &wire, None).decoded.is_none());
    }

    #[test]
    fn dissects_sd_offer_entry() {
        let mut payload = Vec::new();
        sd::build(
            &SdMessage {
                flags: 0xc0,
                entries: vec![SdEntry {
                    entry_type: sd::ENTRY_OFFER_SERVICE,
                    service_id: 0x1101,
                    instance_id: 1,
                    major_version: 1,
                    ttl: 3,
                    minor_version: 0,
                }],
            },
            &mut payload,
        );
        let detail = dissect(
            0,
            0.0,
            &someip_wire(&payload, someip::SD_SERVICE_ID, someip::SD_METHOD_ID),
        );
        assert_eq!(detail.layers[4].protocol, "SOME/IP-SD");
        assert_eq!(
            detail.layers[4].fields[0].value,
            "OfferService 0x1101:1 v1.0 TTL 3"
        );
        assert_eq!(detail.layers[4].fields[0].offset, 66);
    }

    #[test]
    fn dissects_gptp_sync() {
        let mut payload = Vec::new();
        gptp::build(
            &GptpMessage {
                msg_type: gptp::MSG_SYNC,
                domain: 0,
                sequence_id: 0x1234,
                correction_ns: -2,
                origin_timestamp_ns: Some(5_000_000_007),
            },
            &mut payload,
        );
        let mut wire = Vec::new();
        EthernetFrame::build(
            gptp::GPTP_MULTICAST,
            [2, 0x52, 0x41, 0x44, 0, 1],
            ethernet::ETHERTYPE_GPTP,
            &payload,
            &mut wire,
        );
        let detail = dissect(0, 0.0, &wire);
        assert_eq!(detail.layers[1].summary, "Sync · sequence 4660");
        assert_eq!(detail.layers[1].fields[2].offset, 44);
        assert_eq!(detail.payload_offset, wire.len());
    }

    /// Regression vector: a real SOME/IP event captured from the live
    /// `ecu-netsim` monitor link (RadarTargets 0x1102, broadcast dst).
    #[test]
    fn dissects_live_netsim_event_capture() {
        let hex = "01005e7fffff02524144000208004500008c8b7640004011a4b50a2a000cffffffff771a771a0078b7b611028001000000680002136e01010200a6f266068a651be5417bfaaf0837136bfbfc46f1ed0e5c41ebc6a283f2203fd01e7c1230";
        let mut wire: Vec<u8> = (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).expect("hex"))
            .collect();
        wire.resize(154, 0); // captured frame is 154 bytes; tail is payload noise
        let detail = dissect(0, 0.0, &wire);
        let protocols: Vec<_> = detail.layers.iter().map(|l| l.protocol.as_str()).collect();
        assert_eq!(
            protocols,
            ["Ethernet II", "IPv4", "UDP", "SOME/IP"],
            "layers: {:?}",
            detail
                .layers
                .iter()
                .map(|l| (l.protocol.clone(), l.summary.clone()))
                .collect::<Vec<_>>()
        );
        assert_eq!(detail.layers[3].fields[0].value, "0x1102");
        assert_eq!(detail.payload_offset, 58);
    }

    #[test]
    fn malformed_tail_is_a_layer_not_an_error() {
        let mut wire = someip_wire(&[1, 2], 0x1101, 0x8001);
        wire.truncate(55);
        let detail = dissect(0, 0.0, &wire);
        assert_eq!(
            detail.layers.last().map(|layer| layer.summary.as_str()),
            Some("malformed: truncated")
        );
    }

    #[test]
    fn ring_distinguishes_evicted_and_unknown() {
        let mut ring = FrameRing::with_limits(1, 100);
        ring.push(0, 0.0, vec![1]);
        ring.push(1, 0.0, vec![2]);
        assert_eq!(
            ring.detail(0, None).unwrap_err(),
            "frame no longer buffered"
        );
        assert_eq!(ring.detail(2, None).unwrap_err(), "unknown frame");
    }

    #[test]
    fn ring_evicts_for_byte_cap() {
        let mut ring = FrameRing::with_limits(10, 3);
        ring.push(0, 0.0, vec![1, 2]);
        ring.push(1, 0.0, vec![3, 4]);
        assert_eq!(
            ring.detail(0, None).unwrap_err(),
            "frame no longer buffered"
        );
        assert!(ring.detail(1, None).is_ok());
    }
}
