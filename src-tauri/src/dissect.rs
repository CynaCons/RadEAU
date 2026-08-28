//! Cold-path raw-frame retention and protocol dissection.  The reader only
//! takes the ring lock long enough to append one already-built wire frame.

use std::collections::VecDeque;

use radeau_proto::{ethernet, gptp, ipv4, sd, someip, udp, ParseError};
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
    fn default() -> Self { Self::with_limits(FRAME_RING_CAP, FRAME_RING_BYTES) }
}

impl FrameRing {
    fn with_limits(frame_cap: usize, byte_cap: usize) -> Self {
        Self { frames: VecDeque::new(), total_bytes: 0, greatest_seen: None, frame_cap, byte_cap }
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

    pub fn detail(&self, idx: u64) -> Result<FrameDetail, String> {
        if let Some(frame) = self.frames.iter().find(|frame| frame.idx == idx) {
            return Ok(dissect(frame.idx, frame.t_s, &frame.wire));
        }
        match self.greatest_seen {
            Some(seen) if idx <= seen => Err("frame no longer buffered".into()),
            _ => Err("unknown frame".into()),
        }
    }
}

fn field(name: &str, value: String, offset: usize, len: usize) -> FrameField {
    FrameField { name: name.into(), value, offset, len }
}

fn mac(value: &[u8]) -> String {
    value.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

fn ip(value: &[u8]) -> String {
    format!("{}.{}.{}.{}", value[0], value[1], value[2], value[3])
}

fn malformed(name: &str, error: ParseError) -> FrameLayer {
    let reason = match error { ParseError::Truncated => "truncated", ParseError::Malformed => "invalid" };
    FrameLayer { protocol: name.into(), summary: format!("malformed: {reason}"), fields: Vec::new() }
}

/// Dissects only successful codec layers. A codec error becomes the final
/// layer; malformed input is therefore still inspectable and never an IPC err.
pub fn dissect(idx: u64, t_s: f64, wire: &[u8]) -> FrameDetail {
    let mut layers = Vec::new();
    let mut payload_offset = wire.len();
    let eth = match ethernet::EthernetFrame::parse(wire) {
        Ok(value) => value,
        Err(error) => {
            layers.push(malformed("Ethernet II", error));
            return detail(idx, t_s, wire, payload_offset, layers);
        }
    };
    layers.push(FrameLayer {
        protocol: "Ethernet II".into(),
        summary: format!("{} → {} · EtherType 0x{:04X}", mac(&eth.src), mac(&eth.dst), eth.ethertype),
        fields: vec![
            field("Destination", mac(&eth.dst), 0, 6), field("Source", mac(&eth.src), 6, 6),
            field("EtherType", format!("0x{:04X}", eth.ethertype), 12, 2),
        ],
    });
    if eth.ethertype == ethernet::ETHERTYPE_GPTP {
        return dissect_gptp(idx, t_s, wire, eth.payload, layers);
    }
    if eth.ethertype != ethernet::ETHERTYPE_IPV4 {
        return detail(idx, t_s, wire, payload_offset, layers);
    }
    let ip_packet = match ipv4::Ipv4Packet::parse(eth.payload) {
        Ok(value) => value,
        Err(error) => { layers.push(malformed("IPv4", error)); return detail(idx, t_s, wire, payload_offset, layers); }
    };
    let ihl = ((eth.payload[0] & 0x0f) as usize) * 4;
    layers.push(FrameLayer {
        protocol: "IPv4".into(), summary: format!("{} → {} · protocol {}", ip(&ip_packet.src), ip(&ip_packet.dst), ip_packet.protocol),
        fields: vec![field("Source", ip(&ip_packet.src), 26, 4), field("Destination", ip(&ip_packet.dst), 30, 4), field("TTL", ip_packet.ttl.to_string(), 22, 1), field("Protocol", ip_packet.protocol.to_string(), 23, 1)],
    });
    if ip_packet.protocol != ipv4::PROTOCOL_UDP { return detail(idx, t_s, wire, payload_offset, layers); }
    let udp_offset = ethernet::HEADER_LEN + ihl;
    let datagram = match udp::UdpDatagram::parse(ip_packet.payload) {
        Ok(value) => value,
        Err(error) => { layers.push(malformed("UDP", error)); return detail(idx, t_s, wire, payload_offset, layers); }
    };
    layers.push(FrameLayer {
        protocol: "UDP".into(), summary: format!("{} → {} · length {}", datagram.src_port, datagram.dst_port, ip_packet.payload.len()),
        fields: vec![field("Source port", datagram.src_port.to_string(), udp_offset, 2), field("Destination port", datagram.dst_port.to_string(), udp_offset + 2, 2), field("Length", (datagram.payload.len() + udp::HEADER_LEN).to_string(), udp_offset + 4, 2)],
    });
    let someip_offset = udp_offset + udp::HEADER_LEN;
    let (header, payload) = match someip::parse(datagram.payload) {
        Ok(value) => value,
        Err(error) => { layers.push(malformed("SOME/IP", error)); return detail(idx, t_s, wire, payload_offset, layers); }
    };
    payload_offset = someip_offset + someip::HEADER_LEN;
    layers.push(FrameLayer {
        protocol: "SOME/IP".into(), summary: format!("0x{:04X}:0x{:04X} · session 0x{:04X}", header.service_id, header.method_id, header.session_id),
        fields: vec![field("Service ID", format!("0x{:04X}", header.service_id), someip_offset, 2), field("Method ID", format!("0x{:04X}", header.method_id), someip_offset + 2, 2), field("Length", header.length.to_string(), someip_offset + 4, 4), field("Client ID", format!("0x{:04X}", header.client_id), someip_offset + 8, 2), field("Session ID", format!("0x{:04X}", header.session_id), someip_offset + 10, 2), field("Message type", format!("0x{:02X}", header.message_type), someip_offset + 14, 1)],
    });
    if header.service_id == someip::SD_SERVICE_ID && header.method_id == someip::SD_METHOD_ID {
        match sd::parse(payload) {
            Ok(message) => {
                let fields = message.entries.iter().enumerate().map(|(n, entry)| {
                    let kind = if entry.entry_type == sd::ENTRY_OFFER_SERVICE { "OfferService" } else { "FindService" };
                    field(&format!("Entry {}", n + 1), format!("{kind} 0x{:04X}:{:X} v{}.{} TTL {}", entry.service_id, entry.instance_id, entry.major_version, entry.minor_version, entry.ttl), payload_offset + 8 + n * 16, 16)
                }).collect();
                layers.push(FrameLayer { protocol: "SOME/IP-SD".into(), summary: format!("{} service entries", message.entries.len()), fields });
            }
            Err(error) => layers.push(malformed("SOME/IP-SD", error)),
        }
    }
    detail(idx, t_s, wire, payload_offset, layers)
}

fn dissect_gptp(idx: u64, t_s: f64, wire: &[u8], payload: &[u8], mut layers: Vec<FrameLayer>) -> FrameDetail {
    match gptp::parse(payload) {
        Ok(message) => {
            let payload_offset = ethernet::HEADER_LEN + gptp::HEADER_LEN + if message.origin_timestamp_ns.is_some() { 10 } else { 0 };
            layers.push(FrameLayer { protocol: "gPTP".into(), summary: format!("{} · sequence {}", gptp_name(message.msg_type), message.sequence_id), fields: vec![field("Message type", gptp_name(message.msg_type).into(), 14, 1), field("Domain", message.domain.to_string(), 18, 1), field("Sequence ID", message.sequence_id.to_string(), 44, 2), field("Correction", message.correction_ns.to_string(), 22, 8)] });
            detail(idx, t_s, wire, payload_offset.min(wire.len()), layers)
        }
        Err(error) => { layers.push(malformed("gPTP", error)); detail(idx, t_s, wire, wire.len(), layers) }
    }
}

fn gptp_name(kind: u8) -> &'static str { match kind { gptp::MSG_SYNC => "Sync", gptp::MSG_FOLLOW_UP => "FollowUp", gptp::MSG_PDELAY_REQ => "PdelayReq", gptp::MSG_PDELAY_RESP => "PdelayResp", gptp::MSG_ANNOUNCE => "Announce", _ => "Other" } }

fn detail(idx: u64, t_s: f64, wire: &[u8], payload_offset: usize, layers: Vec<FrameLayer>) -> FrameDetail {
    FrameDetail { idx, t_s, wire_len: wire.len(), payload_offset, layers, bytes: wire.iter().map(|byte| format!("{byte:02X}")).collect() }
}

/// Returns a retained raw frame's cold-path protocol dissection.
#[tauri::command]
pub fn frame_detail(
    state: State<crate::capture::CaptureState>,
    idx: u64,
) -> Result<FrameDetail, String> {
    state.frame_detail(idx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use radeau_proto::{ethernet::EthernetFrame, gptp::GptpMessage, ipv4::Ipv4Packet, sd::{SdEntry, SdMessage}, someip::SomeIpHeader, udp::UdpDatagram};

    fn someip_wire(payload: &[u8], service_id: u16, method_id: u16) -> Vec<u8> {
        let mut message = Vec::new();
        someip::build(&SomeIpHeader { service_id, method_id, length: 0, client_id: 1, session_id: 2, protocol_version: 1, interface_version: 1, message_type: someip::MSG_NOTIFICATION, return_code: 0 }, payload, &mut message);
        let src = [10, 42, 0, 11]; let dst = [10, 42, 0, 20];
        let mut udp_bytes = Vec::new(); UdpDatagram::build(src, dst, 30490, 30490, &message, &mut udp_bytes);
        let mut ip_bytes = Vec::new(); Ipv4Packet::build(src, dst, ipv4::PROTOCOL_UDP, 1, 64, 0, &udp_bytes, &mut ip_bytes);
        let mut wire = Vec::new(); EthernetFrame::build([1, 0, 0x5e, 0x7f, 0xff, 0xff], [2, 0x52, 0x41, 0x44, 0, 1], ethernet::ETHERTYPE_IPV4, &ip_bytes, &mut wire); wire
    }

    #[test]
    fn dissects_someip_event_with_wire_offsets() {
        let detail = dissect(123, 1.0421, &someip_wire(&[0xde, 0xad], 0x1101, 0x8001));
        assert_eq!(detail.payload_offset, 58);
        assert_eq!(detail.layers.iter().map(|layer| layer.protocol.as_str()).collect::<Vec<_>>(), ["Ethernet II", "IPv4", "UDP", "SOME/IP"]);
        assert_eq!(detail.layers[0].summary, "02:52:41:44:00:01 → 01:00:5E:7F:FF:FF · EtherType 0x0800");
        assert_eq!(detail.layers[3].fields[0].offset, 42);
        assert_eq!(detail.layers[3].fields[0].value, "0x1101");
    }

    #[test]
    fn dissects_sd_offer_entry() {
        let mut payload = Vec::new();
        sd::build(&SdMessage { flags: 0xc0, entries: vec![SdEntry { entry_type: sd::ENTRY_OFFER_SERVICE, service_id: 0x1101, instance_id: 1, major_version: 1, ttl: 3, minor_version: 0 }] }, &mut payload);
        let detail = dissect(0, 0.0, &someip_wire(&payload, someip::SD_SERVICE_ID, someip::SD_METHOD_ID));
        assert_eq!(detail.layers[4].protocol, "SOME/IP-SD");
        assert_eq!(detail.layers[4].fields[0].value, "OfferService 0x1101:1 v1.0 TTL 3");
        assert_eq!(detail.layers[4].fields[0].offset, 66);
    }

    #[test]
    fn dissects_gptp_sync() {
        let mut payload = Vec::new();
        gptp::build(&GptpMessage { msg_type: gptp::MSG_SYNC, domain: 0, sequence_id: 0x1234, correction_ns: -2, origin_timestamp_ns: Some(5_000_000_007) }, &mut payload);
        let mut wire = Vec::new(); EthernetFrame::build(gptp::GPTP_MULTICAST, [2, 0x52, 0x41, 0x44, 0, 1], ethernet::ETHERTYPE_GPTP, &payload, &mut wire);
        let detail = dissect(0, 0.0, &wire);
        assert_eq!(detail.layers[1].summary, "Sync · sequence 4660");
        assert_eq!(detail.layers[1].fields[2].offset, 44);
        assert_eq!(detail.payload_offset, wire.len());
    }

    #[test]
    fn malformed_tail_is_a_layer_not_an_error() {
        let mut wire = someip_wire(&[1, 2], 0x1101, 0x8001); wire.truncate(55);
        let detail = dissect(0, 0.0, &wire);
        assert_eq!(detail.layers.last().map(|layer| layer.summary.as_str()), Some("malformed: truncated"));
    }

    #[test]
    fn ring_distinguishes_evicted_and_unknown() {
        let mut ring = FrameRing::with_limits(1, 100);
        ring.push(0, 0.0, vec![1]); ring.push(1, 0.0, vec![2]);
        assert_eq!(ring.detail(0).unwrap_err(), "frame no longer buffered");
        assert_eq!(ring.detail(2).unwrap_err(), "unknown frame");
    }

    #[test]
    fn ring_evicts_for_byte_cap() {
        let mut ring = FrameRing::with_limits(10, 3);
        ring.push(0, 0.0, vec![1, 2]); ring.push(1, 0.0, vec![3, 4]);
        assert_eq!(ring.detail(0).unwrap_err(), "frame no longer buffered");
        assert!(ring.detail(1).is_ok());
    }
}
