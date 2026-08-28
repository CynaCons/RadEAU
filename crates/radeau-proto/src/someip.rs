//! SOME/IP header codec (SRS_protocols.md §3, SP-001..003).
//!
//! Message ID = Service ID + Method ID (high bit set for events); Length
//! covers Request ID through end of payload; Request ID = Client ID +
//! Session ID. All multi-byte fields big-endian. Bounded, panic-free.

use crate::ParseError;

/// Fixed SOME/IP header length on the wire.
pub const HEADER_LEN: usize = 16;
/// Bytes the Length field itself covers before the payload (Request ID
/// through Return Code).
pub const LENGTH_COVERED_HEADER: u32 = 8;

/// Message-type codes (SRS_protocols.md §3).
pub const MSG_REQUEST: u8 = 0x00;
pub const MSG_REQUEST_NO_RETURN: u8 = 0x01;
pub const MSG_NOTIFICATION: u8 = 0x02;
pub const MSG_RESPONSE: u8 = 0x80;
pub const MSG_ERROR: u8 = 0x81;

/// SOME/IP-SD fixed identity (classified by service/method, SRS §2).
pub const SD_SERVICE_ID: u16 = 0xFFFF;
pub const SD_METHOD_ID: u16 = 0x8100;

/// Parsed SOME/IP header, fields in wire order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SomeIpHeader {
    pub service_id: u16,
    pub method_id: u16,
    /// Covers Request ID through end of payload (validated against input).
    pub length: u32,
    pub client_id: u16,
    pub session_id: u16,
    pub protocol_version: u8,
    pub interface_version: u8,
    pub message_type: u8,
    pub return_code: u8,
}

impl SomeIpHeader {
    /// Payload length implied by the Length field.
    pub fn payload_len(&self) -> u32 {
        self.length.saturating_sub(LENGTH_COVERED_HEADER)
    }
}

/// Parse a SOME/IP message from a UDP payload. Returns the header and the
/// message payload slice. `Truncated` if the input ends before the header or
/// the payload extent; `Malformed` if Length is shorter than the covered
/// header fields.
pub fn parse(bytes: &[u8]) -> Result<(SomeIpHeader, &[u8]), ParseError> {
    if bytes.len() < HEADER_LEN {
        return Err(ParseError::Truncated);
    }
    let h = SomeIpHeader {
        service_id: u16::from_be_bytes([bytes[0], bytes[1]]),
        method_id: u16::from_be_bytes([bytes[2], bytes[3]]),
        length: u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
        client_id: u16::from_be_bytes([bytes[8], bytes[9]]),
        session_id: u16::from_be_bytes([bytes[10], bytes[11]]),
        protocol_version: bytes[12],
        interface_version: bytes[13],
        message_type: bytes[14],
        return_code: bytes[15],
    };
    if h.length < LENGTH_COVERED_HEADER {
        return Err(ParseError::Malformed);
    }
    let payload_len = (h.length - LENGTH_COVERED_HEADER) as usize;
    let end = HEADER_LEN
        .checked_add(payload_len)
        .ok_or(ParseError::Malformed)?;
    if bytes.len() < end {
        return Err(ParseError::Truncated);
    }
    Ok((h, &bytes[HEADER_LEN..end]))
}

/// Serialize header + payload. The header's `length` field is ignored and
/// recomputed from the payload, so callers can't emit an inconsistent frame.
pub fn build(h: &SomeIpHeader, payload: &[u8], out: &mut Vec<u8>) {
    let length = LENGTH_COVERED_HEADER + payload.len() as u32;
    out.extend_from_slice(&h.service_id.to_be_bytes());
    out.extend_from_slice(&h.method_id.to_be_bytes());
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(&h.client_id.to_be_bytes());
    out.extend_from_slice(&h.session_id.to_be_bytes());
    out.push(h.protocol_version);
    out.push(h.interface_version);
    out.push(h.message_type);
    out.push(h.return_code);
    out.extend_from_slice(payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> SomeIpHeader {
        SomeIpHeader {
            service_id: 0x1101,
            method_id: 0x8001,
            length: 0, // recomputed by build
            client_id: 0x0001,
            session_id: 0x002A,
            protocol_version: 0x01,
            interface_version: 0x01,
            message_type: MSG_NOTIFICATION,
            return_code: 0x00,
        }
    }

    #[test]
    fn round_trip() {
        let payload = [0xDE, 0xAD, 0xBE, 0xEF, 0x42];
        let mut wire = Vec::new();
        build(&header(), &payload, &mut wire);
        assert_eq!(wire.len(), HEADER_LEN + payload.len());
        let (h, p) = parse(&wire).unwrap();
        assert_eq!(h.service_id, 0x1101);
        assert_eq!(h.method_id, 0x8001);
        assert_eq!(h.length, LENGTH_COVERED_HEADER + 5);
        assert_eq!(h.session_id, 0x002A);
        assert_eq!(h.message_type, MSG_NOTIFICATION);
        assert_eq!(p, payload);
    }

    #[test]
    fn known_vector_byte_exact() {
        // 0x1101:0x8001, len 8+2, client 1, session 2, ver 1/1, notif, E_OK
        let mut wire = Vec::new();
        build(
            &SomeIpHeader {
                session_id: 2,
                ..header()
            },
            &[0xAA, 0xBB],
            &mut wire,
        );
        assert_eq!(
            wire,
            [
                0x11, 0x01, 0x80, 0x01, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x01, 0x00, 0x02, 0x01, 0x01,
                0x02, 0x00, 0xAA, 0xBB
            ]
        );
    }

    #[test]
    fn truncated_never_partial() {
        let mut wire = Vec::new();
        build(&header(), &[1, 2, 3, 4], &mut wire);
        for cut in 0..wire.len() {
            assert_eq!(parse(&wire[..cut]).unwrap_err(), ParseError::Truncated);
        }
    }

    #[test]
    fn malformed_length_rejected() {
        let mut wire = Vec::new();
        build(&header(), &[], &mut wire);
        wire[4..8].copy_from_slice(&3u32.to_be_bytes()); // < covered header
        assert_eq!(parse(&wire).unwrap_err(), ParseError::Malformed);
    }
}
