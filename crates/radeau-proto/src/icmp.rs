//! ICMP/ICMPv6 common eight-byte header codec.
use crate::ParseError;
pub const HEADER_LEN: usize = 8;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IcmpPacket<'a> {
    pub icmp_type: u8,
    pub code: u8,
    pub checksum: u16,
    pub rest_of_header: [u8; 4],
    pub payload: &'a [u8],
}
impl<'a> IcmpPacket<'a> {
    pub fn parse(buf: &'a [u8]) -> Result<Self, ParseError> {
        let h = buf.get(..8).ok_or(ParseError::Truncated)?;
        Ok(Self {
            icmp_type: h[0],
            code: h[1],
            checksum: u16::from_be_bytes([h[2], h[3]]),
            rest_of_header: h[4..8].try_into().expect("exact"),
            payload: &buf[8..],
        })
    }
    pub fn build(
        icmp_type: u8,
        code: u8,
        checksum: u16,
        rest: [u8; 4],
        payload: &[u8],
        out: &mut Vec<u8>,
    ) {
        out.push(icmp_type);
        out.push(code);
        out.extend_from_slice(&checksum.to_be_bytes());
        out.extend_from_slice(&rest);
        out.extend_from_slice(payload);
    }
}

pub fn type_name(t: u8) -> &'static str {
    match t {
        0 => "Echo Reply",
        3 => "Destination Unreachable",
        4 => "Source Quench",
        5 => "Redirect",
        8 => "Echo Request",
        9 => "Router Advertisement",
        10 => "Router Solicitation",
        11 => "Time Exceeded",
        12 => "Parameter Problem",
        13 => "Timestamp",
        14 => "Timestamp Reply",
        _ => "type n",
    }
}

pub fn code_name(t: u8, code: u8) -> Option<&'static str> {
    match (t, code) {
        (3, 0) => Some("Net Unreachable"),
        (3, 1) => Some("Host Unreachable"),
        (3, 2) => Some("Protocol Unreachable"),
        (3, 3) => Some("Port Unreachable"),
        (3, 4) => Some("Fragmentation Needed"),
        (3, 5) => Some("Source Route Failed"),
        (3, 6) => Some("Destination Network Unknown"),
        (3, 7) => Some("Destination Host Unknown"),
        (3, 9) => Some("Network Administratively Prohibited"),
        (3, 10) => Some("Host Administratively Prohibited"),
        (3, 11) => Some("Network Unreachable for ToS"),
        (3, 12) => Some("Host Unreachable for ToS"),
        (3, 13) => Some("Communication Administratively Prohibited"),
        (3, 14) => Some("Host Precedence Violation"),
        (3, 15) => Some("Precedence Cutoff"),
        (5, 0) => Some("Redirect Datagram for Network"),
        (5, 1) => Some("Redirect Datagram for Host"),
        (5, 2) => Some("Redirect Datagram for ToS and Network"),
        (5, 3) => Some("Redirect Datagram for ToS and Host"),
        (11, 0) => Some("TTL Exceeded"),
        (11, 1) => Some("Fragment Reassembly Time Exceeded"),
        (12, 0) => Some("Pointer Indicates Error"),
        (12, 1) => Some("Missing Required Option"),
        (12, 2) => Some("Bad Length"),
        _ => None,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_and_prefixes() {
        let mut w = vec![];
        IcmpPacket::build(8, 0, 0x1234, [1, 2, 3, 4], &[5], &mut w);
        let p = IcmpPacket::parse(&w).unwrap();
        assert_eq!(p.payload, &[5]);
        for n in 0..8 {
            assert_eq!(IcmpPacket::parse(&w[..n]), Err(ParseError::Truncated));
        }
    }

    #[test]
    fn names_known_types_and_codes() {
        assert_eq!(type_name(8), "Echo Request");
        assert_eq!(type_name(255), "type n");
        assert_eq!(code_name(3, 4), Some("Fragmentation Needed"));
        assert_eq!(code_name(3, 2), Some("Protocol Unreachable"));
        assert_eq!(code_name(3, 99), None);
    }

    #[test]
    fn random_prefixes_never_panic() {
        let mut seed = 0x1020_3040u32;
        for len in 0..128 {
            let mut bytes = vec![0; len];
            for byte in &mut bytes {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *byte = seed as u8;
            }
            let _ = IcmpPacket::parse(&bytes);
        }
    }
}
