//! IPv4 packet: bounded parse of the fixed header + options, build with a
//! correct header checksum. Missing-not-partial on truncation.

use super::{internet_checksum, ParseError};

pub const MIN_HEADER_LEN: usize = 20;
/// Protocol number for UDP.
pub const PROTOCOL_UDP: u8 = 17;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ipv4Packet<'a> {
    pub dscp_ecn: u8,
    pub identification: u16,
    pub ttl: u8,
    pub protocol: u8,
    pub src: [u8; 4],
    pub dst: [u8; 4],
    /// Bytes after the header, cut to the IP total-length claim when the
    /// buffer carries more (Ethernet padding); may be empty.
    pub payload: &'a [u8],
}

impl<'a> Ipv4Packet<'a> {
    /// Parses an IPv4 packet. `Truncated` when fewer bytes than the declared
    /// header/total extent are present; `Malformed` on version != 4 or
    /// IHL < 5. The payload is sliced to `total_length` when the buffer holds
    /// trailing padding.
    pub fn parse(buf: &'a [u8]) -> Result<Self, ParseError> {
        let hdr = buf.get(..MIN_HEADER_LEN).ok_or(ParseError::Truncated)?;
        let version = hdr[0] >> 4;
        let ihl = (hdr[0] & 0x0f) as usize;
        if version != 4 || ihl < 5 {
            return Err(ParseError::Malformed);
        }
        let hdr_len = ihl * 4;
        if buf.len() < hdr_len {
            return Err(ParseError::Truncated);
        }
        let total_len = u16::from_be_bytes([hdr[2], hdr[3]]) as usize;
        if total_len < hdr_len {
            return Err(ParseError::Malformed);
        }
        if buf.len() < total_len {
            return Err(ParseError::Truncated);
        }
        let end = hdr_len.min(total_len) + (total_len - hdr_len);
        Ok(Self {
            dscp_ecn: hdr[1],
            identification: u16::from_be_bytes([hdr[4], hdr[5]]),
            ttl: hdr[8],
            protocol: hdr[9],
            src: hdr[12..16].try_into().expect("slice is exactly 4 bytes"),
            dst: hdr[16..20].try_into().expect("slice is exactly 4 bytes"),
            payload: &buf[hdr_len..end],
        })
    }

    /// Appends the wire encoding with a computed header checksum. Sets
    /// DF (do not fragment); no options; no fragmentation offset.
    #[allow(clippy::too_many_arguments)]
    pub fn build(
        src: [u8; 4],
        dst: [u8; 4],
        protocol: u8,
        identification: u16,
        ttl: u8,
        dscp_ecn: u8,
        payload: &[u8],
        out: &mut Vec<u8>,
    ) {
        let total_len = (MIN_HEADER_LEN + payload.len()) as u16;
        let start = out.len();
        out.push(0x40 | 5); // version 4, IHL 5
        out.push(dscp_ecn);
        out.extend_from_slice(&total_len.to_be_bytes());
        out.extend_from_slice(&identification.to_be_bytes());
        out.extend_from_slice(&0x4000u16.to_be_bytes()); // flags: DF
        out.push(ttl);
        out.push(protocol);
        out.extend_from_slice(&[0, 0]); // checksum placeholder
        out.extend_from_slice(&src);
        out.extend_from_slice(&dst);
        let hdr = &mut out[start..start + MIN_HEADER_LEN];
        let sum = internet_checksum(&[hdr]);
        hdr[10..12].copy_from_slice(&sum.to_be_bytes());
        out.extend_from_slice(payload);
    }

    pub fn encoded_len(payload_len: usize) -> usize {
        MIN_HEADER_LEN + payload_len
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<u8> {
        let mut v = Vec::new();
        Ipv4Packet::build(
            [10, 42, 0, 11],
            [10, 42, 0, 15],
            PROTOCOL_UDP,
            0x1234,
            64,
            0,
            &[1, 2, 3, 4, 5, 6, 7, 8],
            &mut v,
        );
        v
    }

    #[test]
    fn round_trip_byte_identical() {
        let wire = sample();
        let p = Ipv4Packet::parse(&wire).unwrap();
        assert_eq!(p.src, [10, 42, 0, 11]);
        assert_eq!(p.dst, [10, 42, 0, 15]);
        assert_eq!(p.protocol, PROTOCOL_UDP);
        assert_eq!(p.identification, 0x1234);
        assert_eq!(p.ttl, 64);
        assert_eq!(p.payload, &[1, 2, 3, 4, 5, 6, 7, 8]);
        let mut rebuilt = Vec::new();
        Ipv4Packet::build(
            p.src,
            p.dst,
            p.protocol,
            p.identification,
            p.ttl,
            p.dscp_ecn,
            p.payload,
            &mut rebuilt,
        );
        assert_eq!(rebuilt, wire);
    }

    #[test]
    fn checksum_is_valid() {
        let wire = sample();
        // Recompute over the received header with the checksum zeroed.
        let mut hdr = wire[..MIN_HEADER_LEN].to_vec();
        hdr[10..12].copy_from_slice(&[0, 0]);
        assert_eq!(
            internet_checksum(&[&hdr]),
            wire[10] as u16 * 256 + wire[11] as u16
        );
    }

    #[test]
    fn truncated_at_every_prefix_never_panics() {
        let wire = sample();
        for n in 0..wire.len() {
            // Either Truncated or Malformed is fine mid-header; never a panic.
            let _ = Ipv4Packet::parse(&wire[..n]);
        }
    }

    #[test]
    fn truncated_before_total_length_is_missing() {
        let mut wire = sample();
        wire.extend_from_slice(&[0xff; 32]); // Ethernet padding beyond total_len
        let p = Ipv4Packet::parse(&wire).unwrap();
        assert_eq!(p.payload.len(), 8);
        let cut = &wire[..wire.len() - 1];
        // Cutting into the padding still parses (payload unaffected).
        assert!(Ipv4Packet::parse(cut).is_ok());
        // Cutting below total_len is missing, not partial.
        let short = &wire[..MIN_HEADER_LEN + 7];
        assert_eq!(Ipv4Packet::parse(short).unwrap_err(), ParseError::Truncated);
    }

    #[test]
    fn malformed_version_and_ihl_rejected() {
        let mut wire = sample();
        wire[0] = 0x60 | 5; // version 6
        assert_eq!(Ipv4Packet::parse(&wire).unwrap_err(), ParseError::Malformed);
        wire[0] = 0x40 | 4; // IHL 4 < 5
        assert_eq!(Ipv4Packet::parse(&wire).unwrap_err(), ParseError::Malformed);
    }

    #[test]
    fn total_len_below_header_is_malformed() {
        let mut wire = sample();
        wire[2..4].copy_from_slice(&18u16.to_be_bytes()); // < 20-byte header
        assert_eq!(Ipv4Packet::parse(&wire).unwrap_err(), ParseError::Malformed);
    }
}
