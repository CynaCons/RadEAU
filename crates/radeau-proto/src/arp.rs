//! Ethernet/IPv4 ARP packet codec (RFC 826 fixed 28-byte form).
use crate::ParseError;

pub const PACKET_LEN: usize = 28;
pub const HTYPE_ETHERNET: u16 = 1;
pub const PTYPE_IPV4: u16 = 0x0800;
pub const OPCODE_REQUEST: u16 = 1;
pub const OPCODE_REPLY: u16 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArpPacket {
    pub hw_type: u16,
    pub proto_type: u16,
    pub hw_len: u8,
    pub proto_len: u8,
    pub opcode: u16,
    pub sender_mac: [u8; 6],
    pub sender_ip: [u8; 4],
    pub target_mac: [u8; 6],
    pub target_ip: [u8; 4],
}

impl ArpPacket {
    pub fn parse(buf: &[u8]) -> Result<Self, ParseError> {
        let b = buf.get(..PACKET_LEN).ok_or(ParseError::Truncated)?;
        Ok(Self {
            hw_type: u16::from_be_bytes([b[0], b[1]]),
            proto_type: u16::from_be_bytes([b[2], b[3]]),
            hw_len: b[4],
            proto_len: b[5],
            opcode: u16::from_be_bytes([b[6], b[7]]),
            sender_mac: b[8..14].try_into().expect("exact"),
            sender_ip: b[14..18].try_into().expect("exact"),
            target_mac: b[18..24].try_into().expect("exact"),
            target_ip: b[24..28].try_into().expect("exact"),
        })
    }
    pub fn build(packet: &Self, out: &mut Vec<u8>) {
        out.extend_from_slice(&packet.hw_type.to_be_bytes());
        out.extend_from_slice(&packet.proto_type.to_be_bytes());
        out.push(packet.hw_len);
        out.push(packet.proto_len);
        out.extend_from_slice(&packet.opcode.to_be_bytes());
        out.extend_from_slice(&packet.sender_mac);
        out.extend_from_slice(&packet.sender_ip);
        out.extend_from_slice(&packet.target_mac);
        out.extend_from_slice(&packet.target_ip);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> ArpPacket {
        ArpPacket {
            hw_type: 1,
            proto_type: 0x0800,
            hw_len: 6,
            proto_len: 4,
            opcode: 1,
            sender_mac: [1, 2, 3, 4, 5, 6],
            sender_ip: [10, 42, 0, 11],
            target_mac: [0; 6],
            target_ip: [10, 42, 0, 20],
        }
    }
    #[test]
    fn round_trip() {
        let p = sample();
        let mut w = vec![];
        ArpPacket::build(&p, &mut w);
        assert_eq!(ArpPacket::parse(&w).unwrap(), p);
    }
    #[test]
    fn every_prefix_truncated() {
        let mut w = vec![];
        ArpPacket::build(&sample(), &mut w);
        for n in 0..PACKET_LEN {
            assert_eq!(ArpPacket::parse(&w[..n]), Err(ParseError::Truncated));
        }
    }
}
