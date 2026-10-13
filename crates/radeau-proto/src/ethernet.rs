//! Ethernet II framing: 14-byte header (dst, src, EtherType) + payload.
//! Bounded parse, missing-not-partial on truncation.

use super::ParseError;

pub const HEADER_LEN: usize = 14;

/// EtherType for IPv4.
pub const ETHERTYPE_IPV4: u16 = 0x0800;
pub const ETHERTYPE_ARP: u16 = 0x0806;
pub const ETHERTYPE_VLAN: u16 = 0x8100;
pub const ETHERTYPE_QINQ: u16 = 0x88a8;
pub const ETHERTYPE_IPV6: u16 = 0x86dd;
/// EtherType for gPTP (IEEE 802.1AS) transport directly over Ethernet.
pub const ETHERTYPE_GPTP: u16 = 0x88f7;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VlanTag {
    pub pcp: u8,
    pub dei: bool,
    pub vid: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EthernetFrame<'a> {
    pub dst: [u8; 6],
    pub src: [u8; 6],
    /// The outer tag when one or two VLAN tags are present.
    pub vlan: Option<VlanTag>,
    /// Complete Ethernet header length, including peeled VLAN tags.
    pub header_len: usize,
    pub ethertype: u16,
    /// Remaining bytes after the header; never interpreted here.
    pub payload: &'a [u8],
}

impl<'a> EthernetFrame<'a> {
    /// Parses an Ethernet II frame. Fails with `Truncated` if fewer than 14
    /// bytes are present; the payload is whatever follows and may be empty.
    pub fn parse(buf: &'a [u8]) -> Result<Self, ParseError> {
        let hdr = buf.get(..HEADER_LEN).ok_or(ParseError::Truncated)?;
        let mut ethertype = u16::from_be_bytes([hdr[12], hdr[13]]);
        let mut header_len = HEADER_LEN;
        let mut vlan = None;
        // SP-007: peel one or two 802.1Q / 802.1ad tags while retaining the outer VLAN.
        for _ in 0..2 {
            if !matches!(ethertype, ETHERTYPE_VLAN | ETHERTYPE_QINQ) {
                break;
            }
            let tag = buf
                .get(header_len..header_len + 4)
                .ok_or(ParseError::Truncated)?;
            let tci = u16::from_be_bytes([tag[0], tag[1]]);
            vlan.get_or_insert(VlanTag {
                pcp: ((tci >> 13) & 7) as u8,
                dei: tci & 0x1000 != 0,
                vid: tci & 0x0fff,
            });
            ethertype = u16::from_be_bytes([tag[2], tag[3]]);
            header_len += 4;
        }
        Ok(Self {
            dst: hdr[0..6].try_into().expect("slice is exactly 6 bytes"),
            src: hdr[6..12].try_into().expect("slice is exactly 6 bytes"),
            vlan,
            header_len,
            ethertype,
            payload: &buf[header_len..],
        })
    }

    pub fn build_tagged(
        dst: [u8; 6],
        src: [u8; 6],
        tag: VlanTag,
        ethertype: u16,
        payload: &[u8],
        out: &mut Vec<u8>,
    ) {
        out.extend_from_slice(&dst);
        out.extend_from_slice(&src);
        out.extend_from_slice(&ETHERTYPE_VLAN.to_be_bytes());
        let tci =
            ((u16::from(tag.pcp) & 7) << 13) | (u16::from(tag.dei) << 12) | (tag.vid & 0x0fff);
        out.extend_from_slice(&tci.to_be_bytes());
        out.extend_from_slice(&ethertype.to_be_bytes());
        out.extend_from_slice(payload);
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
        assert_eq!(f.vlan, None);
        assert_eq!(f.header_len, 14);
        assert_eq!(f.payload, &[0xde, 0xad, 0xbe, 0xef]);
        let mut rebuilt = Vec::new();
        EthernetFrame::build(f.dst, f.src, f.ethertype, f.payload, &mut rebuilt);
        assert_eq!(rebuilt, wire);
    }

    #[test]
    fn tagged_round_trip_and_truncation() {
        let tag = VlanTag {
            pcp: 5,
            dei: true,
            vid: 10,
        };
        let mut wire = Vec::new();
        EthernetFrame::build_tagged([1; 6], [2; 6], tag, ETHERTYPE_IPV4, &[9, 8], &mut wire);
        let frame = EthernetFrame::parse(&wire).unwrap();
        assert_eq!(frame.vlan, Some(tag));
        assert_eq!(frame.header_len, 18);
        assert_eq!(frame.ethertype, ETHERTYPE_IPV4);
        assert_eq!(frame.payload, &[9, 8]);
        for n in HEADER_LEN..18 {
            assert_eq!(
                EthernetFrame::parse(&wire[..n]).unwrap_err(),
                ParseError::Truncated
            );
        }
    }

    #[test]
    fn peels_two_tags_and_keeps_outer_sp_007() {
        // SP-007
        let mut wire = vec![0; 12];
        wire.extend_from_slice(&ETHERTYPE_QINQ.to_be_bytes());
        wire.extend_from_slice(&10u16.to_be_bytes());
        wire.extend_from_slice(&ETHERTYPE_VLAN.to_be_bytes());
        wire.extend_from_slice(&20u16.to_be_bytes());
        wire.extend_from_slice(&ETHERTYPE_ARP.to_be_bytes());
        wire.push(7);
        let frame = EthernetFrame::parse(&wire).unwrap();
        assert_eq!(frame.vlan.unwrap().vid, 10);
        assert_eq!(frame.header_len, 22);
        assert_eq!(frame.ethertype, ETHERTYPE_ARP);
        assert_eq!(frame.payload, &[7]);
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
