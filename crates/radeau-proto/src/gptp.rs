//! gPTP (IEEE 802.1AS) message codec — minimal v0.1.3 cut.
//!
//! gPTP rides directly on Ethernet (EtherType 0x88F7, multicast
//! 01:80:C2:00:00:0E). This cut decodes enough of the common PTP header for
//! classification and Trace display: message type, domain, sequence id,
//! correction, and the origin timestamp for Sync/FollowUp. Full offset/rate
//! math arrives with the PT- requirements (v0.4.2). Bounded, panic-free.
//!
//! CONTRACT (pinned): the signatures and types below are what the capture
//! reader and `ecu-netsim` compile against.

use crate::ParseError;

/// EtherType for gPTP frames.
pub const ETHERTYPE_GPTP: u16 = 0x88F7;
/// gPTP link-local multicast destination.
pub const GPTP_MULTICAST: [u8; 6] = [0x01, 0x80, 0xC2, 0x00, 0x00, 0x0E];

/// PTP message-type codes (low nibble of the first byte). PT-005.
pub const MSG_SYNC: u8 = 0x0;
pub const MSG_FOLLOW_UP: u8 = 0x8;
pub const MSG_PDELAY_REQ: u8 = 0x2;
pub const MSG_PDELAY_RESP: u8 = 0x3;
pub const MSG_ANNOUNCE: u8 = 0xB;

/// Common PTP header length on the wire.
pub const HEADER_LEN: usize = 34;

/// Minimal parsed gPTP message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GptpMessage {
    /// Low nibble of byte 0 (MSG_* above).
    pub msg_type: u8,
    pub domain: u8,
    pub sequence_id: u16,
    /// correctionField, nanoseconds (upper 48 bits of the 64-bit field).
    pub correction_ns: i64,
    /// originTimestamp / preciseOriginTimestamp in ns since epoch, for
    /// Sync / FollowUp bodies; None for header-only message types.
    pub origin_timestamp_ns: Option<u128>,
}

/// Parse a gPTP message from an Ethernet L2 payload (bytes after the 0x88F7
/// EtherType). `Truncated` for short input, `Malformed` for a bad transport
/// specific / version nibble.
pub fn parse(l2_payload: &[u8]) -> Result<GptpMessage, ParseError> {
    let header = l2_payload.get(..HEADER_LEN).ok_or(ParseError::Truncated)?;
    if header[0] >> 4 != 1 {
        return Err(ParseError::Malformed);
    }
    parse_any_transport(l2_payload)
}

/// Parse a PTP message regardless of the transportSpecific / majorSdoId
/// nibble: IEEE 1588 over UDP (ports 319/320) carries 0 where gPTP over
/// Ethernet carries 1. Only versionPTP == 2 is required.
pub fn parse_any_transport(l2_payload: &[u8]) -> Result<GptpMessage, ParseError> {
    let header = l2_payload.get(..HEADER_LEN).ok_or(ParseError::Truncated)?;
    if header[1] & 0x0f != 2 {
        return Err(ParseError::Malformed);
    }
    let msg_type = header[0] & 0x0f;
    let origin_timestamp_ns = if msg_type == MSG_SYNC || msg_type == MSG_FOLLOW_UP {
        let timestamp = l2_payload
            .get(HEADER_LEN..HEADER_LEN + 10)
            .ok_or(ParseError::Truncated)?;
        let seconds = u64::from_be_bytes([
            0,
            0,
            timestamp[0],
            timestamp[1],
            timestamp[2],
            timestamp[3],
            timestamp[4],
            timestamp[5],
        ]);
        let nanos = u32::from_be_bytes(timestamp[6..10].try_into().expect("exact slice"));
        Some(u128::from(seconds) * 1_000_000_000 + u128::from(nanos))
    } else {
        None
    };
    Ok(GptpMessage {
        msg_type,
        domain: header[4],
        sequence_id: u16::from_be_bytes([header[30], header[31]]),
        correction_ns: i64::from_be_bytes(header[8..16].try_into().expect("exact slice")) >> 16,
        origin_timestamp_ns,
    })
}

/// Serialize a gPTP message as an Ethernet L2 payload. PT-005.
pub fn build(msg: &GptpMessage, out: &mut Vec<u8>) {
    let has_timestamp = matches!(msg.msg_type, MSG_SYNC | MSG_FOLLOW_UP);
    out.push(0x10 | (msg.msg_type & 0x0f)); // 802.1AS transportSpecific = 1
    out.push(0x02); // PTP version 2
    out.extend_from_slice(&if has_timestamp { 44u16 } else { 34u16 }.to_be_bytes());
    out.push(msg.domain);
    out.push(0);
    out.extend_from_slice(&[0, 0]); // flagField
    out.extend_from_slice(&((msg.correction_ns.wrapping_shl(16)).to_be_bytes()));
    // Keep the pinned 34-byte common header's sequenceId at byte 30.
    out.extend_from_slice(&[0; 14]); // sourcePortIdentity / reserved extension
    out.extend_from_slice(&msg.sequence_id.to_be_bytes());
    out.push(0);
    out.push(0x7f);
    if has_timestamp {
        let ns = msg.origin_timestamp_ns.unwrap_or(0);
        let seconds = (ns / 1_000_000_000).min(0x0000_ffff_ffff_ffff) as u64;
        out.extend_from_slice(&seconds.to_be_bytes()[2..]);
        out.extend_from_slice(&((ns % 1_000_000_000) as u32).to_be_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> GptpMessage {
        GptpMessage {
            msg_type: MSG_SYNC,
            domain: 0,
            sequence_id: 0x1234,
            correction_ns: -2,
            origin_timestamp_ns: Some(5_000_000_007),
        }
    }
    #[test]
    fn known_vector_byte_exact_pt_001() {
        // PT-005
        let mut wire = Vec::new();
        build(&sample(), &mut wire);
        assert_eq!(&wire[..4], &[0x10, 2, 0, 44]);
        assert_eq!(&wire[8..16], &(-2i64 << 16).to_be_bytes());
        assert_eq!(&wire[30..32], &[0x12, 0x34]);
        assert_eq!(&wire[34..], &[0, 0, 0, 0, 0, 5, 0, 0, 0, 7]);
    }
    #[test]
    fn round_trip_pt_001() {
        // PT-005
        let mut wire = Vec::new();
        build(&sample(), &mut wire);
        assert_eq!(parse(&wire).unwrap(), sample());
    }
    #[test]
    fn header_only_message_types_round_trip_pt_001() {
        // PT-005
        for msg_type in [MSG_PDELAY_REQ, MSG_PDELAY_RESP, MSG_ANNOUNCE] {
            let msg = GptpMessage {
                msg_type,
                domain: 0,
                sequence_id: u16::from(msg_type),
                correction_ns: 17,
                origin_timestamp_ns: None,
            };
            let mut wire = Vec::new();
            build(&msg, &mut wire);
            assert_eq!(wire.len(), HEADER_LEN);
            assert_eq!(parse(&wire).unwrap(), msg);
        }
    }
    #[test]
    fn every_short_prefix_is_truncated() {
        let mut wire = Vec::new();
        build(&sample(), &mut wire);
        for n in 0..wire.len() {
            assert_eq!(parse(&wire[..n]).unwrap_err(), ParseError::Truncated);
        }
    }
    #[test]
    fn malformed_version_rejected() {
        let mut wire = Vec::new();
        build(&sample(), &mut wire);
        wire[1] = 3;
        assert_eq!(parse(&wire).unwrap_err(), ParseError::Malformed);
    }
}
