//! Ethernet II framing: 14-byte header (dst, src, EtherType) + payload.
//! Bounded parse, missing-not-partial on truncation.

use super::ParseError;

pub const HEADER_LEN: usize = 14;

/// EtherType for IPv4.
pub const ETHERTYPE_IPV4: u16 = 0x0800;
/// EtherType for gPTP (IEEE 802.1AS) transport directly over Ethernet.
pub const ETHERTYPE_GPTP: u16 = 0x88f7;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EthernetFrame<'a> {
    pub dst: [u8; 6],
    pub src: [u8; 6],
    pub ethertype: u16,
    /// Remaining bytes after the header; never interpreted here.
    pub payload: &'a [u8],
}

impl<'a> EthernetFrame<'a> {
    /// Parses an Ethernet II frame. Fails with `Truncated` if fewer than 14
    /// bytes are present; the payload is whatever follows and may be empty.
    pub fn parse(buf: &'a [u8]) -> Result<Self, ParseError> {
        let hdr = buf.get(..HEADER_LEN).ok_or(ParseError::Truncated)?;
        Ok(Self {
            dst: hdr[0..6].try_into().expect("slice is exactly 6 bytes"),
            src: hdr[6..12].try_into().expect("slice is exactly 6 bytes"),
            ethertype: u16::from_be_bytes([hdr[12], hdr[13]]),
            payload: &buf[HEADER_LEN..],
        })
    }

    /// Appends the wire encoding to `out` (big-endian fields).
    pub fn build(dst: [u8; 6], src: [u8; 6], ethertype: u16, payload: &[u8], out: &mut Vec<u8>) {
        out.extend_from_slice(&dst);
        out.extend_from_slice(&src);
        out.extend_from_slice(&ethertype.to_be_bytes());
        out.extend_from_slice(payload);
    }

    pub fn encoded_len(payload_len: usize) -> usize {
        HEADER_LEN + payload_len
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<u8> {
        let mut v = Vec::new();
        EthernetFrame::build(
            [1, 2, 3, 4, 5, 6],
            [0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f],
            ETHERTYPE_IPV4,
            &[0xde, 0xad, 0xbe, 0xef],
            &mut v,
        );
        v
    }

    #[test]
    fn round_trip_byte_identical() {
        let wire = sample();
        let f = EthernetFrame::parse(&wire).unwrap();
        assert_eq!(f.dst, [1, 2, 3, 4, 5, 6]);
        assert_eq!(f.src, [0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f]);
        assert_eq!(f.ethertype, ETHERTYPE_IPV4);
        assert_eq!(f.payload, &[0xde, 0xad, 0xbe, 0xef]);
        let mut rebuilt = Vec::new();
        EthernetFrame::build(f.dst, f.src, f.ethertype, f.payload, &mut rebuilt);
        assert_eq!(rebuilt, wire);
    }

    #[test]
    fn truncated_at_every_prefix_is_missing_not_partial() {
        let wire = sample();
        for n in 0..HEADER_LEN {
            assert_eq!(
                EthernetFrame::parse(&wire[..n]).unwrap_err(),
                ParseError::Truncated,
                "prefix len {n}"
            );
        }
    }

    #[test]
    fn empty_payload_is_valid() {
        let mut v = Vec::new();
        EthernetFrame::build([0; 6], [0; 6], ETHERTYPE_GPTP, &[], &mut v);
        let f = EthernetFrame::parse(&v).unwrap();
        assert!(f.payload.is_empty());
        assert_eq!(f.ethertype, ETHERTYPE_GPTP);
    }
}
