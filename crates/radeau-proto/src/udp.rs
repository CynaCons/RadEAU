//! UDP datagram: 8-byte header + payload, with a real checksum computed
//! against the IPv4 pseudo-header. Missing-not-partial on truncation.

use super::{internet_checksum, ipv4, ParseError};

pub const HEADER_LEN: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UdpDatagram<'a> {
    pub src_port: u16,
    pub dst_port: u16,
    /// Bytes after the header; may be empty.
    pub payload: &'a [u8],
}

impl<'a> UdpDatagram<'a> {
    /// Parses a UDP datagram from the bytes following the IP header.
    /// `Truncated` when fewer than 8 bytes or fewer than the declared length;
    /// `Malformed` when the declared length is below the header size.
    pub fn parse(buf: &'a [u8]) -> Result<Self, ParseError> {
        let hdr = buf.get(..HEADER_LEN).ok_or(ParseError::Truncated)?;
        let length = u16::from_be_bytes([hdr[4], hdr[5]]) as usize;
        if length < HEADER_LEN {
            return Err(ParseError::Malformed);
        }
        if buf.len() < length {
            return Err(ParseError::Truncated);
        }
        Ok(Self {
            src_port: u16::from_be_bytes([hdr[0], hdr[1]]),
            dst_port: u16::from_be_bytes([hdr[2], hdr[3]]),
            payload: &buf[HEADER_LEN..length],
        })
    }

    /// Appends the wire encoding including a checksum computed over the IPv4
    /// pseudo-header (src/dst/protocol/udp-length) + datagram.
    pub fn build(
        src_ip: [u8; 4],
        dst_ip: [u8; 4],
        src_port: u16,
        dst_port: u16,
        payload: &[u8],
        out: &mut Vec<u8>,
    ) {
        let length = (HEADER_LEN + payload.len()) as u16;
        let mut hdr = Vec::with_capacity(HEADER_LEN);
        hdr.extend_from_slice(&src_port.to_be_bytes());
        hdr.extend_from_slice(&dst_port.to_be_bytes());
        hdr.extend_from_slice(&length.to_be_bytes());
        hdr.extend_from_slice(&[0, 0]); // checksum placeholder

        let mut pseudo = Vec::with_capacity(12);
        pseudo.extend_from_slice(&src_ip);
        pseudo.extend_from_slice(&dst_ip);
        pseudo.push(0);
        pseudo.push(ipv4::PROTOCOL_UDP);
        pseudo.extend_from_slice(&length.to_be_bytes());

        let sum = internet_checksum(&[&pseudo, &hdr, payload]);
        hdr[6..8].copy_from_slice(&sum.to_be_bytes());

        out.extend_from_slice(&hdr);
        out.extend_from_slice(payload);
    }

    pub fn encoded_len(payload_len: usize) -> usize {
        HEADER_LEN + payload_len
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC_IP: [u8; 4] = [10, 42, 0, 11];
    const DST_IP: [u8; 4] = [10, 42, 0, 15];

    fn sample() -> Vec<u8> {
        let mut v = Vec::new();
        UdpDatagram::build(SRC_IP, DST_IP, 30490, 50000, &[9, 8, 7, 6, 5], &mut v);
        v
    }

    #[test]
    fn round_trip_byte_identical() {
        let wire = sample();
        let d = UdpDatagram::parse(&wire).unwrap();
        assert_eq!(d.src_port, 30490);
        assert_eq!(d.dst_port, 50000);
        assert_eq!(d.payload, &[9, 8, 7, 6, 5]);
        let mut rebuilt = Vec::new();
        UdpDatagram::build(
            SRC_IP,
            DST_IP,
            d.src_port,
            d.dst_port,
            d.payload,
            &mut rebuilt,
        );
        assert_eq!(rebuilt, wire);
    }

    #[test]
    fn truncated_at_every_prefix_never_panics() {
        let wire = sample();
        for n in 0..wire.len() {
            let _ = UdpDatagram::parse(&wire[..n]);
        }
        for n in 0..HEADER_LEN {
            assert_eq!(
                UdpDatagram::parse(&wire[..n]).unwrap_err(),
                ParseError::Truncated,
                "prefix len {n}"
            );
        }
    }

    #[test]
    fn declared_length_below_header_is_malformed() {
        let mut wire = sample();
        wire[4..6].copy_from_slice(&4u16.to_be_bytes());
        assert_eq!(
            UdpDatagram::parse(&wire).unwrap_err(),
            ParseError::Malformed
        );
    }

    #[test]
    fn declared_length_beyond_buffer_is_truncated() {
        let wire = sample();
        let short = &wire[..wire.len() - 1];
        assert_eq!(
            UdpDatagram::parse(short).unwrap_err(),
            ParseError::Truncated
        );
    }

    #[test]
    fn empty_payload_is_valid() {
        let mut v = Vec::new();
        UdpDatagram::build(SRC_IP, DST_IP, 1, 2, &[], &mut v);
        let d = UdpDatagram::parse(&v).unwrap();
        assert!(d.payload.is_empty());
    }
}
