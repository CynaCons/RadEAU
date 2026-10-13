//! SOME/IP-SD payload codec (SRS_protocols.md §2, SRS_ecu_netsim.md SD-006).
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
pub const ENTRY_SUBSCRIBE_EVENTGROUP: u8 = 0x06;
pub const ENTRY_SUBSCRIBE_EVENTGROUP_ACK: u8 = 0x07;

/// One service/eventgroup SD entry. SD-006: TTL 0 on an Offer means StopOffer.
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
    const PREFIX_LEN: usize = 8;
    const ENTRY_LEN: usize = 16;
    let prefix = payload.get(..PREFIX_LEN).ok_or(ParseError::Truncated)?;
    let entries_len = u32::from_be_bytes(prefix[4..8].try_into().expect("exact slice")) as usize;
    if !entries_len.is_multiple_of(ENTRY_LEN) {
        return Err(ParseError::Malformed);
    }
    let entries_end = PREFIX_LEN
        .checked_add(entries_len)
        .ok_or(ParseError::Malformed)?;
    let options_len_end = entries_end.checked_add(4).ok_or(ParseError::Malformed)?;
    if payload.len() < options_len_end {
        return Err(ParseError::Truncated);
    }
    let options_len = u32::from_be_bytes(
        payload[entries_end..options_len_end]
            .try_into()
            .expect("exact slice"),
    ) as usize;
    let message_end = options_len_end
        .checked_add(options_len)
        .ok_or(ParseError::Malformed)?;
    if payload.len() < message_end {
        return Err(ParseError::Truncated);
    }

    let mut entries = Vec::with_capacity(entries_len / ENTRY_LEN);
    for entry in payload[PREFIX_LEN..entries_end].as_chunks::<ENTRY_LEN>().0 {
        if !matches!(
            entry[0],
            ENTRY_FIND_SERVICE
                | ENTRY_OFFER_SERVICE
                | ENTRY_SUBSCRIBE_EVENTGROUP
                | ENTRY_SUBSCRIBE_EVENTGROUP_ACK
        ) {
            return Err(ParseError::Malformed);
        }
        entries.push(SdEntry {
            entry_type: entry[0],
            service_id: u16::from_be_bytes([entry[4], entry[5]]),
            instance_id: u16::from_be_bytes([entry[6], entry[7]]),
            major_version: entry[8],
            ttl: u32::from_be_bytes([0, entry[9], entry[10], entry[11]]),
            minor_version: u32::from_be_bytes([entry[12], entry[13], entry[14], entry[15]]),
        });
    }
    Ok(SdMessage {
        flags: prefix[0],
        entries,
    })
}

/// Serialize an SD message as a SOME/IP payload (entries only, empty options
/// array). The result goes through `someip::build` with the SD identity.
pub fn build(msg: &SdMessage, out: &mut Vec<u8>) {
    build_entries(msg.flags, &msg.entries, out);
}

/// Serialize an SD message from a borrowed entry slice, avoiding a temporary
/// `Vec` for producers that already have a fixed set of entries.
pub fn build_entries(flags: u8, entries: &[SdEntry], out: &mut Vec<u8>) {
    out.push(flags);
    out.extend_from_slice(&[0, 0, 0]);
    out.extend_from_slice(&((entries.len() * 16) as u32).to_be_bytes());
    for entry in entries {
        out.push(entry.entry_type);
        out.extend_from_slice(&[0, 0, 0]); // option indices and option count
        out.extend_from_slice(&entry.service_id.to_be_bytes());
        out.extend_from_slice(&entry.instance_id.to_be_bytes());
        out.push(entry.major_version);
        let ttl = entry.ttl & 0x00ff_ffff;
        out.extend_from_slice(&[(ttl >> 16) as u8, (ttl >> 8) as u8, ttl as u8]);
        out.extend_from_slice(&entry.minor_version.to_be_bytes());
    }
    out.extend_from_slice(&0u32.to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SdMessage {
        SdMessage {
            flags: 0xc0,
            entries: vec![SdEntry {
                entry_type: ENTRY_OFFER_SERVICE,
                service_id: 0x1101,
                instance_id: 1,
                major_version: 1,
                ttl: 3,
                minor_version: 0,
            }],
        }
    }

    #[test]
    fn known_vector_byte_exact_sd_001() {
        // SD-006
        let mut wire = Vec::new();
        build(&sample(), &mut wire);
        assert_eq!(
            wire,
            [
                0xc0, 0, 0, 0, 0, 0, 0, 16, 1, 0, 0, 0, 0x11, 1, 0, 1, 1, 0, 0, 3, 0, 0, 0, 0, 0,
                0, 0, 0
            ]
        );
    }

    #[test]
    fn round_trip_sd_001() {
        // SD-006
        let mut wire = Vec::new();
        build(&sample(), &mut wire);
        assert_eq!(parse(&wire).unwrap(), sample());
    }

    #[test]
    fn stop_offer_and_flags_round_trip_sd_001() {
        // SD-006
        let msg = SdMessage {
            flags: 0x80,
            entries: vec![
                SdEntry {
                    entry_type: ENTRY_OFFER_SERVICE,
                    service_id: 0x1101,
                    instance_id: 1,
                    major_version: 1,
                    ttl: 0,
                    minor_version: 0,
                },
                SdEntry {
                    entry_type: ENTRY_SUBSCRIBE_EVENTGROUP_ACK,
                    service_id: 0x1101,
                    instance_id: 1,
                    major_version: 1,
                    ttl: 3,
                    minor_version: 0x8001,
                },
            ],
        };
        let mut wire = Vec::new();
        build(&msg, &mut wire);
        assert_eq!(parse(&wire).unwrap(), msg);
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
    fn malformed_lengths_rejected() {
        let mut wire = Vec::new();
        build(&sample(), &mut wire);
        wire[4..8].copy_from_slice(&15u32.to_be_bytes());
        assert_eq!(parse(&wire).unwrap_err(), ParseError::Malformed);
    }
}
