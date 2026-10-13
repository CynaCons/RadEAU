use radeau_proto::{
    ethernet::EthernetFrame,
    ipv4::{self, Ipv4Packet},
    tcp::TcpSegment,
};

pub const TESTER_PORT: u16 = 6;
pub const TESTER_IP: [u8; 4] = [10, 42, 0, 99];
pub const TESTER_MAC: [u8; 6] = [0x02, 0x52, 0x41, 0x44, 0x00, 0x99];
pub const TESTER_ADDRESS: u16 = 0x0e80;
pub const ENTITY_ADDRESS: u16 = 0x1000;
pub const DOIP_PORT: u16 = 13_400;
pub const VIN: &[u8; 17] = b"RADEAU00000000001";

const FUSION_PORT: u16 = 5;
const FUSION_IP: [u8; 4] = [10, 42, 0, 20];
const FUSION_MAC: [u8; 6] = [0x02, 0x52, 0x41, 0x44, 0x00, 0x05];
const TESTER_TCP_PORT: u16 = 49_152;
const TCP_ACK: u16 = 0x010;
const TCP_PSH_ACK: u16 = 0x018;
const TCP_SYN: u16 = 0x002;
const TCP_SYN_ACK: u16 = 0x012;

pub struct ScheduledFrame {
    pub port: u16,
    pub frame: Vec<u8>,
}

pub struct DiagnosticSession {
    tester_seq: u32,
    entity_seq: u32,
}

impl Default for DiagnosticSession {
    fn default() -> Self {
        Self {
            tester_seq: 0x1234_5678,
            entity_seq: 0x9abc_def0,
        }
    }
}

impl DiagnosticSession {
    pub fn frames_at(&mut self, time_ms: u64, ident: &mut u16) -> Vec<ScheduledFrame> {
        let mut frames = Vec::new();

        if matches!(time_ms, 0 | 500 | 1000) || (time_ms != 0 && time_ms.is_multiple_of(30_000)) {
            let message = vehicle_announcement();
            frames.push(ScheduledFrame {
                port: FUSION_PORT,
                frame: udp_frame(&message, ident),
            });
        }

        match time_ms {
            1500 => {
                frames.push(self.tester_segment(TCP_SYN, &[], ident));
                self.tester_seq = self.tester_seq.wrapping_add(1);
                frames.push(self.entity_segment(TCP_SYN_ACK, &[], ident));
                self.entity_seq = self.entity_seq.wrapping_add(1);
                frames.push(self.tester_segment(TCP_ACK, &[], ident));
            }
            2000 => {
                let request = routing_activation_request();
                frames.push(self.tester_data(&request, ident));
                let response = routing_activation_response();
                frames.push(self.entity_data(&response, ident));
                let tester_present =
                    diagnostic_message(TESTER_ADDRESS, ENTITY_ADDRESS, &[0x3e, 0x80]);
                frames.push(self.tester_data(&tester_present, ident));
            }
            _ if time_ms > 2000 && time_ms.is_multiple_of(2000) => {
                let tester_present =
                    diagnostic_message(TESTER_ADDRESS, ENTITY_ADDRESS, &[0x3e, 0x80]);
                frames.push(self.tester_data(&tester_present, ident));
                if time_ms.is_multiple_of(10_000) {
                    let read_vin =
                        diagnostic_message(TESTER_ADDRESS, ENTITY_ADDRESS, &[0x22, 0xf1, 0x90]);
                    frames.push(self.tester_data(&read_vin, ident));
                }
            }
            _ => {}
        }

        if time_ms >= 2005 && (time_ms - 5).is_multiple_of(2000) {
            let ack = diagnostic_ack(ENTITY_ADDRESS, TESTER_ADDRESS);
            frames.push(self.entity_data(&ack, ident));
        }
        if time_ms >= 2010 && (time_ms - 10).is_multiple_of(2000) {
            let response = diagnostic_message(ENTITY_ADDRESS, TESTER_ADDRESS, &[0x7e, 0x80]);
            frames.push(self.entity_data(&response, ident));
        }
        if time_ms >= 10_005 && (time_ms - 5).is_multiple_of(10_000) {
            let ack = diagnostic_ack(ENTITY_ADDRESS, TESTER_ADDRESS);
            frames.push(self.entity_data(&ack, ident));
        }
        if time_ms >= 10_010 && (time_ms - 10).is_multiple_of(10_000) {
            let mut uds = vec![0x62, 0xf1, 0x90];
            uds.extend_from_slice(VIN);
            let response = diagnostic_message(ENTITY_ADDRESS, TESTER_ADDRESS, &uds);
            frames.push(self.entity_data(&response, ident));
        }

        frames
    }

    fn tester_data(&mut self, payload: &[u8], ident: &mut u16) -> ScheduledFrame {
        let frame = self.tester_segment(TCP_PSH_ACK, payload, ident);
        self.tester_seq = self.tester_seq.wrapping_add(payload.len() as u32);
        frame
    }

    fn entity_data(&mut self, payload: &[u8], ident: &mut u16) -> ScheduledFrame {
        let frame = self.entity_segment(TCP_PSH_ACK, payload, ident);
        self.entity_seq = self.entity_seq.wrapping_add(payload.len() as u32);
        frame
    }

    fn tester_segment(&self, flags: u16, payload: &[u8], ident: &mut u16) -> ScheduledFrame {
        ScheduledFrame {
            port: TESTER_PORT,
            frame: tcp_frame(
                TESTER_MAC,
                FUSION_MAC,
                TESTER_IP,
                FUSION_IP,
                TESTER_TCP_PORT,
                DOIP_PORT,
                self.tester_seq,
                if flags & TCP_ACK != 0 {
                    self.entity_seq
                } else {
                    0
                },
                flags,
                payload,
                ident,
            ),
        }
    }

    fn entity_segment(&self, flags: u16, payload: &[u8], ident: &mut u16) -> ScheduledFrame {
        ScheduledFrame {
            port: FUSION_PORT,
            frame: tcp_frame(
                FUSION_MAC,
                TESTER_MAC,
                FUSION_IP,
                TESTER_IP,
                DOIP_PORT,
                TESTER_TCP_PORT,
                self.entity_seq,
                self.tester_seq,
                flags,
                payload,
                ident,
            ),
        }
    }
}

fn doip_message(payload_type: u16, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + payload.len());
    out.extend_from_slice(&[0x02, 0xfd]);
    out.extend_from_slice(&payload_type.to_be_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn vehicle_announcement() -> Vec<u8> {
    let mut payload = Vec::with_capacity(32);
    payload.extend_from_slice(VIN);
    payload.extend_from_slice(&ENTITY_ADDRESS.to_be_bytes());
    payload.extend_from_slice(&FUSION_MAC);
    payload.extend_from_slice(&[0; 6]);
    payload.push(0);
    doip_message(0x0004, &payload)
}

fn routing_activation_request() -> Vec<u8> {
    let mut payload = Vec::with_capacity(7);
    payload.extend_from_slice(&TESTER_ADDRESS.to_be_bytes());
    payload.push(0);
    payload.extend_from_slice(&[0; 4]);
    doip_message(0x0005, &payload)
}

fn routing_activation_response() -> Vec<u8> {
    let mut payload = Vec::with_capacity(9);
    payload.extend_from_slice(&TESTER_ADDRESS.to_be_bytes());
    payload.extend_from_slice(&ENTITY_ADDRESS.to_be_bytes());
    payload.push(0x10);
    payload.extend_from_slice(&[0; 4]);
    doip_message(0x0006, &payload)
}

fn diagnostic_message(source: u16, target: u16, uds: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(4 + uds.len());
    payload.extend_from_slice(&source.to_be_bytes());
    payload.extend_from_slice(&target.to_be_bytes());
    payload.extend_from_slice(uds);
    doip_message(0x8001, &payload)
}

fn diagnostic_ack(source: u16, target: u16) -> Vec<u8> {
    let mut payload = Vec::with_capacity(5);
    payload.extend_from_slice(&source.to_be_bytes());
    payload.extend_from_slice(&target.to_be_bytes());
    payload.push(0);
    doip_message(0x8002, &payload)
}

fn udp_frame(message: &[u8], ident: &mut u16) -> Vec<u8> {
    let mut udp = Vec::new();
    radeau_proto::udp::UdpDatagram::build(
        FUSION_IP, [255; 4], DOIP_PORT, DOIP_PORT, message, &mut udp,
    );
    let mut ip = Vec::new();
    Ipv4Packet::build(
        FUSION_IP,
        [255; 4],
        ipv4::PROTOCOL_UDP,
        *ident,
        64,
        0,
        &udp,
        &mut ip,
    );
    *ident = next_ident(*ident);
    let mut out = Vec::new();
    EthernetFrame::build(
        [0xff; 6],
        FUSION_MAC,
        radeau_proto::ethernet::ETHERTYPE_IPV4,
        &ip,
        &mut out,
    );
    out
}

#[allow(clippy::too_many_arguments)]
fn tcp_frame(
    src_mac: [u8; 6],
    dst_mac: [u8; 6],
    src_ip: [u8; 4],
    dst_ip: [u8; 4],
    src_port: u16,
    dst_port: u16,
    seq: u32,
    ack: u32,
    flags: u16,
    payload: &[u8],
    ident: &mut u16,
) -> Vec<u8> {
    let mut tcp = Vec::new();
    TcpSegment::build(
        src_port, dst_port, seq, ack, flags, 64_240, payload, &mut tcp,
    );
    let checksum = tcp_checksum(src_ip, dst_ip, &tcp);
    tcp[16..18].copy_from_slice(&checksum.to_be_bytes());

    let mut ip = Vec::new();
    Ipv4Packet::build(
        src_ip,
        dst_ip,
        ipv4::PROTOCOL_TCP,
        *ident,
        64,
        0,
        &tcp,
        &mut ip,
    );
    *ident = next_ident(*ident);
    let mut out = Vec::new();
    EthernetFrame::build(
        dst_mac,
        src_mac,
        radeau_proto::ethernet::ETHERTYPE_IPV4,
        &ip,
        &mut out,
    );
    out
}

fn tcp_checksum(src: [u8; 4], dst: [u8; 4], segment: &[u8]) -> u16 {
    let length = (segment.len() as u16).to_be_bytes();
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
    radeau_proto::internet_checksum(&[&pseudo, segment])
}

fn next_ident(value: u16) -> u16 {
    if value == u16::MAX {
        1
    } else {
        value + 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn announcement_is_byte_exact() {
        let mut expected = vec![0x02, 0xfd, 0x00, 0x04, 0, 0, 0, 32];
        expected.extend_from_slice(b"RADEAU00000000001");
        expected.extend_from_slice(&[0x10, 0x00, 0x02, 0x52, 0x41, 0x44, 0, 5]);
        expected.extend_from_slice(&[0; 7]);
        assert_eq!(vehicle_announcement(), expected);
    }

    #[test]
    fn tester_present_is_byte_exact() {
        assert_eq!(
            diagnostic_message(TESTER_ADDRESS, ENTITY_ADDRESS, &[0x3e, 0x80]),
            [0x02, 0xfd, 0x80, 0x01, 0, 0, 0, 6, 0x0e, 0x80, 0x10, 0x00, 0x3e, 0x80,]
        );
    }

    #[test]
    fn tcp_checksum_matches_fixed_vector() {
        let mut segment = Vec::new();
        TcpSegment::build(
            49_152,
            13_400,
            0x1234_5679,
            0x9abc_def1,
            TCP_PSH_ACK,
            64_240,
            &[1, 2, 3],
            &mut segment,
        );
        assert_eq!(tcp_checksum(TESTER_IP, FUSION_IP, &segment), 0xc557);
        segment[16..18].copy_from_slice(&0xc557u16.to_be_bytes());
        assert_eq!(tcp_checksum(TESTER_IP, FUSION_IP, &segment), 0);
    }

    #[test]
    fn fixed_schedule_covers_diagnostic_cast() {
        let mut session = DiagnosticSession::default();
        let mut ident = 1;
        let mut announcements = Vec::new();
        let mut routing = Vec::new();
        let mut tester_present = Vec::new();
        for time_ms in 0..=4010 {
            for scheduled in session.frames_at(time_ms, &mut ident) {
                let ethernet = EthernetFrame::parse(&scheduled.frame).unwrap();
                let ip = Ipv4Packet::parse(ethernet.payload).unwrap();
                let payload = if ip.protocol == ipv4::PROTOCOL_UDP {
                    radeau_proto::udp::UdpDatagram::parse(ip.payload)
                        .unwrap()
                        .payload
                } else {
                    TcpSegment::parse(ip.payload).unwrap().payload
                };
                if payload.len() < 8 {
                    continue;
                }
                let payload_type = u16::from_be_bytes([payload[2], payload[3]]);
                match payload_type {
                    0x0004 => announcements.push(time_ms),
                    0x0005 | 0x0006 => routing.push((time_ms, payload_type)),
                    0x8001
                        if scheduled.port == TESTER_PORT
                            && payload.get(12..14) == Some(&[0x3e, 0x80]) =>
                    {
                        tester_present.push(time_ms)
                    }
                    _ => {}
                }
            }
        }
        assert_eq!(announcements, [0, 500, 1000]);
        assert_eq!(routing, [(2000, 0x0005), (2000, 0x0006)]);
        assert_eq!(tester_present, [2000, 4000]);
    }
}
