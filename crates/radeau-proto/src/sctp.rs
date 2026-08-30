//! Stream Control Transmission Protocol common header and chunk walker.

use crate::ParseError;

pub const HEADER_LEN: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SctpData {
    pub unordered: bool,
    pub beginning: bool,
    pub ending: bool,
    pub immediate: bool,
    pub tsn: u32,
    pub stream_identifier: u16,
    pub stream_sequence: u16,
    pub payload_protocol_identifier: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SctpChunk {
    pub chunk_type: u8,
    pub flags: u8,
    pub length: u16,
    pub offset: usize,
    pub data: Option<SctpData>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SctpPacket {
    pub source_port: u16,
    pub destination_port: u16,
    pub verification_tag: u32,
    pub checksum: u32,
    pub chunks: Vec<SctpChunk>,
}

impl SctpPacket {
    pub fn parse(buf: &[u8]) -> Result<Self, ParseError> {
        let h = buf.get(..HEADER_LEN).ok_or(ParseError::Truncated)?;
        let mut chunks = Vec::new();
        let mut offset = HEADER_LEN;
        while offset < buf.len() {
            let prefix = buf
                .get(offset..offset.saturating_add(4))
                .ok_or(ParseError::Truncated)?;
            let length = u16::from_be_bytes([prefix[2], prefix[3]]);
            if length < 4 {
                return Err(ParseError::Malformed);
            }
            let end = offset
                .checked_add(length as usize)
                .ok_or(ParseError::Malformed)?;
            let bytes = buf.get(offset..end).ok_or(ParseError::Truncated)?;
            let data = if prefix[0] == 0 {
                if length < 16 {
                    return Err(ParseError::Malformed);
                }
                let d = bytes.get(4..16).ok_or(ParseError::Truncated)?;
                Some(SctpData {
                    unordered: prefix[1] & 0x04 != 0,
                    beginning: prefix[1] & 0x02 != 0,
                    ending: prefix[1] & 0x01 != 0,
                    immediate: prefix[1] & 0x08 != 0,
                    tsn: u32::from_be_bytes(d[0..4].try_into().expect("exact")),
                    stream_identifier: u16::from_be_bytes(d[4..6].try_into().expect("exact")),
                    stream_sequence: u16::from_be_bytes(d[6..8].try_into().expect("exact")),
                    payload_protocol_identifier: u32::from_be_bytes(
                        d[8..12].try_into().expect("exact"),
                    ),
                })
            } else {
                None
            };
            chunks.push(SctpChunk {
                chunk_type: prefix[0],
                flags: prefix[1],
                length,
                offset,
                data,
            });
            let padded = (length as usize)
                .checked_add(3)
                .ok_or(ParseError::Malformed)?
                & !3;
            let next = offset.checked_add(padded).ok_or(ParseError::Malformed)?;
            if next > buf.len() {
                // Padding is required between chunks, but may be omitted after
                // the final chunk because it is not part of the chunk length.
                if end == buf.len() {
                    offset = end;
                } else {
                    return Err(ParseError::Truncated);
                }
            } else {
                offset = next;
            }
        }
        Ok(Self {
            source_port: u16::from_be_bytes([h[0], h[1]]),
            destination_port: u16::from_be_bytes([h[2], h[3]]),
            verification_tag: u32::from_be_bytes(h[4..8].try_into().expect("exact")),
            checksum: u32::from_be_bytes(h[8..12].try_into().expect("exact")),
            chunks,
        })
    }
}

pub fn chunk_name(chunk_type: u8) -> &'static str {
    match chunk_type {
        0 => "DATA",
        1 => "INIT",
        2 => "INIT ACK",
        3 => "SACK",
        4 => "HEARTBEAT",
        5 => "HEARTBEAT ACK",
        6 => "ABORT",
        7 => "SHUTDOWN",
        8 => "SHUTDOWN ACK",
        9 => "ERROR",
        10 => "COOKIE ECHO",
        11 => "COOKIE ACK",
        14 => "SHUTDOWN COMPLETE",
        15 => "AUTH",
        64 => "I-DATA",
        130 => "RE-CONFIG",
        192 => "FORWARD TSN",
        _ => "chunk n",
    }
}

pub fn build(
    source_port: u16,
    destination_port: u16,
    verification_tag: u32,
    checksum: u32,
    chunks: &[u8],
    out: &mut Vec<u8>,
) {
    out.extend_from_slice(&source_port.to_be_bytes());
    out.extend_from_slice(&destination_port.to_be_bytes());
    out.extend_from_slice(&verification_tag.to_be_bytes());
    out.extend_from_slice(&checksum.to_be_bytes());
    out.extend_from_slice(chunks);
}

#[allow(clippy::too_many_arguments)]
pub fn build_data_chunk(
    flags: u8,
    tsn: u32,
    stream_identifier: u16,
    stream_sequence: u16,
    payload_protocol_identifier: u32,
    user_data: &[u8],
    out: &mut Vec<u8>,
) {
    let length = 16usize + user_data.len();
    out.extend_from_slice(&[0, flags]);
    out.extend_from_slice(&(length as u16).to_be_bytes());
    out.extend_from_slice(&tsn.to_be_bytes());
    out.extend_from_slice(&stream_identifier.to_be_bytes());
    out.extend_from_slice(&stream_sequence.to_be_bytes());
    out.extend_from_slice(&payload_protocol_identifier.to_be_bytes());
    out.extend_from_slice(user_data);
    out.resize(out.len() + (4 - length % 4) % 4, 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_and_init_chunks_are_byte_exact() {
        let mut chunks = Vec::new();
        build_data_chunk(0x07, 0x0102_0304, 5, 6, 0x1122_3344, &[0xaa], &mut chunks);
        chunks.extend_from_slice(&[1, 0, 0, 20]);
        chunks.extend_from_slice(&[0; 16]);
        let mut wire = Vec::new();
        build(5000, 5001, 0xaabb_ccdd, 0x1234_5678, &chunks, &mut wire);
        assert_eq!(
            &wire[..32],
            &[
                0x13, 0x88, 0x13, 0x89, 0xaa, 0xbb, 0xcc, 0xdd, 0x12, 0x34, 0x56, 0x78, 0, 7, 0,
                17, 1, 2, 3, 4, 0, 5, 0, 6, 0x11, 0x22, 0x33, 0x44, 0xaa, 0, 0, 0
            ]
        );
        let packet = SctpPacket::parse(&wire).unwrap();
        assert_eq!(packet.source_port, 5000);
        assert_eq!(packet.destination_port, 5001);
        assert_eq!(packet.checksum, 0x1234_5678);
        assert_eq!(packet.chunks.len(), 2);
        assert_eq!(packet.chunks[0].offset, 12);
        let data = packet.chunks[0].data.unwrap();
        assert_eq!(data.tsn, 0x0102_0304);
        assert!(data.unordered && data.beginning && data.ending && !data.immediate);
        assert_eq!(packet.chunks[1].chunk_type, 1);
    }

    #[test]
    fn truncation_at_every_prefix_and_random_bytes_never_panic() {
        let mut chunks = Vec::new();
        build_data_chunk(3, 1, 2, 3, 4, &[5, 6, 7, 8], &mut chunks);
        let mut wire = Vec::new();
        build(1, 2, 3, 4, &chunks, &mut wire);
        for n in 0..wire.len() {
            let parsed = SctpPacket::parse(&wire[..n]);
            if n < HEADER_LEN {
                assert_eq!(parsed, Err(ParseError::Truncated));
            }
        }
        let mut bad = wire[..12].to_vec();
        bad.extend_from_slice(&[1, 0, 0, 3]);
        assert_eq!(SctpPacket::parse(&bad), Err(ParseError::Malformed));
        let mut seed = 0x9e37_79b9u32;
        for len in 0..160 {
            let mut bytes = vec![0; len];
            for byte in &mut bytes {
                seed = seed.rotate_left(7).wrapping_add(0x6d2b_79f5);
                *byte = seed as u8;
            }
            let _ = SctpPacket::parse(&bytes);
        }
        assert_eq!(chunk_name(1), "INIT");
        assert_eq!(chunk_name(255), "chunk n");
    }
}
