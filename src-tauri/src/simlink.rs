//! Simulator monitor-link client: handshake validation, binary record
//! de-framing, and Ethernet → GenFrame classification for the capture
//! reader (ARCHITECTURE §2 minimal cut). Network I/O lives in `capture`;
//! this module is buffer-driven so unit tests stay network-free.
//!
//! Wire contract (pinned): TCP peer sends one JSON handshake line, then
//! big-endian records `{u32 length, u64 switch_time_ns, u16 port_id,
//! u8 direction, [frame|gap body]}`. Gap: `port_id == 0xFFFF &&
//! direction == 0xFF`. Hostile peers: length capped at `MAX_RECORD_LEN`.

use std::io::{self, Read};

use serde::Deserialize;

use crate::classify::{classify_frame, sim_direction};
use crate::endpoints::EndpointTable;
use crate::frame::GenFrame;

/// Bytes after the length field for a frame record header (time + port + dir).
pub const RECORD_HEADER_LEN: usize = 11;
/// Sane max for the length field (64 KiB); larger → link error.
pub const MAX_RECORD_LEN: u32 = 64 * 1024;
/// Gap record markers.
pub const GAP_PORT_ID: u16 = 0xFFFF;
pub const GAP_DIRECTION: u8 = 0xFF;

const LINK_NAME: &str = "ecu-netsim-monitor";
const LINK_VERSION: u32 = 1;

/// One port from the monitor handshake.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct HandshakePort {
    pub id: u16,
    pub name: String,
    pub ip: String,
}

/// Validated monitor-link handshake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handshake {
    pub scenario: String,
    pub ports: Vec<HandshakePort>,
}

#[derive(Debug, Deserialize)]
struct HandshakeRaw {
    link: String,
    version: u32,
    scenario: String,
    ports: Vec<HandshakePort>,
}

/// Reject anything that is not a v1 `ecu-netsim-monitor` handshake.
pub fn validate_handshake_line(line: &str) -> Result<Handshake, String> {
    let line = line.trim_end_matches(['\r', '\n']);
    let raw: HandshakeRaw =
        serde_json::from_str(line).map_err(|e| format!("handshake JSON: {e}"))?;
    if raw.link != LINK_NAME {
        return Err(format!(
            "handshake link {:?}, expected {:?}",
            raw.link, LINK_NAME
        ));
    }
    if raw.version != LINK_VERSION {
        return Err(format!(
            "handshake version {}, expected {LINK_VERSION}",
            raw.version
        ));
    }
    Ok(Handshake {
        scenario: raw.scenario,
        ports: raw.ports,
    })
}

/// A de-framed monitor record (frame or gap).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonitorRecord {
    Frame {
        switch_time_ns: u64,
        port_id: u16,
        direction: u8,
        frame: Vec<u8>,
    },
    Gap {
        switch_time_ns: u64,
        dropped_count: u32,
        span_ns: u64,
    },
}

/// Incremental record parser over a growable byte buffer (handles split reads).
#[derive(Debug, Default)]
pub struct RecordDeframer {
    buf: Vec<u8>,
}

impl RecordDeframer {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    /// Pop the next complete record, or `Ok(None)` if more bytes are needed.
    /// `Err` is a link-protocol violation (caller should reconnect).
    pub fn next_record(&mut self) -> Result<Option<MonitorRecord>, String> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let length = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]);
        if length < RECORD_HEADER_LEN as u32 || length > MAX_RECORD_LEN {
            return Err(format!(
                "record length {length} out of range [{RECORD_HEADER_LEN}..{MAX_RECORD_LEN}]"
            ));
        }
        let total = 4 + length as usize;
        if self.buf.len() < total {
            return Ok(None);
        }
        let body = &self.buf[4..total];
        let switch_time_ns = u64::from_be_bytes(body[0..8].try_into().map_err(|_| "time")?);
        let port_id = u16::from_be_bytes(body[8..10].try_into().map_err(|_| "port")?);
        let direction = body[10];
        let payload = &body[RECORD_HEADER_LEN..];

        let record = if port_id == GAP_PORT_ID && direction == GAP_DIRECTION {
            if payload.len() < 12 {
                return Err(format!(
                    "gap record body too short ({} < 12)",
                    payload.len()
                ));
            }
            let dropped_count =
                u32::from_be_bytes(payload[0..4].try_into().map_err(|_| "gap count")?);
            let span_ns = u64::from_be_bytes(payload[4..12].try_into().map_err(|_| "gap span")?);
            MonitorRecord::Gap {
                switch_time_ns,
                dropped_count,
                span_ns,
            }
        } else {
            MonitorRecord::Frame {
                switch_time_ns,
                port_id,
                direction,
                frame: payload.to_vec(),
            }
        };
        self.buf.drain(..total);
        Ok(Some(record))
    }
}

/// Read bytes until a `\n`-terminated line is complete (or EOF / error).
pub fn read_handshake_line<R: Read>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    scratch: &mut [u8],
) -> io::Result<String> {
    loop {
        if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&buf[..=pos]).into_owned();
            buf.drain(..=pos);
            return Ok(line);
        }
        let n = reader.read(scratch)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "EOF before handshake newline",
            ));
        }
        buf.extend_from_slice(&scratch[..n]);
        // Cap handshake accumulation so a non-newline flood can't grow forever.
        if buf.len() > 64 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "handshake line exceeds 64 KiB",
            ));
        }
    }
}

/// Session-scoped mapper: assigns monotonic idx / relative time and counts
/// and gaps. Pure over pushed records — the capture thread owns networking.
#[derive(Debug, Default)]
pub struct FrameMapper {
    pub idx: u64,
    pub first_ns: Option<u64>,
    pub gap_count: u64,
    pub gap_dropped_total: u64,
    pub endpoints: EndpointTable,
}

impl FrameMapper {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    pub fn map_record(&mut self, record: MonitorRecord) -> Option<GenFrame> {
        self.map_record_with_wire(record).map(|(frame, _)| frame)
    }

    /// Maps a monitor record while preserving the owned Ethernet frame for the
    /// capture-side raw-frame ring.
    pub fn map_record_with_wire(&mut self, record: MonitorRecord) -> Option<(GenFrame, Vec<u8>)> {
        match record {
            MonitorRecord::Gap {
                dropped_count,
                span_ns: _,
                ..
            } => {
                self.gap_count += 1;
                self.gap_dropped_total += dropped_count as u64;
                None
            }
            MonitorRecord::Frame {
                switch_time_ns,
                port_id: _,
                direction,
                frame,
            } => {
                let first = *self.first_ns.get_or_insert(switch_time_ns);
                let t_s = (switch_time_ns.saturating_sub(first)) as f64 / 1_000_000_000.0;
                let idx = self.idx;
                let classified = classify_frame(
                    &frame,
                    idx,
                    t_s,
                    sim_direction(direction),
                    &mut self.endpoints,
                );
                self.idx += 1;
                Some((classified, frame))
            }
        }
    }
}

/// Encode one frame record into `out` (test / fixture helper).
#[cfg(test)]
pub fn encode_frame_record(
    switch_time_ns: u64,
    port_id: u16,
    direction: u8,
    frame: &[u8],
    out: &mut Vec<u8>,
) {
    let length = (RECORD_HEADER_LEN + frame.len()) as u32;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(&switch_time_ns.to_be_bytes());
    out.extend_from_slice(&port_id.to_be_bytes());
    out.push(direction);
    out.extend_from_slice(frame);
}

/// Encode one gap record into `out` (test / fixture helper).
#[cfg(test)]
pub fn encode_gap_record(switch_time_ns: u64, dropped_count: u32, span_ns: u64, out: &mut Vec<u8>) {
    let length = (RECORD_HEADER_LEN + 12) as u32;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(&switch_time_ns.to_be_bytes());
    out.extend_from_slice(&GAP_PORT_ID.to_be_bytes());
    out.push(GAP_DIRECTION);
    out.extend_from_slice(&dropped_count.to_be_bytes());
    out.extend_from_slice(&span_ns.to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codes::{
        DIR_RX, GPTP_TY_OTHER, PROTO_ARP, PROTO_GPTP, PROTO_SD, PROTO_SOMEIP,
        SOMEIP_TY_NOTIFICATION, SOMEIP_TY_REQUEST,
    };
    use radeau_proto::udp::UdpDatagram;
    use radeau_proto::{
        ethernet::{self, EthernetFrame},
        gptp,
        ipv4::{self, Ipv4Packet},
        someip::{self, SomeIpHeader},
    };

    const UDP_PORT_SOMEIP: u16 = 30490;
    const HANDSHAKE: &str = r#"{"link":"ecu-netsim-monitor","version":1,"scenario":"sensor-fusion","ports":[{"id":1,"name":"camera","ip":"10.42.0.11"},{"id":2,"name":"radar","ip":"10.42.0.12"},{"id":3,"name":"lidar","ip":"10.42.0.13"},{"id":4,"name":"dynamics","ip":"10.42.0.14"},{"id":5,"name":"fusion","ip":"10.42.0.20"}]}"#;

    #[test]
    fn handshake_accepts_pinned_contract() {
        let h = validate_handshake_line(HANDSHAKE).expect("valid");
        assert_eq!(h.scenario, "sensor-fusion");
        assert_eq!(h.ports.len(), 5);
        assert_eq!(h.ports[4].name, "fusion");
        assert_eq!(h.ports[0].name, "camera");
        assert_eq!(h.ports[4].ip, "10.42.0.20");
    }

    #[test]
    fn handshake_rejects_bad_link_or_version() {
        assert!(validate_handshake_line(
            r#"{"link":"other","version":1,"scenario":"x","ports":[]}"#
        )
        .is_err());
        assert!(validate_handshake_line(
            r#"{"link":"ecu-netsim-monitor","version":2,"scenario":"x","ports":[]}"#
        )
        .is_err());
        assert!(validate_handshake_line("not-json").is_err());
    }

    fn someip_notification_frame() -> Vec<u8> {
        let mut payload = Vec::new();
        someip::build(
            &SomeIpHeader {
                service_id: 0x1101,
                method_id: 0x8001,
                length: 0,
                client_id: 1,
                session_id: 42,
                protocol_version: 1,
                interface_version: 1,
                message_type: someip::MSG_NOTIFICATION,
                return_code: 0,
            },
            &[0xDE, 0xAD, 0xBE, 0xEF],
            &mut payload,
        );
        let src = [10, 42, 0, 11];
        let dst = [10, 42, 0, 20];
        let mut l3 = Vec::new();
        UdpDatagram::build(
            src,
            dst,
            UDP_PORT_SOMEIP,
            UDP_PORT_SOMEIP,
            &payload,
            &mut l3,
        );
        let mut ip_payload = Vec::new();
        Ipv4Packet::build(src, dst, ipv4::PROTOCOL_UDP, 1, 64, 0, &l3, &mut ip_payload);
        let mut wire = Vec::new();
        EthernetFrame::build(
            [0x02, 0, 0x42, 0, 0, 1],
            [0x02, 0, 0x42, 0, 0, 11],
            ethernet::ETHERTYPE_IPV4,
            &ip_payload,
            &mut wire,
        );
        wire
    }

    fn gptp_frame() -> Vec<u8> {
        let mut wire = Vec::new();
        EthernetFrame::build(
            gptp::GPTP_MULTICAST,
            [0x02, 0, 0x42, 0, 0, 11],
            ethernet::ETHERTYPE_GPTP,
            &[0u8; 30],
            &mut wire,
        );
        wire
    }

    fn sd_offer_frame() -> Vec<u8> {
        let mut payload = Vec::new();
        someip::build(
            &SomeIpHeader {
                service_id: someip::SD_SERVICE_ID,
                method_id: someip::SD_METHOD_ID,
                length: 0,
                client_id: 0,
                session_id: 1,
                protocol_version: 1,
                interface_version: 1,
                message_type: someip::MSG_NOTIFICATION,
                return_code: 0,
            },
            &[0u8; 36],
            &mut payload,
        );
        let src = [10, 42, 0, 11];
        let dst = [239, 255, 255, 250];
        let mut l3 = Vec::new();
        UdpDatagram::build(
            src,
            dst,
            UDP_PORT_SOMEIP,
            UDP_PORT_SOMEIP,
            &payload,
            &mut l3,
        );
        let mut ip_payload = Vec::new();
        Ipv4Packet::build(src, dst, ipv4::PROTOCOL_UDP, 1, 64, 0, &l3, &mut ip_payload);
        let mut wire = Vec::new();
        EthernetFrame::build(
            [0x01, 0x00, 0x5e, 0x7f, 0xff, 0xfa],
            [0x02, 0, 0x42, 0, 0, 11],
            ethernet::ETHERTYPE_IPV4,
            &ip_payload,
            &mut wire,
        );
        wire
    }

    #[test]
    fn deframer_handles_split_reads_and_gap() {
        let frame = someip_notification_frame();
        let mut stream = Vec::new();
        encode_frame_record(1_000, 1, 0, &frame, &mut stream);
        encode_gap_record(2_000, 7, 500, &mut stream);
        encode_frame_record(3_000, 2, 0, &frame, &mut stream);

        let mut deframer = RecordDeframer::new();
        // Split across the first length field and mid-body.
        deframer.push(&stream[..2]);
        assert!(matches!(deframer.next_record(), Ok(None)));
        deframer.push(&stream[2..20]);
        assert!(matches!(deframer.next_record(), Ok(None)));
        deframer.push(&stream[20..]);

        let r1 = deframer.next_record().unwrap().unwrap();
        match r1 {
            MonitorRecord::Frame {
                switch_time_ns,
                port_id,
                frame: f,
                ..
            } => {
                assert_eq!(switch_time_ns, 1_000);
                assert_eq!(port_id, 1);
                assert_eq!(f, frame);
            }
            _ => panic!("expected frame"),
        }
        let r2 = deframer.next_record().unwrap().unwrap();
        match r2 {
            MonitorRecord::Gap {
                dropped_count,
                span_ns,
                ..
            } => {
                assert_eq!(dropped_count, 7);
                assert_eq!(span_ns, 500);
            }
            _ => panic!("expected gap"),
        }
        assert!(matches!(
            deframer.next_record().unwrap().unwrap(),
            MonitorRecord::Frame { port_id: 2, .. }
        ));
        assert!(matches!(deframer.next_record(), Ok(None)));
    }

    #[test]
    fn deframer_rejects_oversized_length() {
        let mut bad = Vec::new();
        bad.extend_from_slice(&(MAX_RECORD_LEN + 1).to_be_bytes());
        bad.extend_from_slice(&[0u8; 20]);
        let mut d = RecordDeframer::new();
        d.push(&bad);
        assert!(d.next_record().is_err());
    }

    #[test]
    fn classify_maps_someip_sd_gptp() {
        let mut endpoints = EndpointTable::default();
        let someip = classify_frame(&someip_notification_frame(), 0, 0.0, DIR_RX, &mut endpoints);
        assert_eq!(someip.proto, PROTO_SOMEIP);
        assert_eq!(someip.svc, 0x1101);
        assert_eq!(someip.method, 0x8001);
        assert_eq!(someip.msg_type, SOMEIP_TY_NOTIFICATION);
        assert_eq!(someip.session, 42);
        assert_eq!(someip.src_ep, 0);
        assert_eq!(someip.dir, DIR_RX);

        let sd = classify_frame(&sd_offer_frame(), 1, 0.1, DIR_RX, &mut endpoints);
        assert_eq!(sd.proto, PROTO_SD);
        assert_eq!(sd.msg_type, crate::codes::SD_TY_EMPTY);
        assert_eq!(sd.session, 1); // from SOME/IP header; only gPTP forces -1
        assert_eq!(sd.src_ep, 0);

        let g = classify_frame(&gptp_frame(), 2, 0.2, DIR_RX, &mut endpoints);
        assert_eq!(g.proto, PROTO_GPTP);
        assert_eq!(g.msg_type, GPTP_TY_OTHER);
        assert_eq!(g.session, -1);
    }

    #[test]
    fn classify_maps_non_notification_msg_type() {
        let mut payload = Vec::new();
        someip::build(
            &SomeIpHeader {
                service_id: 0x1101,
                method_id: 0x0001,
                length: 0,
                client_id: 1,
                session_id: 9,
                protocol_version: 1,
                interface_version: 1,
                message_type: someip::MSG_REQUEST,
                return_code: 0,
            },
            &[1, 2, 3],
            &mut payload,
        );
        let src = [10, 42, 0, 11];
        let dst = [10, 42, 0, 20];
        let mut l3 = Vec::new();
        UdpDatagram::build(
            src,
            dst,
            UDP_PORT_SOMEIP,
            UDP_PORT_SOMEIP,
            &payload,
            &mut l3,
        );
        let mut ip_payload = Vec::new();
        Ipv4Packet::build(src, dst, ipv4::PROTOCOL_UDP, 1, 64, 0, &l3, &mut ip_payload);
        let mut wire = Vec::new();
        EthernetFrame::build(
            [0x02, 0, 0x42, 0, 0, 1],
            [0x02, 0, 0x42, 0, 0, 11],
            ethernet::ETHERTYPE_IPV4,
            &ip_payload,
            &mut wire,
        );
        let f = classify_frame(&wire, 0, 0.0, DIR_RX, &mut EndpointTable::default());
        assert_eq!(f.msg_type, SOMEIP_TY_REQUEST);
    }

    #[test]
    fn mapper_relative_time_and_gap_skip() {
        let frame = someip_notification_frame();
        let mut mapper = FrameMapper::new();
        let f0 = mapper
            .map_record(MonitorRecord::Frame {
                switch_time_ns: 5_000_000_000,
                port_id: 1,
                direction: 0,
                frame: frame.clone(),
            })
            .unwrap();
        assert_eq!(f0.t_s, 0.0);
        assert_eq!(f0.idx, 0);
        assert!(mapper
            .map_record(MonitorRecord::Gap {
                switch_time_ns: 5_100_000_000,
                dropped_count: 3,
                span_ns: 50,
            })
            .is_none());
        assert_eq!(mapper.gap_count, 1);
        assert_eq!(mapper.gap_dropped_total, 3);
        let f1 = mapper
            .map_record(MonitorRecord::Frame {
                switch_time_ns: 5_500_000_000,
                port_id: 5,
                direction: 0,
                frame,
            })
            .unwrap();
        assert!((f1.t_s - 0.5).abs() < 1e-9);
        assert_eq!(f1.idx, 1);
        assert_eq!(f1.src_ep, 0);
    }

    #[test]
    fn mapper_keeps_arp_frames() {
        // ARP-like ethertype — not SOME/IP / SD / gPTP.
        let mut wire = Vec::new();
        EthernetFrame::build(
            [0xff; 6],
            [0x02, 0, 0, 0, 0, 1],
            0x0806,
            &[0u8; 28],
            &mut wire,
        );
        let mut mapper = FrameMapper::new();
        let mapped = mapper
            .map_record(MonitorRecord::Frame {
                switch_time_ns: 0,
                port_id: 1,
                direction: 0,
                frame: wire,
            })
            .unwrap();
        assert_eq!(mapped.proto, PROTO_ARP);
        assert_eq!(mapper.idx, 1);
    }

    #[test]
    fn pinned_stream_projects_into_genframes() {
        // Mapping-layer stand-in for a fake server: handshake → records → frames.
        let h = validate_handshake_line(HANDSHAKE).unwrap();
        assert_eq!(h.ports.len(), 5);

        let mut stream = Vec::new();
        encode_frame_record(100, 1, 0, &someip_notification_frame(), &mut stream);
        encode_frame_record(200, 1, 0, &gptp_frame(), &mut stream);
        encode_frame_record(300, 2, 0, &sd_offer_frame(), &mut stream);

        let mut deframer = RecordDeframer::new();
        deframer.push(&stream);
        let mut mapper = FrameMapper::new();
        let mut out = Vec::new();
        while let Some(rec) = deframer.next_record().unwrap() {
            if let Some(f) = mapper.map_record(rec) {
                out.push(f);
            }
        }
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].proto, PROTO_SOMEIP);
        assert_eq!(out[1].proto, PROTO_GPTP);
        assert_eq!(out[2].proto, PROTO_SD);
        assert_eq!(out[0].wire_len as usize, someip_notification_frame().len());
        assert!(!out[0].snap.iter().all(|&b| b == 0));
    }
}
