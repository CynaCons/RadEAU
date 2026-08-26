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

/// PTP message-type codes (low nibble of the first byte).
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
    // Implemented in this iteration (Codex-owned).
    let _ = l2_payload;
    Err(ParseError::Malformed)
}

/// Serialize a gPTP message as an Ethernet L2 payload.
pub fn build(msg: &GptpMessage, out: &mut Vec<u8>) {
    // Implemented in this iteration (Codex-owned).
    let _ = (msg, out);
    unimplemented!("gptp::build lands with the v0.1.3 codec wave");
}
