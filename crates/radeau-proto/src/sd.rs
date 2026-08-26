//! SOME/IP-SD payload codec (SRS_protocols.md §2, SRS_ecu_netsim.md SD-001..004).
//!
//! Minimal v0.1.3 cut: the SD message frame (flags + entries array) with
//! type-1 service entries (OfferService / StopOffer via TTL 0). Options are
//! length-skipped, not decoded — endpoint options arrive with the service
//! catalog work (v0.5). Bounded, panic-free; wire layout is the standard
//! AUTOSAR SD encoding, all fields big-endian.
//!
//! CONTRACT (pinned): the signatures and types below are what the capture
//! reader and `ecu-netsim` compile against. Implementations may grow, the
//! shapes may not shrink.

use crate::ParseError;

/// Entry type codes (service entry family).
pub const ENTRY_FIND_SERVICE: u8 = 0x00;
pub const ENTRY_OFFER_SERVICE: u8 = 0x01;

/// One type-1 (service) SD entry. TTL 0 on an Offer means StopOffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SdEntry {
    pub entry_type: u8,
    pub service_id: u16,
    pub instance_id: u16,
    pub major_version: u8,
    /// 24-bit on the wire.
    pub ttl: u32,
    pub minor_version: u32,
}

/// Parsed SD message: flags byte plus the service entries, options skipped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdMessage {
    /// Flags byte (bit 7 reboot, bit 6 unicast).
    pub flags: u8,
    pub entries: Vec<SdEntry>,
}

/// Parse an SD message from a SOME/IP payload (the bytes `someip::parse`
/// returns for service 0xFFFF / method 0x8100).
pub fn parse(payload: &[u8]) -> Result<SdMessage, ParseError> {
    // Implemented in this iteration (Codex-owned): flags u8 + reserved[3] +
    // entries-length u32 + 16-byte entries + options-length u32 + skipped
    // options. Truncated for short input, Malformed for inconsistent lengths.
    let _ = payload;
    Err(ParseError::Malformed)
}

/// Serialize an SD message as a SOME/IP payload (entries only, empty options
/// array). The result goes through `someip::build` with the SD identity.
pub fn build(msg: &SdMessage, out: &mut Vec<u8>) {
    // Implemented in this iteration (Codex-owned).
    let _ = (msg, out);
    unimplemented!("sd::build lands with the v0.1.3 codec wave");
}
