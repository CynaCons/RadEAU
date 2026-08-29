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
        out.extend_from_slice(payload)
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
}
