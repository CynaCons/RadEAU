//! IPv6 fixed-header codec with payload-length bounds.
use crate::ParseError;
pub const HEADER_LEN: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ipv6Packet<'a> {
    pub payload_length: u16,
    pub next_header: u8,
    pub hop_limit: u8,
    pub src: [u8; 16],
    pub dst: [u8; 16],
    pub payload: &'a [u8],
}
impl<'a> Ipv6Packet<'a> {
    pub fn parse(buf: &'a [u8]) -> Result<Self, ParseError> {
        let h = buf.get(..HEADER_LEN).ok_or(ParseError::Truncated)?;
        if h[0] >> 4 != 6 {
            return Err(ParseError::Malformed);
        }
        let n = u16::from_be_bytes([h[4], h[5]]) as usize;
        let end = HEADER_LEN.checked_add(n).ok_or(ParseError::Malformed)?;
        if buf.len() < end {
            return Err(ParseError::Truncated);
        }
        Ok(Self {
            payload_length: n as u16,
            next_header: h[6],
            hop_limit: h[7],
            src: h[8..24].try_into().expect("exact"),
            dst: h[24..40].try_into().expect("exact"),
            payload: &buf[40..end],
        })
    }
    pub fn build(
        src: [u8; 16],
        dst: [u8; 16],
        next_header: u8,
        hop_limit: u8,
        payload: &[u8],
        out: &mut Vec<u8>,
    ) {
        out.extend_from_slice(&0x60000000u32.to_be_bytes());
        out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        out.push(next_header);
        out.push(hop_limit);
        out.extend_from_slice(&src);
        out.extend_from_slice(&dst);
        out.extend_from_slice(payload);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_and_prefixes() {
        let mut w = vec![];
        Ipv6Packet::build([1; 16], [2; 16], 58, 64, &[3, 4], &mut w);
        let p = Ipv6Packet::parse(&w).unwrap();
        assert_eq!(p.payload, &[3, 4]);
        for n in 0..w.len() {
            assert_eq!(
                Ipv6Packet::parse(&w[..n]).unwrap_err(),
                ParseError::Truncated
            )
        }
    }
    #[test]
    fn bad_version() {
        let mut w = vec![0; 40];
        assert_eq!(Ipv6Packet::parse(&w), Err(ParseError::Malformed));
        w[0] = 0x60;
        assert!(Ipv6Packet::parse(&w).is_ok())
    }
}
