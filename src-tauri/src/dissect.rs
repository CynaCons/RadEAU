//! Cold-path raw-frame retention and protocol dissection.  The reader only
//! takes the ring lock long enough to append one already-built wire frame.

use std::collections::VecDeque;

use radeau_proto::{
    arp, avtp, dhcp, dns, doip, eapol, ethernet, gptp, http, icmp, icmpv6, igmp, ipv4, ipv6, lldp,
    macsec, ntp, sctp, sd, snmp, someip, ssdp, ssh, tcp, tftp, tls, udp, ParseError,
};
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

#[derive(Debug, Clone)]
pub(crate) struct BufferedFrame {
    pub(crate) idx: u64,
    pub(crate) t_s: f64,
    pub(crate) wire: Vec<u8>,
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
    pub(crate) session_epoch_ns: Option<u64>,
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
            session_epoch_ns: None,
        }
    }
    pub fn clear(&mut self) {
        self.frames.clear();
        self.total_bytes = 0;
        self.greatest_seen = None;
        self.session_epoch_ns = None;
    }

    pub(crate) fn set_session_epoch_ns(&mut self, epoch: Option<u64>) {
        self.session_epoch_ns = epoch;
    }

    pub(crate) fn snapshot_chunk(&self, offset: usize, count: usize) -> Vec<BufferedFrame> {
        self.frames
            .iter()
            .skip(offset)
            .take(count)
            .cloned()
            .collect()
    }

    pub(crate) fn len(&self) -> usize {
        self.frames.len()
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
        // Indexes are assigned monotonically and every frame is retained, so
        // a frame's position is its distance from the oldest one — O(1)
        // instead of a scan under the lock the reader shares.
        let by_position = self.frames.front().and_then(|front| {
            let pos = idx.checked_sub(front.idx)? as usize;
            self.frames.get(pos).filter(|frame| frame.idx == idx)
        });
        let found = by_position.or_else(|| self.frames.iter().find(|frame| frame.idx == idx));
        if let Some(frame) = found {
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
    if matches!(
        eth.ethertype,
        lldp::ETHERTYPE | avtp::ETHERTYPE | macsec::ETHERTYPE | eapol::ETHERTYPE
    ) {
        add_l2_standard(&mut layers, eth.ethertype, eth.payload, l3_offset);
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
                match ipv6::walk_extensions(p.next_header, p.payload) {
                    Ok(walk) => {
                        for ext in &walk.headers {
                            add_ipv6_ext(&mut layers, ext, p.payload, payload_offset);
                        }
                        let l4 = payload_offset + walk.payload_offset;
                        if walk
                            .headers
                            .iter()
                            .any(|h| h.fragment.is_some_and(|f| f.offset > 0))
                        {
                            payload_offset = l4;
                        } else {
                            payload_offset = dissect_ip_transport(
                                &mut layers,
                                walk.final_next_header,
                                walk.payload,
                                l4,
                            );
                        }
                    }
                    Err(e) => layers.push(malformed("IPv6 extension header", e)),
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
                if s.src_port == doip::DOIP_PORT || s.dst_port == doip::DOIP_PORT {
                    payload_offset = dissect_doip_tcp(&mut layers, s.payload, payload_offset);
                } else if !s.payload.is_empty()
                    && !add_tcp_application(
                        &mut layers,
                        s.src_port,
                        s.dst_port,
                        s.payload,
                        payload_offset,
                    )
                {
                    data_layer(&mut layers, s.payload.len());
                }
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
    if ip_packet.protocol == 2 {
        add_igmp(&mut layers, ip_packet.payload, l4_offset);
        return detail(idx, t_s, wire, l4_offset, layers);
    }
    if ip_packet.protocol == 132 {
        add_sctp(&mut layers, ip_packet.payload, l4_offset);
        return detail(
            idx,
            t_s,
            wire,
            l4_offset + sctp::HEADER_LEN.min(ip_packet.payload.len()),
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
    if datagram.src_port == doip::DOIP_PORT || datagram.dst_port == doip::DOIP_PORT {
        match doip::parse_header(datagram.payload) {
            Ok((header, body)) => {
                payload_offset = someip_offset + doip::HEADER_LEN;
                add_doip_message(&mut layers, header, body, someip_offset, 1);
            }
            Err(ParseError::Malformed)
                if datagram.payload.len() >= 2 && datagram.payload[1] != !datagram.payload[0] =>
            {
                layers.push(FrameLayer {
                    protocol: "DoIP".into(),
                    summary: "malformed: inverse version mismatch".into(),
                    fields: vec![
                        doip_field(
                            "Version",
                            format!("0x{:02X}", datagram.payload[0]),
                            someip_offset,
                            1,
                        ),
                        doip_field(
                            "Inverse version",
                            format!("0x{:02X}", datagram.payload[1]),
                            someip_offset + 1,
                            1,
                        ),
                    ],
                });
            }
            Err(ParseError::Truncated) => {
                if let Ok(header) = doip::parse_header_prefix(datagram.payload) {
                    add_partial_doip(&mut layers, header, someip_offset, "body truncated");
                    payload_offset = someip_offset + doip::HEADER_LEN;
                } else {
                    layers.push(malformed("DoIP", ParseError::Truncated));
                }
            }
            Err(ParseError::Malformed) if datagram.payload.len() >= doip::HEADER_LEN => {
                let header = doip::DoipHeader {
                    version: datagram.payload[0],
                    inverse_version: datagram.payload[1],
                    payload_type: u16::from_be_bytes([datagram.payload[2], datagram.payload[3]]),
                    payload_length: u32::from_be_bytes(
                        datagram.payload[4..8].try_into().expect("fixed header"),
                    ),
                };
                add_partial_doip(&mut layers, header, someip_offset, "body truncated");
                payload_offset = someip_offset + doip::HEADER_LEN;
            }
            Err(error) => layers.push(malformed("DoIP", error)),
        }
        return detail(idx, t_s, wire, payload_offset, layers);
    }
    if !crate::classify::someip_plausible(datagram.payload) {
        if add_udp_application(
            &mut layers,
            datagram.src_port,
            datagram.dst_port,
            datagram.payload,
            someip_offset,
        ) {
            return detail(idx, t_s, wire, someip_offset, layers);
        }
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

const HEX_DIGITS: &[u8; 16] = b"0123456789ABCDEF";

fn push_hex_byte(out: &mut String, byte: u8) {
    out.push(char::from(HEX_DIGITS[usize::from(byte >> 4)]));
    out.push(char::from(HEX_DIGITS[usize::from(byte & 0x0f)]));
}

/// Space-separated uppercase hex, one allocation.
fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 3);
    for (i, &byte) in bytes.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        push_hex_byte(&mut out, byte);
    }
    out
}

/// Unseparated uppercase hex (the `FrameDetail::bytes` wire form), one allocation.
fn hex_compact(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        push_hex_byte(&mut out, byte);
    }
    out
}

fn doip_field(name: &str, value: impl Into<String>, offset: usize, len: usize) -> FrameField {
    field(name, value.into(), offset, len)
}

fn doip_header_fields(header: doip::DoipHeader, offset: usize) -> Vec<FrameField> {
    vec![
        doip_field("Version", format!("0x{:02X}", header.version), offset, 1),
        doip_field(
            "Inverse version",
            format!("0x{:02X}", header.inverse_version),
            offset + 1,
            1,
        ),
        doip_field(
            "Payload type",
            format!(
                "0x{:04X} · {}",
                header.payload_type,
                doip::type_name(header.payload_type)
            ),
            offset + 2,
            2,
        ),
        doip_field(
            "Payload length",
            header.payload_length.to_string(),
            offset + 4,
            4,
        ),
    ]
}

fn add_partial_doip(
    layers: &mut Vec<FrameLayer>,
    header: doip::DoipHeader,
    offset: usize,
    summary: &str,
) {
    layers.push(FrameLayer {
        protocol: "DoIP".into(),
        summary: summary.into(),
        fields: doip_header_fields(header, offset),
    });
}

fn add_doip_message(
    layers: &mut Vec<FrameLayer>,
    header: doip::DoipHeader,
    body: &[u8],
    offset: usize,
    number: usize,
) {
    let body_offset = offset + doip::HEADER_LEN;
    let mut fields = doip_header_fields(header, offset);
    match doip::parse_payload(header, body) {
        Ok(payload) => {
            add_doip_payload_fields(&mut fields, &payload, body, body_offset, body.len())
        }
        Err(error) => fields.push(doip_field(
            "Payload",
            format!(
                "malformed: {}",
                if error == ParseError::Truncated {
                    "truncated"
                } else {
                    "invalid"
                }
            ),
            body_offset,
            body.len(),
        )),
    }
    layers.push(FrameLayer {
        protocol: if number == 1 {
            "DoIP".into()
        } else {
            format!("DoIP ({number})")
        },
        summary: format!(
            "{} · {} bytes",
            doip::type_name(header.payload_type),
            header.payload_length
        ),
        fields,
    });
    if let Ok(doip::DoipPayload::Diagnostic { uds, .. }) = doip::parse_payload(header, body) {
        add_uds_layer(layers, uds, body_offset + 4);
    }
}

fn add_doip_payload_fields(
    fields: &mut Vec<FrameField>,
    payload: &doip::DoipPayload<'_>,
    body: &[u8],
    o: usize,
    body_len: usize,
) {
    use doip::DoipPayload::*;
    let addr = |v| format!("0x{v:04X}");
    match payload {
        HeaderNack { code } => fields.push(doip_field("NACK code", format!("0x{code:02X}"), o, 1)),
        VehicleIdRequest | AliveCheckRequest | EntityStatusRequest | PowerModeRequest => {}
        VehicleIdRequestEid { eid } => fields.push(doip_field("EID", hex(eid), o, 6)),
        VehicleIdRequestVin { vin } => {
            fields.push(doip_field("VIN", String::from_utf8_lossy(vin), o, 17))
        }
        VehicleAnnouncement {
            vin,
            logical_address,
            eid,
            gid,
            further_action,
            sync_status,
        } => {
            fields.extend([
                doip_field("VIN", String::from_utf8_lossy(vin), o, 17),
                doip_field("Logical address", addr(*logical_address), o + 17, 2),
                doip_field("EID", hex(eid), o + 19, 6),
                doip_field("GID", hex(gid), o + 25, 6),
                doip_field(
                    "Further action",
                    format!("0x{further_action:02X}"),
                    o + 31,
                    1,
                ),
            ]);
            if let Some(status) = sync_status {
                fields.push(doip_field(
                    "VIN/GID sync status",
                    format!("0x{status:02X}"),
                    o + 32,
                    1,
                ));
            }
        }
        RoutingActivationRequest {
            source_address,
            activation_type,
            oem,
        } => {
            fields.extend([
                doip_field("Source address", addr(*source_address), o, 2),
                doip_field(
                    "Activation type",
                    format!("0x{activation_type:02X}"),
                    o + 2,
                    1,
                ),
                doip_field(
                    "Reserved",
                    format!(
                        "0x{:08X}",
                        u32::from_be_bytes(body[3..7].try_into().expect("validated payload"))
                    ),
                    o + 3,
                    4,
                ),
            ]);
            if let Some(value) = oem {
                fields.push(doip_field("OEM", format!("0x{value:08X}"), o + 7, 4));
            }
        }
        RoutingActivationResponse {
            tester_address,
            entity_address,
            response_code,
            oem,
        } => {
            fields.extend([
                doip_field("Tester address", addr(*tester_address), o, 2),
                doip_field("Entity address", addr(*entity_address), o + 2, 2),
                doip_field("Response code", format!("0x{response_code:02X}"), o + 4, 1),
                doip_field(
                    "Reserved",
                    format!(
                        "0x{:08X}",
                        u32::from_be_bytes(body[5..9].try_into().expect("validated payload"))
                    ),
                    o + 5,
                    4,
                ),
            ]);
            if let Some(value) = oem {
                fields.push(doip_field("OEM", format!("0x{value:08X}"), o + 9, 4));
            }
        }
        AliveCheckResponse { source_address } => {
            fields.push(doip_field("Source address", addr(*source_address), o, 2))
        }
        EntityStatusResponse {
            node_type,
            max_open_sockets,
            open_sockets,
            max_data_size,
        } => {
            fields.extend([
                doip_field("Node type", format!("0x{node_type:02X}"), o, 1),
                doip_field(
                    "Maximum open sockets",
                    max_open_sockets.to_string(),
                    o + 1,
                    1,
                ),
                doip_field("Open sockets", open_sockets.to_string(), o + 2, 1),
            ]);
            if let Some(value) = max_data_size {
                fields.push(doip_field("Maximum data size", value.to_string(), o + 3, 4));
            }
        }
        PowerModeResponse { mode } => {
            fields.push(doip_field("Power mode", format!("0x{mode:02X}"), o, 1))
        }
        Diagnostic {
            source_address,
            target_address,
            uds,
        } => fields.extend([
            doip_field("Source address", addr(*source_address), o, 2),
            doip_field("Target address", addr(*target_address), o + 2, 2),
            doip_field("UDS", hex(uds), o + 4, uds.len()),
        ]),
        DiagnosticAck {
            source_address,
            target_address,
            code,
            previous,
        }
        | DiagnosticNack {
            source_address,
            target_address,
            code,
            previous,
        } => fields.extend([
            doip_field("Source address", addr(*source_address), o, 2),
            doip_field("Target address", addr(*target_address), o + 2, 2),
            doip_field("Code", format!("0x{code:02X}"), o + 4, 1),
            doip_field("Previous message", hex(previous), o + 5, previous.len()),
        ]),
        Unknown { body, .. } => fields.push(doip_field("Payload", hex(body), o, body_len)),
    }
}

fn add_uds_layer(layers: &mut Vec<FrameLayer>, uds: &[u8], offset: usize) {
    let Some(&sid) = uds.first() else {
        layers.push(FrameLayer {
            protocol: "UDS".into(),
            summary: "empty".into(),
            fields: vec![],
        });
        return;
    };
    let mut fields = Vec::new();
    let mut consumed = 1;
    let summary;
    if sid == 0x7f {
        let rejected = uds.get(1).copied();
        let nrc = uds.get(2).copied();
        let rejected_name = rejected.and_then(doip::uds_sid_name).unwrap_or("Unknown");
        let nrc_name = nrc.and_then(doip::uds_nrc_name).unwrap_or("Unknown");
        summary = format!("Negative response · {rejected_name} · {nrc_name}");
        fields.push(doip_field("SID", "0x7F · NegativeResponse", offset, 1));
        if let Some(value) = rejected {
            fields.push(doip_field(
                "Rejected SID",
                format!("0x{value:02X} · {rejected_name}"),
                offset + 1,
                1,
            ));
        }
        if let Some(value) = nrc {
            fields.push(doip_field(
                "NRC",
                format!("0x{value:02X} · {nrc_name}"),
                offset + 2,
                1,
            ));
        }
        consumed = uds.len().min(3);
    } else {
        let (name, positive) = doip::uds_sid_display(sid).unwrap_or(("Unknown", false));
        let base_sid = if positive { sid - 0x40 } else { sid };
        summary = if positive {
            format!("{name} positive response")
        } else {
            name.into()
        };
        fields.push(doip_field(
            "SID",
            format!("0x{sid:02X} · {summary}"),
            offset,
            1,
        ));
        if matches!(
            base_sid,
            0x10 | 0x11 | 0x19 | 0x27 | 0x28 | 0x31 | 0x3e | 0x85
        ) {
            if let Some(value) = uds.get(1) {
                fields.push(doip_field(
                    "Sub-function",
                    format!("0x{value:02X}"),
                    offset + 1,
                    1,
                ));
                consumed = 2;
            }
        } else if matches!(base_sid, 0x22 | 0x2e) && uds.len() >= 3 {
            let did = u16::from_be_bytes([uds[1], uds[2]]);
            fields.push(doip_field("DID", format!("0x{did:04X}"), offset + 1, 2));
            consumed = 3;
        }
    }
    if let Some(remaining) = uds.get(consumed..) {
        if !remaining.is_empty() {
            fields.push(doip_field(
                "Remaining bytes",
                hex(remaining),
                offset + consumed,
                remaining.len(),
            ));
        }
    }
    layers.push(FrameLayer {
        protocol: "UDS".into(),
        summary,
        fields,
    });
}

fn dissect_doip_tcp(layers: &mut Vec<FrameLayer>, payload: &[u8], offset: usize) -> usize {
    let mut remaining = payload;
    let mut current = offset;
    let mut number = 1;
    let mut parsed_any = false;
    while !remaining.is_empty() {
        match doip::parse_header_prefix(remaining) {
            Ok(header) if doip::ty_code(header.payload_type) != 255 => {
                let message_len = doip::HEADER_LEN + header.payload_length as usize;
                if remaining.len() < message_len {
                    add_partial_doip(layers, header, current, "continues in next segment");
                    parsed_any = true;
                    break;
                }
                let body = &remaining[doip::HEADER_LEN..message_len];
                add_doip_message(layers, header, body, current, number);
                parsed_any = true;
                remaining = &remaining[message_len..];
                current += message_len;
                number += 1;
            }
            Err(ParseError::Truncated) if parsed_any => {
                layers.push(FrameLayer {
                    protocol: "DoIP".into(),
                    summary: "continues in next segment".into(),
                    fields: vec![],
                });
                break;
            }
            _ => {
                layers.push(FrameLayer {
                    protocol: "TCP payload (mid-stream)".into(),
                    summary: format!("TCP payload (mid-stream) · {} bytes", remaining.len()),
                    fields: vec![],
                });
                break;
            }
        }
    }
    if parsed_any {
        offset + doip::HEADER_LEN
    } else {
        offset
    }
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

fn data_layer(layers: &mut Vec<FrameLayer>, len: usize) {
    layers.push(FrameLayer {
        protocol: "Data".into(),
        summary: format!("{len} bytes"),
        fields: vec![],
    });
}

fn add_ipv6_ext(layers: &mut Vec<FrameLayer>, ext: &ipv6::Ipv6Ext, bytes: &[u8], base: usize) {
    let title = match ext.kind {
        0 => "IPv6 Hop-by-Hop Options",
        43 => "IPv6 Routing",
        44 => "IPv6 Fragment",
        60 => "IPv6 Destination Options",
        51 => "IPv6 AH",
        50 => "IPv6 ESP",
        _ => "IPv6 Extension",
    };
    let mut fields = vec![field(
        "Next header",
        bytes.get(ext.offset).copied().unwrap_or(0).to_string(),
        base + ext.offset,
        1,
    )];
    let summary = if let Some(f) = ext.fragment {
        fields.push(field(
            "Fragment offset",
            f.offset.to_string(),
            base + ext.offset + 2,
            2,
        ));
        fields.push(field(
            "More fragments",
            f.more.to_string(),
            base + ext.offset + 2,
            2,
        ));
        fields.push(field(
            "Identification",
            format!("0x{:08X}", f.id),
            base + ext.offset + 4,
            4,
        ));
        format!("offset {} · more {}", f.offset, f.more)
    } else {
        format!("{} bytes", ext.len)
    };
    layers.push(FrameLayer {
        protocol: title.into(),
        summary,
        fields,
    });
}

fn dissect_ip_transport(
    layers: &mut Vec<FrameLayer>,
    protocol: u8,
    bytes: &[u8],
    offset: usize,
) -> usize {
    match protocol {
        58 => {
            add_icmpv6(layers, bytes, offset);
            offset + icmpv6::HEADER_LEN.min(bytes.len())
        }
        2 => {
            add_igmp(layers, bytes, offset);
            offset
        }
        132 => {
            add_sctp(layers, bytes, offset);
            offset + sctp::HEADER_LEN.min(bytes.len())
        }
        51 => {
            let fields = if bytes.len() >= 2 {
                vec![
                    field(
                        "Next header",
                        ipv6::next_header_name(bytes[0]).into(),
                        offset,
                        1,
                    ),
                    field("Payload length", bytes[1].to_string(), offset + 1, 1),
                ]
            } else {
                vec![]
            };
            layers.push(FrameLayer {
                protocol: "IPv6 Authentication Header".into(),
                summary: format!("AH · {} bytes", bytes.len()),
                fields,
            });
            offset
        }
        50 => {
            layers.push(FrameLayer {
                protocol: "IPv6 ESP".into(),
                summary: format!("encrypted · {} bytes", bytes.len()),
                fields: vec![],
            });
            offset
        }
        17 => match udp::UdpDatagram::parse(bytes) {
            Ok(u) => {
                layers.push(FrameLayer {
                    protocol: "UDP".into(),
                    summary: format!("{} → {} · length {}", u.src_port, u.dst_port, bytes.len()),
                    fields: vec![
                        field("Source port", u.src_port.to_string(), offset, 2),
                        field("Destination port", u.dst_port.to_string(), offset + 2, 2),
                        field("Length", (u.payload.len() + 8).to_string(), offset + 4, 2),
                    ],
                });
                let app = offset + udp::HEADER_LEN;
                if u.src_port == doip::DOIP_PORT || u.dst_port == doip::DOIP_PORT {
                    if let Ok((h, b)) = doip::parse_header(u.payload) {
                        add_doip_message(layers, h, b, app, 1);
                        return app + doip::HEADER_LEN;
                    }
                }
                if crate::classify::someip_plausible(u.payload) {
                    let (h, p) = someip::parse(u.payload).expect("plausible");
                    add_someip_layer(layers, &h, app, 1);
                    if h.service_id == someip::SD_SERVICE_ID && h.method_id == someip::SD_METHOD_ID
                    {
                        if let Ok(m) = sd::parse(p) {
                            layers.push(FrameLayer {
                                protocol: "SOME/IP-SD".into(),
                                summary: format!("{} service entries", m.entries.len()),
                                fields: vec![],
                            });
                        }
                    }
                    return app + someip::HEADER_LEN;
                }
                if !add_udp_application(layers, u.src_port, u.dst_port, u.payload, app) {
                    data_layer(layers, u.payload.len());
                }
                app
            }
            Err(e) => {
                layers.push(malformed("UDP", e));
                offset
            }
        },
        6 => match tcp::TcpSegment::parse(bytes) {
            Ok(t) => {
                let app = offset + t.data_offset as usize * 4;
                layers.push(FrameLayer {
                    protocol: "TCP".into(),
                    summary: format!("{} → {}", t.src_port, t.dst_port),
                    fields: vec![
                        field("Source port", t.src_port.to_string(), offset, 2),
                        field("Destination port", t.dst_port.to_string(), offset + 2, 2),
                        field("Payload length", t.payload.len().to_string(), app, 0),
                    ],
                });
                if t.src_port == doip::DOIP_PORT || t.dst_port == doip::DOIP_PORT {
                    dissect_doip_tcp(layers, t.payload, app)
                } else {
                    if !t.payload.is_empty()
                        && !add_tcp_application(layers, t.src_port, t.dst_port, t.payload, app)
                    {
                        data_layer(layers, t.payload.len());
                    }
                    app
                }
            }
            Err(e) => {
                layers.push(malformed("TCP", e));
                offset
            }
        },
        _ => {
            if !bytes.is_empty() {
                data_layer(layers, bytes.len());
            }
            offset
        }
    }
}

fn add_icmpv6(layers: &mut Vec<FrameLayer>, bytes: &[u8], offset: usize) {
    let Ok(p) = icmpv6::Icmpv6Message::parse(bytes) else {
        layers.push(malformed("ICMPv6", ParseError::Truncated));
        return;
    };
    let mut fields = vec![
        field(
            "Type",
            format!("{} · {}", p.msg_type, icmpv6::type_name(p.msg_type)),
            offset,
            1,
        ),
        field("Code", p.code.to_string(), offset + 1, 1),
        field("Checksum", format!("0x{:04X}", p.checksum), offset + 2, 2),
    ];
    let body = offset + 4;
    let mut opts: Vec<icmpv6::NdpOption<'_>> = vec![];
    let mut options_offset = body;
    match p.msg_type {
        128 | 129 => {
            if let Ok(v) = icmpv6::Echo::parse(p.body) {
                fields.push(field("Identifier", v.identifier.to_string(), body, 2));
                fields.push(field("Sequence", v.sequence.to_string(), body + 2, 2));
            }
        }
        133 => {
            if let Ok(v) = icmpv6::RouterSolicitation::parse(p.body) {
                opts = v.options;
                options_offset = body + 4;
            }
        }
        134 => {
            if let Ok(v) = icmpv6::RouterAdvertisement::parse(p.body) {
                fields.push(field(
                    "Current hop limit",
                    v.cur_hop_limit.to_string(),
                    body,
                    1,
                ));
                fields.push(field(
                    "Flags",
                    format!("M={} O={}", v.managed, v.other),
                    body + 1,
                    1,
                ));
                fields.push(field(
                    "Router lifetime",
                    v.router_lifetime.to_string(),
                    body + 2,
                    2,
                ));
                opts = v.options;
                options_offset = body + 12;
            }
        }
        135 => {
            if let Ok(v) = icmpv6::NeighborSolicitation::parse(p.body) {
                fields.push(field(
                    "Target",
                    std::net::Ipv6Addr::from(v.target).to_string(),
                    body + 4,
                    16,
                ));
                opts = v.options;
                options_offset = body + 20;
            }
        }
        136 => {
            if let Ok(v) = icmpv6::NeighborAdvertisement::parse(p.body) {
                fields.push(field(
                    "Flags",
                    format!("R={} S={} O={}", v.router, v.solicited, v.override_flag),
                    body,
                    4,
                ));
                fields.push(field(
                    "Target",
                    std::net::Ipv6Addr::from(v.target).to_string(),
                    body + 4,
                    16,
                ));
                opts = v.options;
                options_offset = body + 20;
            }
        }
        137 => {
            if let Ok(v) = icmpv6::Redirect::parse(p.body) {
                fields.push(field(
                    "Target",
                    std::net::Ipv6Addr::from(v.target).to_string(),
                    body + 4,
                    16,
                ));
                fields.push(field(
                    "Destination",
                    std::net::Ipv6Addr::from(v.destination).to_string(),
                    body + 20,
                    16,
                ));
                opts = v.options;
                options_offset = body + 36;
            }
        }
        130 => {
            if let Ok(v) = icmpv6::MldQuery::parse(p.body) {
                fields.push(field(
                    "Maximum response delay",
                    v.max_response_delay.to_string(),
                    body,
                    2,
                ));
                fields.push(field(
                    "Multicast address",
                    std::net::Ipv6Addr::from(v.multicast_address).to_string(),
                    body + 4,
                    16,
                ));
            }
        }
        131 | 132 => {
            if let Ok(v) = icmpv6::MldReport::parse(p.body) {
                fields.push(field(
                    "Multicast address",
                    std::net::Ipv6Addr::from(v.multicast_address).to_string(),
                    body + 4,
                    16,
                ));
            }
        }
        _ => {}
    }
    for (n, o) in opts.iter().enumerate() {
        let decoded = match o.kind {
            1 | 2 if o.data.len() >= 6 => mac(&o.data[..6]),
            3 if o.data.len() >= 30 => format!(
                "{}/{} · valid {} s · preferred {} s",
                std::net::Ipv6Addr::from(<[u8; 16]>::try_from(&o.data[14..30]).expect("exact")),
                o.data[0],
                u32::from_be_bytes(o.data[2..6].try_into().expect("exact")),
                u32::from_be_bytes(o.data[6..10].try_into().expect("exact"))
            ),
            5 if o.data.len() >= 6 => {
                u32::from_be_bytes(o.data[2..6].try_into().expect("exact")).to_string()
            }
            _ => hex(o.data),
        };
        fields.push(field(
            &format!("Option {}", n + 1),
            format!("{} · {decoded}", icmpv6::ndp_option_name(o.kind)),
            options_offset + o.offset,
            o.len,
        ));
    }
    layers.push(FrameLayer {
        protocol: "ICMPv6".into(),
        summary: format!("{} · code {}", icmpv6::type_name(p.msg_type), p.code),
        fields,
    });
}

fn add_igmp(layers: &mut Vec<FrameLayer>, bytes: &[u8], offset: usize) {
    match igmp::IgmpMessage::parse(bytes) {
        Ok(p) => {
            let mut f = vec![
                field(
                    "Type",
                    format!("0x{:02X} · {}", p.msg_type, igmp::type_name(p.msg_type)),
                    offset,
                    1,
                ),
                field(
                    "Maximum response time",
                    p.max_response_code.to_string(),
                    offset + 1,
                    1,
                ),
                field("Group address", ip(&p.group_address), offset + 4, 4),
            ];
            // IGMPv3 group records start after the 8-byte report header; each
            // is 8 + 4·sources + auxiliary bytes long (RFC 3376 §4.2).
            let mut record_offset = offset + 8;
            for (n, r) in p.records.iter().enumerate() {
                let record_len = 8 + 4 * r.sources.len() + r.auxiliary_data.len();
                f.push(field(
                    &format!("Group record {}", n + 1),
                    format!(
                        "type {} · {} · {} sources",
                        r.record_type,
                        ip(&r.multicast_address),
                        r.sources.len()
                    ),
                    record_offset,
                    record_len,
                ));
                record_offset += record_len;
            }
            layers.push(FrameLayer {
                protocol: "IGMP".into(),
                summary: igmp::type_name(p.msg_type).into(),
                fields: f,
            })
        }
        Err(e) => layers.push(malformed("IGMP", e)),
    }
}
fn add_sctp(layers: &mut Vec<FrameLayer>, bytes: &[u8], offset: usize) {
    match sctp::SctpPacket::parse(bytes) {
        Ok(p) => {
            let mut f = vec![
                field("Source port", p.source_port.to_string(), offset, 2),
                field(
                    "Destination port",
                    p.destination_port.to_string(),
                    offset + 2,
                    2,
                ),
                field(
                    "Verification tag",
                    format!("0x{:08X}", p.verification_tag),
                    offset + 4,
                    4,
                ),
                field("Checksum", format!("0x{:08X}", p.checksum), offset + 8, 4),
            ];
            for (n, c) in p.chunks.iter().enumerate() {
                let mut v = format!(
                    "{} · flags 0x{:02X} · length {}",
                    sctp::chunk_name(c.chunk_type),
                    c.flags,
                    c.length
                );
                if let Some(d) = c.data {
                    v.push_str(&format!(
                        " · TSN {} stream {} PPID {}",
                        d.tsn, d.stream_identifier, d.payload_protocol_identifier
                    ));
                }
                f.push(field(
                    &format!("Chunk {}", n + 1),
                    v,
                    offset + c.offset,
                    c.length as usize,
                ));
            }
            layers.push(FrameLayer {
                protocol: "SCTP".into(),
                summary: p
                    .chunks
                    .first()
                    .map_or("no chunks", |c| sctp::chunk_name(c.chunk_type))
                    .into(),
                fields: f,
            })
        }
        Err(e) => layers.push(malformed("SCTP", e)),
    }
}

fn port(src: u16, dst: u16, p: u16) -> bool {
    src == p || dst == p
}
fn add_udp_application(
    layers: &mut Vec<FrameLayer>,
    src: u16,
    dst: u16,
    b: &[u8],
    o: usize,
) -> bool {
    if port(src, dst, 67) || port(src, dst, 68) {
        if let Ok(p) = dhcp::parse(b) {
            let mut f = vec![
                field("Op", p.op.to_string(), o, 1),
                field("Transaction ID", format!("0x{:08X}", p.xid), o + 4, 4),
                field(
                    "Client MAC",
                    mac(&p.chaddr[..p.hlen.min(16) as usize]),
                    o + 28,
                    usize::from(p.hlen.min(16)),
                ),
                field("Your address", ip(&p.yiaddr), o + 16, 4),
                field("Server address", ip(&p.siaddr), o + 20, 4),
            ];
            for x in p.options {
                f.push(field(
                    &dhcp::option_name(x.code),
                    hex(x.data),
                    o + x.offset,
                    x.data.len() + 2,
                ));
            }
            layers.push(FrameLayer {
                protocol: "DHCP".into(),
                summary: format!(
                    "DHCP {}",
                    dhcp::message_type_name(p.message_type.unwrap_or(0))
                ),
                fields: f,
            });
            return true;
        }
    }
    if port(src, dst, 546) || port(src, dst, 547) {
        if let Ok(p) = dhcp::parse_v6(b) {
            if !(1..=11).contains(&p.msg_type) {
                return false;
            }
            let mut f = vec![
                field(
                    "Message type",
                    dhcp::v6_message_type_name(p.msg_type).into(),
                    o,
                    1,
                ),
                field(
                    "Transaction ID",
                    format!("0x{:06X}", p.transaction_id),
                    o + 1,
                    3,
                ),
            ];
            for x in p.options {
                f.push(field(
                    &dhcp::v6_option_name(x.code),
                    hex(x.data),
                    o + x.offset,
                    x.data.len() + 4,
                ));
            }
            layers.push(FrameLayer {
                protocol: "DHCPv6".into(),
                summary: format!("DHCPv6 {}", dhcp::v6_message_type_name(p.msg_type)),
                fields: f,
            });
            return true;
        }
    }
    if [53, 5353, 5355].iter().any(|p| port(src, dst, *p)) {
        if let Ok(p) = dns::parse(b) {
            let mut f = vec![
                field("Transaction ID", format!("0x{:04X}", p.id), o, 2),
                field(
                    "Flags",
                    format!(
                        "QR={} opcode={} AA={} TC={} RD={} RA={} rcode={}",
                        p.is_response,
                        p.opcode,
                        p.authoritative,
                        p.truncated,
                        p.recursion_desired,
                        p.recursion_available,
                        p.rcode
                    ),
                    o + 2,
                    2,
                ),
                field(
                    "Counts",
                    format!(
                        "questions {} answers {} authority {} additional {}",
                        p.questions.len(),
                        p.answers.len(),
                        p.authority_count,
                        p.additional_count
                    ),
                    o + 4,
                    8,
                ),
            ];
            for q in &p.questions {
                f.push(field(
                    "Question",
                    format!(
                        "{} · {} · class {}",
                        q.name,
                        dns::qtype_name(q.qtype),
                        q.qclass
                    ),
                    o + 12,
                    0,
                ));
            }
            for a in &p.answers {
                f.push(field(
                    "Answer",
                    format!(
                        "{} · {} · TTL {} · {}",
                        a.name,
                        dns::qtype_name(a.rr_type),
                        a.ttl,
                        rdata(&a.rdata)
                    ),
                    o + 12,
                    0,
                ));
            }
            let flavor = if port(src, dst, 5353) {
                "mDNS"
            } else if port(src, dst, 5355) {
                "LLMNR"
            } else {
                "DNS"
            };
            layers.push(FrameLayer {
                protocol: flavor.into(),
                summary: format!(
                    "{} {}",
                    if p.is_response { "response" } else { "query" },
                    if p.is_response {
                        dns::rcode_name(p.rcode)
                    } else {
                        p.questions.first().map_or("", |q| dns::qtype_name(q.qtype))
                    }
                ),
                fields: f,
            });
            return true;
        }
    }
    if port(src, dst, 123) {
        if let Ok(p) = ntp::parse(b) {
            let ts = |v| ntp_time(v);
            layers.push(FrameLayer {
                protocol: "NTP".into(),
                summary: format!("{} · stratum {}", ntp::mode_name(p.mode), p.stratum),
                fields: vec![
                    field("LI", p.li.to_string(), o, 1),
                    field("Version", p.version.to_string(), o, 1),
                    field(
                        "Mode",
                        format!("{} · {}", p.mode, ntp::mode_name(p.mode)),
                        o,
                        1,
                    ),
                    field("Stratum", p.stratum.to_string(), o + 1, 1),
                    field("Poll", p.poll.to_string(), o + 2, 1),
                    field("Precision", p.precision.to_string(), o + 3, 1),
                    field("Root delay", p.root_delay.to_string(), o + 4, 4),
                    field("Root dispersion", p.root_dispersion.to_string(), o + 8, 4),
                    field("Reference ID", hex(&p.reference_id), o + 12, 4),
                    field("Reference timestamp", ts(p.reference_ts), o + 16, 8),
                    field("Origin timestamp", ts(p.origin_ts), o + 24, 8),
                    field("Receive timestamp", ts(p.receive_ts), o + 32, 8),
                    field("Transmit timestamp", ts(p.transmit_ts), o + 40, 8),
                ],
            });
            return true;
        }
    }
    if port(src, dst, 1900) {
        if let Ok(p) = ssdp::parse(b) {
            let mut f = vec![field(
                "Start line",
                p.start_line.clone(),
                o,
                p.start_line.len(),
            )];
            for (n, v) in p.headers {
                f.push(field(&n, v, o, 0));
            }
            layers.push(FrameLayer {
                protocol: "SSDP".into(),
                summary: p.start_line,
                fields: f,
            });
            return true;
        }
    }
    if port(src, dst, 319) || port(src, dst, 320) {
        if let Ok(p) = gptp::parse_any_transport(b) {
            layers.push(gptp_layer("PTP", p, b, o));
            return true;
        }
    }
    if port(src, dst, 69) {
        if let Ok(p) = tftp::parse(b) {
            let (op, sum, extra) = match p {
                tftp::TftpPacket::ReadRequest { filename, mode } => {
                    (1, format!("RRQ {filename}"), format!("{filename} · {mode}"))
                }
                tftp::TftpPacket::WriteRequest { filename, mode } => {
                    (2, format!("WRQ {filename}"), format!("{filename} · {mode}"))
                }
                tftp::TftpPacket::Data { block, data } => (
                    3,
                    format!("DATA block {block}"),
                    format!("block {block} · {} bytes", data.len()),
                ),
                tftp::TftpPacket::Ack { block } => {
                    (4, format!("ACK block {block}"), format!("block {block}"))
                }
                tftp::TftpPacket::Error { code, message } => (5, format!("ERROR {code}"), message),
            };
            layers.push(FrameLayer {
                protocol: "TFTP".into(),
                summary: sum,
                fields: vec![
                    field(
                        "Opcode",
                        format!("{} · {}", op, tftp::opcode_name(op)),
                        o,
                        2,
                    ),
                    field("Details", extra, o + 2, b.len().saturating_sub(2)),
                ],
            });
            return true;
        }
    }
    if port(src, dst, 161) || port(src, dst, 162) {
        if let Ok(p) = snmp::parse(b) {
            let mut f = vec![
                field("Version", p.version.to_string(), o, 0),
                field(
                    "Community",
                    String::from_utf8_lossy(&p.community).into(),
                    o,
                    0,
                ),
                field(
                    "PDU type",
                    format!("0x{:02X} · {}", p.pdu_type, snmp::pdu_type_name(p.pdu_type)),
                    o,
                    0,
                ),
                field("Request ID", p.request_id.to_string(), o, 0),
                field("Error status", p.error_status.to_string(), o, 0),
                field("Error index", p.error_index.to_string(), o, 0),
            ];
            for v in p.bindings {
                f.push(field(
                    "Variable binding",
                    format!(
                        "{} · {:?}",
                        v.oid
                            .iter()
                            .map(u32::to_string)
                            .collect::<Vec<_>>()
                            .join("."),
                        v.value
                    ),
                    o,
                    0,
                ));
            }
            layers.push(FrameLayer {
                protocol: "SNMP".into(),
                summary: snmp::pdu_type_name(p.pdu_type).into(),
                fields: f,
            });
            return true;
        }
    }
    false
}

/// (offset, len) of the first occurrence of `needle` at or after `from`; (0, 0) when absent.
fn find_bytes(haystack: &[u8], from: usize, needle: &[u8]) -> (usize, usize) {
    if needle.is_empty() || from >= haystack.len() {
        return (0, 0);
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map_or((0, 0), |p| (from + p, needle.len()))
}

/// (offset, len without CRLF) of the header line `name:` at or after `from`.
fn find_header_line(b: &[u8], from: usize, name: &str) -> (usize, usize) {
    let mut at = from;
    while at < b.len() {
        let end = b[at..]
            .iter()
            .position(|&c| c == b'\n')
            .map_or(b.len(), |p| at + p);
        let line = &b[at..end];
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            break;
        }
        if line.len() > name.len()
            && line[name.len()] == b':'
            && line[..name.len()].eq_ignore_ascii_case(name.as_bytes())
        {
            return (at, line.len());
        }
        at = end + 1;
    }
    (0, 0)
}

fn add_tcp_application(
    layers: &mut Vec<FrameLayer>,
    src: u16,
    dst: u16,
    b: &[u8],
    o: usize,
) -> bool {
    if [80, 8080, 8000].iter().any(|p| port(src, dst, *p)) || http::looks_like_http(b) {
        if let Ok(p) = http::parse(b) {
            let (start, headers, body) = match p {
                http::HttpMessage::Request {
                    method,
                    target,
                    version,
                    headers,
                    body_len,
                } => (format!("{method} {target} {version}"), headers, body_len),
                http::HttpMessage::Response {
                    version,
                    status,
                    reason,
                    headers,
                    body_len,
                } => (format!("{version} {status} {reason}"), headers, body_len),
            };
            let mut f = vec![field("Start line", start.clone(), o, start.len())];
            let mut cursor = b
                .iter()
                .position(|&c| c == b'\n')
                .map_or(b.len(), |p| p + 1);
            for (n, v) in headers {
                let (at, len) = find_header_line(b, cursor, &n);
                if len > 0 {
                    // Resume after this line's CRLF so the next header is found.
                    cursor = b[at..]
                        .iter()
                        .position(|&c| c == b'\n')
                        .map_or(b.len(), |p| at + p + 1);
                }
                f.push(field(&n, v, o + at, len));
            }
            f.push(field(
                "Body length",
                body.to_string(),
                o + b.len() - body,
                body,
            ));
            layers.push(FrameLayer {
                protocol: "HTTP".into(),
                summary: start,
                fields: f,
            });
            return true;
        }
    }
    if port(src, dst, 443) || port(src, dst, 8443) || tls::looks_like_tls(b) {
        if let Ok(p) = tls::parse(b) {
            let mut f = vec![
                field(
                    "Content type",
                    format!(
                        "{} · {}",
                        p.content_type,
                        tls::content_type_name(p.content_type)
                    ),
                    o,
                    1,
                ),
                field("Version", format!("0x{:04X}", p.version), o + 1, 2),
                field("Record length", p.length.to_string(), o + 3, 2),
            ];
            let summary = match p.handshake {
                Some(tls::Handshake::ClientHello {
                    version,
                    cipher_suite_count,
                    sni,
                    alpn,
                    ..
                }) => {
                    f.push(field("Handshake type", "ClientHello".into(), o + 5, 1));
                    f.push(field(
                        "Client version",
                        format!("0x{version:04X}"),
                        o + 9,
                        2,
                    ));
                    // Record (5) + handshake header (4) + version (2) + random (32),
                    // then session id (1 + n) and the 2-byte cipher-suites length.
                    let (suites_off, suites_len) = b
                        .get(43)
                        .map(|&sid| 44 + usize::from(sid))
                        .filter(|&at| at + 2 <= b.len())
                        .map_or((0, 0), |at| (at, 2));
                    f.push(field(
                        "Cipher-suite count",
                        cipher_suite_count.to_string(),
                        o + suites_off,
                        suites_len,
                    ));
                    if let Some(s) = &sni {
                        let (at, len) = find_bytes(b, 5, s.as_bytes());
                        f.push(field("SNI", s.clone(), o + at, len));
                    }
                    if let (Some(first), Some(last)) = (alpn.first(), alpn.last()) {
                        let (at, first_len) = find_bytes(b, 5, first.as_bytes());
                        let (last_at, last_len) = find_bytes(b, at, last.as_bytes());
                        let len = if first_len == 0 || last_len == 0 {
                            0
                        } else {
                            last_at + last_len - at
                        };
                        f.push(field("ALPN", alpn.join(", "), o + at, len));
                    }
                    format!(
                        "ClientHello{}",
                        sni.map_or(String::new(), |s| format!(" · {s}"))
                    )
                }
                Some(tls::Handshake::ServerHello {
                    version,
                    cipher_suite,
                }) => {
                    f.push(field("Handshake type", "ServerHello".into(), o + 5, 1));
                    f.push(field(
                        "Server version",
                        format!("0x{version:04X}"),
                        o + 9,
                        2,
                    ));
                    f.push(field("Cipher suite", format!("0x{cipher_suite:04X}"), o, 2));
                    "ServerHello".into()
                }
                Some(tls::Handshake::Other { handshake_type }) => {
                    let name = tls::handshake_type_name(handshake_type);
                    f.push(field("Handshake type", name.clone(), o + 5, 1));
                    name
                }
                None => tls::content_type_name(p.content_type),
            };
            layers.push(FrameLayer {
                protocol: "TLS".into(),
                summary,
                fields: f,
            });
            return true;
        }
    }
    if port(src, dst, 22) {
        if let Ok(p) = ssh::parse(b) {
            let (summary, fields) = match p {
                ssh::SshMessage::Banner {
                    protocol_version,
                    software_version,
                    comments,
                } => (
                    format!(
                        "SSH-{protocol_version}-{software_version}{}",
                        comments.map_or(String::new(), |c| format!(" {c}"))
                    ),
                    {
                        // The banner is one CRLF-terminated line; binary
                        // packet data may follow in the same segment.
                        let line = b
                            .iter()
                            .position(|&c| c == b'\n')
                            .map_or(b, |end| &b[..=end]);
                        vec![field(
                            "Banner",
                            String::from_utf8_lossy(line).trim().into(),
                            o,
                            line.len(),
                        )]
                    },
                ),
                ssh::SshMessage::Packet {
                    packet_length,
                    padding_length,
                    message_type,
                    ..
                } => (
                    format!("packet · message {message_type}"),
                    vec![
                        field("Packet length", packet_length.to_string(), o, 4),
                        field("Padding length", padding_length.to_string(), o + 4, 1),
                        field("Message type", message_type.to_string(), o + 5, 1),
                    ],
                ),
            };
            layers.push(FrameLayer {
                protocol: "SSH".into(),
                summary,
                fields,
            });
            return true;
        }
    }
    false
}

fn add_l2_standard(layers: &mut Vec<FrameLayer>, ty: u16, b: &[u8], o: usize) {
    match ty {
        lldp::ETHERTYPE => match lldp::parse(b) {
            Ok(p) => {
                let fields = p
                    .tlvs
                    .iter()
                    .enumerate()
                    .map(|(n, t)| {
                        field(
                            &format!("TLV {}", n + 1),
                            format!("{} · {}", lldp::tlv_name(t.tlv_type), hex(t.data)),
                            o + t.offset,
                            t.len + 2,
                        )
                    })
                    .collect();
                layers.push(FrameLayer {
                    protocol: "LLDP".into(),
                    summary: p.chassis_id.unwrap_or_else(|| "unknown chassis".into()),
                    fields,
                })
            }
            Err(e) => layers.push(malformed("LLDP", e)),
        },
        avtp::ETHERTYPE => match avtp::parse(b) {
            Ok(p) => {
                let mut f = vec![
                    field(
                        "Subtype",
                        format!("{} · {}", p.subtype, avtp::subtype_name(p.subtype)),
                        o,
                        1,
                    ),
                    field("Stream ID valid", p.stream_id_valid.to_string(), o + 1, 1),
                    field("Version", p.version.to_string(), o + 1, 1),
                    field("Sequence number", p.sequence_num.to_string(), o + 2, 1),
                    field("Timestamp valid", p.timestamp_valid.to_string(), o + 1, 1),
                    field("AVTP timestamp", p.avtp_timestamp.to_string(), o + 12, 4),
                    field("Stream ID", format!("0x{:016X}", p.stream_id), o + 4, 8),
                    field(
                        "Stream data length",
                        p.stream_data_length.to_string(),
                        o + 20,
                        2,
                    ),
                ];
                if let Some(a) = p.format {
                    f.push(field(
                        "AAF format",
                        format!(
                            "format {} · NSR {} · {} channels · {} bit",
                            a.format, a.nsr, a.channels_per_frame, a.bit_depth
                        ),
                        o + 16,
                        4,
                    ));
                }
                layers.push(FrameLayer {
                    protocol: "AVTP".into(),
                    summary: format!(
                        "{} · stream 0x{:016X}",
                        avtp::subtype_name(p.subtype),
                        p.stream_id
                    ),
                    fields: f,
                })
            }
            Err(e) => layers.push(malformed("AVTP", e)),
        },
        macsec::ETHERTYPE => match macsec::parse(b) {
            Ok(p) => layers.push(FrameLayer {
                protocol: "MACsec".into(),
                summary: format!("AN {}", p.association_number),
                fields: vec![
                    field(
                        "TCI/AN flags",
                        format!(
                            "V={} ES={} SC={} SCB={} E={} C={} AN={}",
                            p.version_bit,
                            p.es,
                            p.sc,
                            p.scb,
                            p.encrypted,
                            p.changed_text,
                            p.association_number
                        ),
                        o,
                        1,
                    ),
                    field("Short length", p.short_length.to_string(), o + 1, 1),
                    field("Packet number", p.packet_number.to_string(), o + 2, 4),
                    field(
                        "SCI",
                        p.sci.map_or("absent".into(), |x| format!("0x{x:016X}")),
                        o + 6,
                        usize::from(p.sci.is_some()) * 8,
                    ),
                    field(
                        "Payload",
                        format!("encrypted · {} bytes", b.len().saturating_sub(p.header_len)),
                        o + p.header_len,
                        b.len().saturating_sub(p.header_len),
                    ),
                ],
            }),
            Err(e) => layers.push(malformed("MACsec", e)),
        },
        eapol::ETHERTYPE => match eapol::parse(b) {
            Ok(p) => {
                let mut f = vec![
                    field("Version", p.version.to_string(), o, 1),
                    field(
                        "Packet type",
                        format!(
                            "{} · {}",
                            p.packet_type,
                            eapol::packet_type_name(p.packet_type)
                        ),
                        o + 1,
                        1,
                    ),
                    field("Body length", p.body_len.to_string(), o + 2, 2),
                ];
                if let Some(k) = p.key {
                    f.push(field(
                        "Key descriptor type",
                        k.descriptor_type.to_string(),
                        o + 4,
                        1,
                    ));
                    f.push(field(
                        "Key info flags",
                        format!("0x{:04X}", k.key_info),
                        o + 5,
                        2,
                    ));
                    f.push(field("Key length", k.key_length.to_string(), o + 7, 2));
                    f.push(field(
                        "Replay counter",
                        k.replay_counter.to_string(),
                        o + 9,
                        8,
                    ));
                }
                layers.push(FrameLayer {
                    protocol: "EAPOL".into(),
                    summary: eapol::packet_type_name(p.packet_type),
                    fields: f,
                })
            }
            Err(e) => layers.push(malformed("EAPOL", e)),
        },
        _ => {}
    }
}

fn rdata(v: &dns::Rdata) -> String {
    match v {
        dns::Rdata::A(a) => ip(a),
        dns::Rdata::Aaaa(a) => std::net::Ipv6Addr::from(*a).to_string(),
        dns::Rdata::Ptr(s) | dns::Rdata::Cname(s) | dns::Rdata::Ns(s) => s.clone(),
        dns::Rdata::Srv {
            priority,
            weight,
            port,
            target,
        } => format!("{priority} {weight} {port} {target}"),
        dns::Rdata::Txt(v) => v.join(" "),
        dns::Rdata::Mx {
            preference,
            exchange,
        } => format!("{preference} {exchange}"),
        dns::Rdata::Other { data, .. } => hex(data),
    }
}
fn ntp_time(v: u64) -> String {
    ntp::ntp_to_unix_ms(v)
        .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms as i64))
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| "unspecified".into())
}

fn dissect_gptp(
    idx: u64,
    t_s: f64,
    wire: &[u8],
    payload: &[u8],
    l2_len: usize,
    mut layers: Vec<FrameLayer>,
) -> FrameDetail {
    match gptp::parse_any_transport(payload) {
        Ok(message) => {
            let payload_offset = l2_len
                + gptp::HEADER_LEN
                + if message.origin_timestamp_ns.is_some() {
                    10
                } else {
                    0
                };
            layers.push(gptp_layer("gPTP", message, payload, l2_len));
            detail(idx, t_s, wire, payload_offset.min(wire.len()), layers)
        }
        Err(error) => {
            layers.push(malformed("gPTP", error));
            detail(idx, t_s, wire, wire.len(), layers)
        }
    }
}

fn gptp_layer(
    protocol: &str,
    message: gptp::GptpMessage,
    bytes: &[u8],
    offset: usize,
) -> FrameLayer {
    let mut fields = vec![
        field(
            "Message type",
            gptp_name(message.msg_type).into(),
            offset,
            1,
        ),
        field("Domain", message.domain.to_string(), offset + 4, 1),
        field(
            "Flags",
            bytes
                .get(6..8)
                .map_or_else(|| "unavailable".into(), |v| format!("0x{}", hex(v))),
            offset + 6,
            2,
        ),
        field(
            "Correction",
            message.correction_ns.to_string(),
            offset + 8,
            8,
        ),
        field(
            "Source port identity",
            bytes.get(20..30).map_or_else(
                || "unavailable".into(),
                |v| format!("{}:0x{}", hex(&v[..8]), hex(&v[8..])),
            ),
            offset + 20,
            10,
        ),
        field(
            "Sequence ID",
            message.sequence_id.to_string(),
            offset + 30,
            2,
        ),
    ];
    if let Some(ns) = message.origin_timestamp_ns {
        let rendered = i64::try_from(ns / 1_000_000)
            .ok()
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|v| v.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
            .unwrap_or_else(|| format!("{ns} ns"));
        fields.push(field("Origin timestamp", rendered, offset + 34, 10));
    }
    FrameLayer {
        protocol: protocol.into(),
        summary: format!(
            "{} · domain {} · sequence {}",
            gptp_name(message.msg_type),
            message.domain,
            message.sequence_id
        ),
        fields,
    }
}

fn gptp_name(kind: u8) -> &'static str {
    match kind {
        gptp::MSG_SYNC => "Sync",
        0x1 => "Delay_Req",
        gptp::MSG_FOLLOW_UP => "FollowUp",
        gptp::MSG_PDELAY_REQ => "PdelayReq",
        gptp::MSG_PDELAY_RESP => "PdelayResp",
        0x9 => "Delay_Resp",
        0xa => "PdelayRespFollowUp",
        gptp::MSG_ANNOUNCE => "Announce",
        0xc => "Signaling",
        0xd => "Management",
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
        bytes: hex_compact(wire),
        decoded,
    }
}

/// Returns a retained raw frame's cold-path protocol dissection.
#[tauri::command]
pub async fn frame_detail(
    state: State<'_, crate::capture::CaptureState>,
    catalog: State<'_, crate::catalog::CatalogState>,
    idx: u64,
) -> Result<FrameDetail, String> {
    // Async so the dissection runs on the worker pool, never on the main
    // thread that also delivers the streaming events.
    let started = std::time::Instant::now();
    let result = catalog.with_active(|active| state.frame_detail(idx, active));
    let ms = started.elapsed().as_millis();
    if ms >= 100 {
        crate::log::log(
            crate::log::Level::Warn,
            "dissect",
            "slow frame_detail",
            serde_json::json!({ "idx": idx, "ms": ms }),
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use radeau_proto::{
        avtp, dhcp, dns, doip, eapol,
        ethernet::EthernetFrame,
        gptp::GptpMessage,
        igmp,
        ipv4::Ipv4Packet,
        ipv6::Ipv6Packet,
        lldp, macsec, ntp, sctp,
        sd::{SdEntry, SdMessage},
        someip::SomeIpHeader,
        ssdp,
        tcp::TcpSegment,
        tls,
        udp::UdpDatagram,
    };

    fn ipv4_wire(protocol: u8, transport: &[u8]) -> Vec<u8> {
        let src = [10, 42, 0, 99];
        let dst = [10, 42, 0, 20];
        let mut ip_bytes = Vec::new();
        Ipv4Packet::build(src, dst, protocol, 1, 64, 0, transport, &mut ip_bytes);
        let mut wire = Vec::new();
        EthernetFrame::build(
            [2, 0x52, 0x41, 0x44, 0, 2],
            [2, 0x52, 0x41, 0x44, 0, 1],
            ethernet::ETHERTYPE_IPV4,
            &ip_bytes,
            &mut wire,
        );
        wire
    }

    fn doip_message(payload_type: u16, body: &[u8]) -> Vec<u8> {
        let mut message = Vec::new();
        doip::build_message(2, payload_type, body, &mut message);
        message
    }

    fn doip_udp(payload_type: u16, body: &[u8]) -> Vec<u8> {
        let message = doip_message(payload_type, body);
        let mut datagram = Vec::new();
        UdpDatagram::build(
            [10, 42, 0, 99],
            [10, 42, 0, 20],
            doip::DOIP_PORT,
            doip::DOIP_PORT,
            &message,
            &mut datagram,
        );
        ipv4_wire(ipv4::PROTOCOL_UDP, &datagram)
    }

    fn doip_tcp_payload(payload: &[u8]) -> Vec<u8> {
        let mut segment = Vec::new();
        TcpSegment::build(
            50_000,
            doip::DOIP_PORT,
            1,
            0,
            0x18,
            4096,
            payload,
            &mut segment,
        );
        ipv4_wire(ipv4::PROTOCOL_TCP, &segment)
    }

    fn udp_wire(src_port: u16, dst_port: u16, payload: &[u8]) -> Vec<u8> {
        let mut datagram = Vec::new();
        UdpDatagram::build(
            [10, 42, 0, 99],
            [10, 42, 0, 20],
            src_port,
            dst_port,
            payload,
            &mut datagram,
        );
        ipv4_wire(ipv4::PROTOCOL_UDP, &datagram)
    }

    fn tcp_wire(src_port: u16, dst_port: u16, payload: &[u8]) -> Vec<u8> {
        let mut segment = Vec::new();
        TcpSegment::build(src_port, dst_port, 1, 0, 0x18, 4096, payload, &mut segment);
        ipv4_wire(ipv4::PROTOCOL_TCP, &segment)
    }

    fn ipv6_wire(next_header: u8, payload: &[u8]) -> Vec<u8> {
        let mut packet = Vec::new();
        Ipv6Packet::build([1; 16], [2; 16], next_header, 64, payload, &mut packet);
        l2_wire(ethernet::ETHERTYPE_IPV6, &packet)
    }

    fn l2_wire(ethertype: u16, payload: &[u8]) -> Vec<u8> {
        let mut wire = Vec::new();
        EthernetFrame::build([1; 6], [2; 6], ethertype, payload, &mut wire);
        wire
    }

    fn titles(detail: &FrameDetail) -> Vec<&str> {
        detail
            .layers
            .iter()
            .map(|layer| layer.protocol.as_str())
            .collect()
    }

    fn value<'a>(layer: &'a FrameLayer, name: &str) -> &'a str {
        layer
            .fields
            .iter()
            .find(|field| field.name == name)
            .unwrap_or_else(|| panic!("missing {name} field in {}", layer.protocol))
            .value
            .as_str()
    }

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
    fn dissects_udp_vehicle_announcement_fields_and_offsets() {
        let body = [
            b"WVWZZZ1JZXW000001".as_slice(),
            &[0x12, 0x34],
            &[1, 2, 3, 4, 5, 6],
            &[7, 8, 9, 10, 11, 12],
            &[0x01, 0x10],
        ]
        .concat();
        let detail = dissect(0, 0.0, &doip_udp(0x0004, &body));
        assert_eq!(
            detail
                .layers
                .iter()
                .map(|layer| layer.protocol.as_str())
                .collect::<Vec<_>>(),
            ["Ethernet II", "IPv4", "UDP", "DoIP"]
        );
        let layer = &detail.layers[3];
        assert_eq!(layer.fields[0].offset, 42);
        assert_eq!(layer.fields[2].value, "0x0004 · Vehicle announcement");
        assert_eq!(layer.fields[4].value, "WVWZZZ1JZXW000001");
        assert_eq!(
            (layer.fields[5].offset, layer.fields[5].value.as_str()),
            (67, "0x1234")
        );
        assert_eq!(detail.payload_offset, 50);
    }

    #[test]
    fn dissects_tcp_routing_activation_reserved_field() {
        let body = [0x0e, 0x80, 1, 0x12, 0x34, 0x56, 0x78];
        let detail = dissect(0, 0.0, &doip_tcp_payload(&doip_message(0x0005, &body)));
        let layer = detail
            .layers
            .iter()
            .find(|layer| layer.protocol == "DoIP")
            .unwrap();
        assert_eq!(layer.summary, "Routing activation request · 7 bytes");
        assert_eq!(
            (layer.fields[4].offset, layer.fields[4].value.as_str()),
            (62, "0x0E80")
        );
        assert_eq!(
            (layer.fields[6].offset, layer.fields[6].value.as_str()),
            (65, "0x12345678")
        );
        assert_eq!(detail.payload_offset, 62);
    }

    #[test]
    fn dissects_tester_present_request_and_positive_response() {
        let request = doip_message(0x8001, &[0x0e, 0x80, 0x12, 0x34, 0x3e, 0x00]);
        let response = doip_message(0x8001, &[0x12, 0x34, 0x0e, 0x80, 0x7e, 0x00]);
        for (message, sid, summary) in [
            (request, "0x3E · TesterPresent", "TesterPresent"),
            (
                response,
                "0x7E · TesterPresent positive response",
                "TesterPresent positive response",
            ),
        ] {
            let detail = dissect(0, 0.0, &doip_tcp_payload(&message));
            let uds = detail
                .layers
                .iter()
                .find(|layer| layer.protocol == "UDS")
                .unwrap();
            assert_eq!(uds.summary, summary);
            assert_eq!(
                (uds.fields[0].offset, uds.fields[0].value.as_str()),
                (66, sid)
            );
            assert_eq!(
                (uds.fields[1].offset, uds.fields[1].value.as_str()),
                (67, "0x00")
            );
        }
    }

    #[test]
    fn dissects_uds_negative_response_with_named_nrc() {
        let message = doip_message(0x8001, &[0x12, 0x34, 0x0e, 0x80, 0x7f, 0x22, 0x31, 0xaa]);
        let detail = dissect(0, 0.0, &doip_tcp_payload(&message));
        let uds = detail
            .layers
            .iter()
            .find(|layer| layer.protocol == "UDS")
            .unwrap();
        assert_eq!(
            uds.summary,
            "Negative response · ReadDataByIdentifier · requestOutOfRange"
        );
        assert_eq!(uds.fields[2].value, "0x31 · requestOutOfRange");
        assert_eq!(
            (uds.fields[3].offset, uds.fields[3].value.as_str()),
            (69, "AA")
        );
    }

    #[test]
    fn walks_two_doip_messages_and_labels_a_trailing_partial() {
        let first = doip_message(0x0007, &[]);
        let second = doip_message(0x4003, &[]);
        let partial = doip_message(0x8001, &[0x0e, 0x80, 0x12, 0x34, 0x3e, 0x00]);
        let payload = [first.as_slice(), second.as_slice(), &partial[..10]].concat();
        let detail = dissect(0, 0.0, &doip_tcp_payload(&payload));
        let layers = detail
            .layers
            .iter()
            .filter(|layer| layer.protocol.starts_with("DoIP"))
            .collect::<Vec<_>>();
        assert_eq!(layers.len(), 3);
        assert_eq!(layers[0].protocol, "DoIP");
        assert_eq!(layers[1].protocol, "DoIP (2)");
        assert_eq!(layers[2].protocol, "DoIP");
        assert_eq!(layers[2].summary, "continues in next segment");
        assert_eq!(layers[2].fields[0].offset, 70);
    }

    #[test]
    fn explains_bad_inverse_and_oversized_udp_bodies() {
        let mut bad_inverse = doip_udp(0x0001, &[]);
        bad_inverse[43] = 0;
        let detail = dissect(0, 0.0, &bad_inverse);
        assert_eq!(
            detail.layers[3].summary,
            "malformed: inverse version mismatch"
        );

        let mut oversized = doip_udp(0x0001, &[]);
        oversized[46..50].copy_from_slice(&((doip::MAX_PAYLOAD_LEN + 1) as u32).to_be_bytes());
        let detail = dissect(0, 0.0, &oversized);
        assert_eq!(detail.layers[3].protocol, "DoIP");
        assert_eq!(detail.layers[3].summary, "body truncated");
        assert_eq!(detail.layers[3].fields[3].value, "65537");
    }

    #[test]
    fn labels_tcp_payload_without_a_doip_header_as_midstream() {
        let detail = dissect(0, 0.0, &doip_tcp_payload(&[0xaa; 12]));
        let layer = detail.layers.last().unwrap();
        assert_eq!(layer.protocol, "TCP payload (mid-stream)");
        assert_eq!(layer.summary, "TCP payload (mid-stream) · 12 bytes");
        assert_eq!(detail.payload_offset, 54);
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
    fn dissects_icmpv6() {
        let detail = dissect(0, 0.0, &ipv6_wire(58, &[128, 0, 0x12, 0x34, 0, 1, 0, 2]));
        assert_eq!(titles(&detail), ["Ethernet II", "IPv6", "ICMPv6"]);
        let layer = &detail.layers[2];
        assert_eq!(value(layer, "Type"), "128 · Echo Request");
        assert_eq!(value(layer, "Identifier"), "1");
        assert_eq!(value(layer, "Sequence"), "2");
    }

    #[test]
    fn dissects_igmp() {
        let mut payload = Vec::new();
        igmp::build(0x16, 10, [239, 1, 2, 3], &mut payload);
        let detail = dissect(0, 0.0, &ipv4_wire(2, &payload));
        assert_eq!(titles(&detail), ["Ethernet II", "IPv4", "IGMP"]);
        let layer = &detail.layers[2];
        assert_eq!(value(layer, "Type"), "0x16 · Version 2 Membership Report");
        assert_eq!(value(layer, "Group address"), "239.1.2.3");
    }

    #[test]
    fn dissects_dhcp() {
        let mut payload = Vec::new();
        dhcp::build_discover(0x1234_5678, [0, 1, 2, 3, 4, 5], &mut payload);
        let detail = dissect(0, 0.0, &udp_wire(68, 67, &payload));
        assert_eq!(titles(&detail), ["Ethernet II", "IPv4", "UDP", "DHCP"]);
        let layer = &detail.layers[3];
        assert_eq!(value(layer, "Transaction ID"), "0x12345678");
        assert_eq!(value(layer, "Client MAC"), "00:01:02:03:04:05");
    }

    #[test]
    fn dissects_dns() {
        let mut payload = Vec::new();
        dns::build_query(7, "example.test", 1, &mut payload).unwrap();
        let detail = dissect(0, 0.0, &udp_wire(50_000, 53, &payload));
        assert_eq!(titles(&detail), ["Ethernet II", "IPv4", "UDP", "DNS"]);
        let layer = &detail.layers[3];
        assert_eq!(value(layer, "Transaction ID"), "0x0007");
        assert_eq!(value(layer, "Question"), "example.test · A · class 1");
    }

    #[test]
    fn dissects_ntp() {
        let mut payload = Vec::new();
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
            &mut payload,
        );
        let detail = dissect(0, 0.0, &udp_wire(50_000, 123, &payload));
        assert_eq!(titles(&detail), ["Ethernet II", "IPv4", "UDP", "NTP"]);
        let layer = &detail.layers[3];
        assert_eq!(value(layer, "Mode"), "4 · server");
        assert_eq!(value(layer, "Stratum"), "2");
        assert_eq!(value(layer, "Reference ID"), "47 50 53 00");
    }

    #[test]
    fn dissects_ssdp() {
        let mut payload = Vec::new();
        ssdp::build_notify(&[("NT", "upnp:rootdevice")], &mut payload);
        let detail = dissect(0, 0.0, &udp_wire(50_000, 1900, &payload));
        assert_eq!(titles(&detail), ["Ethernet II", "IPv4", "UDP", "SSDP"]);
        let layer = &detail.layers[3];
        assert_eq!(value(layer, "Start line"), "NOTIFY * HTTP/1.1");
        assert_eq!(value(layer, "NT"), "upnp:rootdevice");
    }

    #[test]
    fn dissects_ptp_over_udp() {
        let mut payload = Vec::new();
        gptp::build(
            &GptpMessage {
                msg_type: gptp::MSG_SYNC,
                domain: 3,
                sequence_id: 9,
                correction_ns: 4,
                origin_timestamp_ns: Some(1),
            },
            &mut payload,
        );
        let detail = dissect(0, 0.0, &udp_wire(319, 320, &payload));
        assert_eq!(titles(&detail), ["Ethernet II", "IPv4", "UDP", "PTP"]);
        let layer = &detail.layers[3];
        assert_eq!(value(layer, "Domain"), "3");
        assert_eq!(value(layer, "Sequence ID"), "9");
        assert_eq!(value(layer, "Correction"), "4");
    }

    #[test]
    fn dissects_lldp() {
        let payload = lldp::build([0, 1, 2, 3, 4, 5], "eth0", 120, "ecu");
        let detail = dissect(0, 0.0, &l2_wire(lldp::ETHERTYPE, &payload));
        assert_eq!(titles(&detail), ["Ethernet II", "LLDP"]);
        let layer = &detail.layers[1];
        assert_eq!(layer.summary, "00:01:02:03:04:05");
        assert!(value(layer, "TLV 3").starts_with("TTL · 00 78"));
    }

    #[test]
    fn dissects_avtp() {
        let payload = avtp::build_aaf(7, 2, 3, 4, 5, 2, 24, &[1, 2]);
        let detail = dissect(0, 0.0, &l2_wire(avtp::ETHERTYPE, &payload));
        assert_eq!(titles(&detail), ["Ethernet II", "AVTP"]);
        let layer = &detail.layers[1];
        assert_eq!(value(layer, "Subtype"), "2 · AAF");
        assert_eq!(value(layer, "Stream ID"), "0x0000000000000007");
        assert_eq!(value(layer, "Stream data length"), "2");
    }

    #[test]
    fn dissects_macsec() {
        let payload = [0x2e, 0x12, 0, 0, 0, 7, 1, 2, 3, 4, 5, 6, 0, 9];
        let detail = dissect(0, 0.0, &l2_wire(macsec::ETHERTYPE, &payload));
        assert_eq!(titles(&detail), ["Ethernet II", "MACsec"]);
        let layer = &detail.layers[1];
        assert_eq!(value(layer, "Packet number"), "7");
        assert_eq!(value(layer, "SCI"), "0x0102030405060009");
    }

    #[test]
    fn dissects_eapol() {
        let payload = [2, 3, 0, 13, 2, 0x13, 0xca, 0, 16, 0, 0, 0, 0, 0, 0, 0, 42];
        let detail = dissect(0, 0.0, &l2_wire(eapol::ETHERTYPE, &payload));
        assert_eq!(titles(&detail), ["Ethernet II", "EAPOL"]);
        let layer = &detail.layers[1];
        assert_eq!(value(layer, "Packet type"), "3 · EAPOL-Key");
        assert_eq!(value(layer, "Replay counter"), "42");
    }

    #[test]
    fn dissects_http() {
        let detail = dissect(
            0,
            0.0,
            &tcp_wire(50_000, 80, b"GET /status HTTP/1.1\r\nHost: ecu\r\n\r\n"),
        );
        assert_eq!(titles(&detail), ["Ethernet II", "IPv4", "TCP", "HTTP"]);
        let layer = &detail.layers[3];
        assert_eq!(value(layer, "Start line"), "GET /status HTTP/1.1");
        assert_eq!(value(layer, "Host"), "ecu");
    }

    #[test]
    fn dissects_tls() {
        let payload = tls::build_client_hello("ecu.test", &["h2"]);
        let detail = dissect(0, 0.0, &tcp_wire(50_000, 443, &payload));
        assert_eq!(titles(&detail), ["Ethernet II", "IPv4", "TCP", "TLS"]);
        let layer = &detail.layers[3];
        assert_eq!(value(layer, "Handshake type"), "ClientHello");
        assert_eq!(value(layer, "SNI"), "ecu.test");
        assert_eq!(value(layer, "ALPN"), "h2");
    }

    #[test]
    fn dissects_ssh() {
        let detail = dissect(0, 0.0, &tcp_wire(50_000, 22, b"SSH-2.0-RadEAU\r\n"));
        assert_eq!(titles(&detail), ["Ethernet II", "IPv4", "TCP", "SSH"]);
        let layer = &detail.layers[3];
        assert_eq!(layer.summary, "SSH-2.0-RadEAU");
        assert_eq!(value(layer, "Banner"), "SSH-2.0-RadEAU");
    }

    #[test]
    fn dissects_sctp() {
        let mut chunks = Vec::new();
        sctp::build_data_chunk(7, 1, 2, 3, 4, &[5], &mut chunks);
        let mut payload = Vec::new();
        sctp::build(5000, 5001, 9, 10, &chunks, &mut payload);
        let detail = dissect(0, 0.0, &ipv4_wire(132, &payload));
        assert_eq!(titles(&detail), ["Ethernet II", "IPv4", "SCTP"]);
        let layer = &detail.layers[2];
        assert_eq!(value(layer, "Source port"), "5000");
        assert_eq!(value(layer, "Destination port"), "5001");
        assert!(value(layer, "Chunk 1").contains("TSN 1 stream 2 PPID 4"));
    }

    #[test]
    fn dissects_tftp() {
        let detail = dissect(0, 0.0, &udp_wire(50_000, 69, b"\0\x01boot.bin\0octet\0"));
        assert_eq!(titles(&detail), ["Ethernet II", "IPv4", "UDP", "TFTP"]);
        let layer = &detail.layers[3];
        assert_eq!(value(layer, "Opcode"), "1 · RRQ");
        assert_eq!(value(layer, "Details"), "boot.bin · octet");
    }

    #[test]
    fn dissects_snmp() {
        let payload = [
            0x30, 0x26, 0x02, 0x01, 0x01, 0x04, 0x06, b'p', b'u', b'b', b'l', b'i', b'c', 0xa0,
            0x19, 0x02, 0x01, 0x7b, 0x02, 0x01, 0, 0x02, 0x01, 0, 0x30, 0x0e, 0x30, 0x0c, 0x06,
            0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0, 0x05, 0,
        ];
        let detail = dissect(0, 0.0, &udp_wire(50_000, 161, &payload));
        assert_eq!(titles(&detail), ["Ethernet II", "IPv4", "UDP", "SNMP"]);
        let layer = &detail.layers[3];
        assert_eq!(value(layer, "Community"), "public");
        assert_eq!(value(layer, "Request ID"), "123");
        assert_eq!(value(layer, "PDU type"), "0xA0 · GetRequest");
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
        assert_eq!(detail.layers[1].summary, "Sync · domain 0 · sequence 4660");
        assert_eq!(
            detail.layers[1]
                .fields
                .iter()
                .find(|field| field.name == "Sequence ID")
                .expect("sequence field")
                .offset,
            44
        );
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

    fn field_of<'a>(layer: &'a FrameLayer, name: &str) -> &'a FrameField {
        layer
            .fields
            .iter()
            .find(|f| f.name == name)
            .unwrap_or_else(|| panic!("field {name} missing"))
    }

    // Review R1b-3a: hex rendering is byte-identical to the per-byte format!
    // it replaced, without one allocation per byte.
    #[test]
    fn hex_helpers_match_reference_formatting() {
        let bytes: Vec<u8> = (0..=255u8).collect();
        let spaced: Vec<String> = bytes.iter().map(|b| format!("{b:02X}")).collect();
        assert_eq!(hex(&bytes), spaced.join(" "));
        assert_eq!(hex_compact(&bytes), spaced.concat());
        assert_eq!(hex(&[]), "");
        let detail = dissect(0, 0.0, &udp_wire(1, 2, &[0xde, 0xad]));
        assert!(detail.bytes.ends_with("DEAD"));
        assert_eq!(detail.bytes.len(), detail.wire_len * 2);
    }

    // Review R1b-2b: the codec rejects hlen > 16 (honest Data layer), and at
    // the 16-byte boundary the Client MAC highlight covers exactly chaddr.
    #[test]
    fn dhcp_client_mac_length_is_bounded_by_chaddr() {
        let mut payload = Vec::new();
        dhcp::build_discover(0x1234_5678, [0, 1, 2, 3, 4, 5], &mut payload);
        payload[2] = 16; // hlen at the chaddr size
        let detail = dissect(0, 0.0, &udp_wire(68, 67, &payload));
        assert_eq!(field_of(&detail.layers[3], "Client MAC").len, 16);
        payload[2] = 17;
        let detail = dissect(0, 0.0, &udp_wire(68, 67, &payload));
        assert_eq!(titles(&detail), ["Ethernet II", "IPv4", "UDP", "Data"]);
    }

    // Review R1b-2a: each IGMPv3 group record highlights its own bytes.
    #[test]
    fn igmpv3_group_records_carry_their_own_offsets() {
        let records = [
            igmp::IgmpGroupRecord {
                record_type: 1,
                multicast_address: [239, 1, 1, 1],
                sources: vec![[10, 0, 0, 1], [10, 0, 0, 2]],
                auxiliary_data: vec![],
            },
            igmp::IgmpGroupRecord {
                record_type: 2,
                multicast_address: [239, 2, 2, 2],
                sources: vec![],
                auxiliary_data: vec![0xaa, 0xbb, 0xcc, 0xdd],
            },
        ];
        let mut payload = Vec::new();
        igmp::build_v3_report(&records, &mut payload);
        let detail = dissect(0, 0.0, &ipv4_wire(2, &payload));
        let layer = &detail.layers[2];
        let first = field_of(layer, "Group record 1");
        let second = field_of(layer, "Group record 2");
        assert_eq!(first.len, 8 + 2 * 4);
        assert_eq!(second.offset, first.offset + first.len);
        assert_eq!(second.len, 8 + 4);
    }

    // Review R1b-3b: the banner field is the banner line, not the segment.
    #[test]
    fn ssh_banner_field_stops_at_the_line_end() {
        let mut payload = b"SSH-2.0-RadEAU\r\n".to_vec();
        payload.extend_from_slice(&[0, 0, 0, 12, 4, 20, 0xff, 0xfe]);
        let detail = dissect(0, 0.0, &tcp_wire(50_000, 22, &payload));
        let banner = field_of(&detail.layers[3], "Banner");
        assert_eq!(banner.value, "SSH-2.0-RadEAU");
        assert_eq!(banner.len, 16);
    }

    // Review R1b-3d: header, SNI and ALPN fields point at their bytes.
    #[test]
    fn http_and_tls_fields_point_at_their_bytes() {
        let http = b"GET /status HTTP/1.1\r\nHost: ecu\r\nAccept: */*\r\n\r\n";
        let wire = tcp_wire(50_000, 80, http);
        let detail = dissect(0, 0.0, &wire);
        let host = field_of(&detail.layers[3], "Host");
        assert_eq!(&wire[host.offset..host.offset + host.len], b"Host: ecu");
        let accept = field_of(&detail.layers[3], "Accept");
        assert_eq!(
            &wire[accept.offset..accept.offset + accept.len],
            b"Accept: */*"
        );

        let hello = tls::build_client_hello("ecu.test", &["h2"]);
        let wire = tcp_wire(50_000, 443, &hello);
        let detail = dissect(0, 0.0, &wire);
        let layer = &detail.layers[3];
        let sni = field_of(layer, "SNI");
        assert_eq!(&wire[sni.offset..sni.offset + sni.len], b"ecu.test");
        let alpn = field_of(layer, "ALPN");
        assert_eq!(&wire[alpn.offset..alpn.offset + alpn.len], b"h2");
        assert_eq!(field_of(layer, "Cipher-suite count").len, 2);
    }

    // Review R1b-3e: every TLS handshake shows its type as a field.
    #[test]
    fn tls_other_handshakes_show_their_type() {
        // Handshake record carrying a Finished (20) message with a 1-byte body.
        let payload = [22, 3, 3, 0, 5, 20, 0, 0, 1, 0];
        let detail = dissect(0, 0.0, &tcp_wire(50_000, 443, &payload));
        let layer = &detail.layers[3];
        assert_eq!(field_of(layer, "Handshake type").value, layer.summary);
    }

    // Review R1b-3c: every prefix of a valid frame dissects without panicking
    // and ends in an honest layer, for the protocols that only had a happy path.
    #[test]
    fn truncated_application_payloads_never_panic() {
        let mut chunks = Vec::new();
        sctp::build_data_chunk(7, 1, 2, 3, 4, &[5], &mut chunks);
        let mut sctp_payload = Vec::new();
        sctp::build(5000, 5001, 9, 10, &chunks, &mut sctp_payload);
        type WireOf = Box<dyn Fn(&[u8]) -> Vec<u8>>;
        let cases: Vec<(&str, WireOf, Vec<u8>)> = vec![
            (
                "HTTP",
                Box::new(|p| tcp_wire(50_000, 80, p)),
                b"GET /status HTTP/1.1\r\nHost: ecu\r\n\r\n".to_vec(),
            ),
            (
                "TLS",
                Box::new(|p| tcp_wire(50_000, 443, p)),
                tls::build_client_hello("ecu.test", &["h2"]),
            ),
            (
                "SSH",
                Box::new(|p| tcp_wire(50_000, 22, p)),
                b"SSH-2.0-RadEAU\r\n".to_vec(),
            ),
            (
                "LLDP",
                Box::new(|p| l2_wire(lldp::ETHERTYPE, p)),
                lldp::build([0, 1, 2, 3, 4, 5], "eth0", 120, "ecu"),
            ),
            (
                "AVTP",
                Box::new(|p| l2_wire(avtp::ETHERTYPE, p)),
                avtp::build_aaf(7, 2, 3, 4, 5, 2, 24, &[1, 2]),
            ),
            (
                "MACsec",
                Box::new(|p| l2_wire(macsec::ETHERTYPE, p)),
                vec![0x2e, 0x12, 0, 0, 0, 7, 1, 2, 3, 4, 5, 6, 0, 9],
            ),
            (
                "EAPOL",
                Box::new(|p| l2_wire(eapol::ETHERTYPE, p)),
                vec![2, 3, 0, 13, 2, 0x13, 0xca, 0, 16, 0, 0, 0, 0, 0, 0, 0, 42],
            ),
            ("SCTP", Box::new(|p| ipv4_wire(132, p)), sctp_payload),
        ];
        for (name, wire_of, full) in cases {
            for cut in 0..full.len() {
                let detail = dissect(0, 0.0, &wire_of(&full[..cut]));
                let last = detail
                    .layers
                    .last()
                    .unwrap_or_else(|| panic!("{name} cut {cut}: no layers"));
                assert!(
                    !last.protocol.is_empty(),
                    "{name} cut {cut}: empty last layer"
                );
                assert_eq!(detail.bytes.len(), detail.wire_len * 2, "{name} cut {cut}");
            }
        }
    }
}
