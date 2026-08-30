//! Bounded IEEE 802.1X EAPOL decoder.
use crate::ParseError;

pub const ETHERTYPE: u16 = 0x888E;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EapolKey {
    pub descriptor_type: u8,
    pub key_info: u16,
    pub key_length: u16,
    pub replay_counter: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EapolFrame {
    pub version: u8,
    pub packet_type: u8,
    pub body_len: u16,
    pub key: Option<EapolKey>,
}

pub fn parse(buf: &[u8]) -> Result<EapolFrame, ParseError> {
    let header = buf.get(..4).ok_or(ParseError::Truncated)?;
    let body_len = u16::from_be_bytes([header[2], header[3]]);
    let body = buf
        .get(4..4 + usize::from(body_len))
        .ok_or(ParseError::Truncated)?;
    let key = if header[1] == 3 {
        let fixed = body.get(..13).ok_or(ParseError::Truncated)?;
        Some(EapolKey {
            descriptor_type: fixed[0],
            key_info: u16::from_be_bytes([fixed[1], fixed[2]]),
            key_length: u16::from_be_bytes([fixed[3], fixed[4]]),
            replay_counter: u64::from_be_bytes(fixed[5..13].try_into().expect("exact")),
        })
    } else {
        None
    };
    Ok(EapolFrame {
        version: header[0],
        packet_type: header[1],
        body_len,
        key,
    })
}

pub fn packet_type_name(packet_type: u8) -> String {
    match packet_type {
        0 => "EAP-Packet".into(),
        1 => "EAPOL-Start".into(),
        2 => "EAPOL-Logoff".into(),
        3 => "EAPOL-Key".into(),
        4 => "EAPOL-Encapsulated-ASF-Alert".into(),
        value => format!("packet type {value}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_vector_and_prefixes() {
        let bytes = [2, 3, 0, 13, 2, 0x13, 0xca, 0, 16, 0, 0, 0, 0, 0, 0, 0, 42];
        let frame = parse(&bytes).unwrap();
        assert_eq!(frame.key.unwrap().replay_counter, 42);
        for n in 0..bytes.len() {
            assert_eq!(parse(&bytes[..n]), Err(ParseError::Truncated));
        }
    }

    #[test]
    fn random_prefix_no_panic() {
        let mut bytes = Vec::new();
        for n in 0..512u32 {
            bytes.push(n.wrapping_mul(113) as u8);
            let _ = parse(&bytes);
        }
    }
}
