//! Bounded IEEE 802.1AE MACsec SecTAG decoder.
use crate::ParseError;

pub const ETHERTYPE: u16 = 0x88E5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecTag {
    pub version_bit: bool,
    pub es: bool,
    pub sc: bool,
    pub scb: bool,
    pub encrypted: bool,
    pub changed_text: bool,
    pub association_number: u8,
    pub short_length: u8,
    pub packet_number: u32,
    pub sci: Option<u64>,
    pub header_len: usize,
}

pub fn parse(buf: &[u8]) -> Result<SecTag, ParseError> {
    let header = buf.get(..6).ok_or(ParseError::Truncated)?;
    let tci = header[0];
    let sc = tci & 0x20 != 0;
    let (sci, header_len) = if sc {
        let bytes: [u8; 8] = buf
            .get(6..14)
            .ok_or(ParseError::Truncated)?
            .try_into()
            .expect("exact");
        (Some(u64::from_be_bytes(bytes)), 14)
    } else {
        (None, 6)
    };
    Ok(SecTag {
        version_bit: tci & 0x80 != 0,
        es: tci & 0x40 != 0,
        sc,
        scb: tci & 0x10 != 0,
        encrypted: tci & 0x08 != 0,
        changed_text: tci & 0x04 != 0,
        association_number: tci & 0x03,
        short_length: header[1] & 0x3f,
        packet_number: u32::from_be_bytes([header[2], header[3], header[4], header[5]]),
        sci,
        header_len,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vector_and_prefixes() {
        let bytes = [0x2e, 0x12, 0, 0, 0, 7, 1, 2, 3, 4, 5, 6, 0, 9];
        let tag = parse(&bytes).unwrap();
        assert!(tag.sc && tag.encrypted && tag.changed_text);
        assert_eq!(tag.association_number, 2);
        assert_eq!(tag.sci, Some(0x0102_0304_0506_0009));
        for n in 0..bytes.len() {
            assert_eq!(parse(&bytes[..n]), Err(ParseError::Truncated));
        }
    }

    #[test]
    fn random_prefix_no_panic() {
        let mut bytes = Vec::new();
        for n in 0..512u32 {
            bytes.push(n.wrapping_mul(181) as u8);
            let _ = parse(&bytes);
        }
    }
}
