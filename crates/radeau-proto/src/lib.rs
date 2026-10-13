//! Shared protocol codecs for RadEAU and `ecu-netsim`.
//!
//! One codec, tested once (decision D9): Ethernet II / 802.1Q / IPv4 / UDP
//! framing, the SOME/IP header, SOME/IP-SD payloads, and gPTP messages, all
//! specified in `docs/SRS_protocols.md`. This commit lands the framing layer
//! (Ethernet II / IPv4 / UDP build + bounded parse); SOME/IP, SD, and gPTP
//! codecs remain planned for v0.3.0.
//!
//! Codec rules (normative): bounded, panic-free on malformed input; all
//! multi-byte wire fields big-endian; an input shorter than a field's extent
//! yields *missing* (`ParseError::Truncated`), never a partial value.

pub mod arp;
pub mod doip;
pub mod ethernet;
pub mod gptp;
pub mod icmp;
pub mod igmp;
pub mod ipv4;
pub mod ipv6;
pub mod sd;
pub mod someip;
pub mod udp;

pub const CRATE_NAME: &str = "radeau-proto";

/// Codec failure modes. Every parse entry point returns this instead of
/// panicking; `Truncated` covers all short-input cases (missing, not partial).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    /// The input ends before a required field's extent is fully present.
    Truncated,
    /// The input is complete but violates the format (bad version, impossible
    /// lengths, reserved values).
    Malformed,
}

/// Internet checksum (RFC 1071) over one or more byte slices, treating each
/// slice independently for odd-length padding. Big-endian sum, folded.
pub fn internet_checksum(parts: &[&[u8]]) -> u16 {
    let mut sum = 0u32;
    for part in parts {
        let mut chunks = part.chunks_exact(2);
        for c in &mut chunks {
            sum += u32::from(u16::from_be_bytes([c[0], c[1]]));
        }
        let rem = chunks.remainder();
        if !rem.is_empty() {
            sum += u32::from(rem[0]) << 8;
        }
    }
    while sum > 0xffff {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_known_vector() {
        // RFC 1071 example: 00 01 f2 03 f4 f5 f6 f7 -> 22 0d
        let data = [0x00u8, 0x01, 0xf2, 0x03, 0xf4, 0xf5, 0xf6, 0xf7];
        assert_eq!(internet_checksum(&[&data]), 0x220d);
    }

    #[test]
    fn checksum_odd_length_pads_zero() {
        let even = [0x00u8, 0x01, 0xf2, 0x03];
        let odd = [0x00u8, 0x01, 0xf2, 0x03, 0xf4];
        let with_pad = [0x00u8, 0x01, 0xf2, 0x03, 0xf4, 0x00];
        assert_eq!(internet_checksum(&[&odd]), internet_checksum(&[&with_pad]));
        let _ = even;
    }

    #[test]
    fn checksum_split_parts_equals_joined() {
        // Parts must be even-length except the last (odd tail pads zero).
        let joined = [0x11u8, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77];
        assert_eq!(
            internet_checksum(&[&joined[..4], &joined[4..]]),
            internet_checksum(&[&joined])
        );
    }

    #[test]
    fn workspace_wiring() {
        assert_eq!(super::CRATE_NAME, "radeau-proto");
    }
}
pub mod avtp;
pub mod dhcp;
pub mod dns;
pub mod eapol;
pub mod http;
pub mod icmpv6;
pub mod lldp;
pub mod macsec;
pub mod ntp;
pub mod sctp;
pub mod snmp;
pub mod ssdp;
pub mod ssh;
pub mod tcp;
pub mod tftp;
pub mod tls;
