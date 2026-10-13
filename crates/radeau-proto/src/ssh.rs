//! Bounded SSH identification-line and binary packet decoder.
use crate::ParseError;

pub const MAX_BANNER_LEN: usize = 255;
pub const MAX_PACKET_LEN: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshMessage<'a> {
    Banner {
        protocol_version: &'a str,
        software_version: &'a str,
        comments: Option<&'a str>,
    },
    Packet {
        packet_length: u32,
        padding_length: u8,
        message_type: u8,
        payload: &'a [u8],
        padding: &'a [u8],
    },
}

fn parse_banner(payload: &[u8]) -> Result<SshMessage<'_>, ParseError> {
    let newline = payload.iter().position(|byte| *byte == b'\n');
    let Some(newline) = newline else {
        return if payload.len() > MAX_BANNER_LEN {
            Err(ParseError::Malformed)
        } else {
            Err(ParseError::Truncated)
        };
    };
    if newline + 1 > MAX_BANNER_LEN {
        return Err(ParseError::Malformed);
    }
    let line = payload
        .get(..newline)
        .ok_or(ParseError::Malformed)?
        .strip_suffix(b"\r")
        .unwrap_or(&payload[..newline]);
    let line = std::str::from_utf8(line).map_err(|_| ParseError::Malformed)?;
    let rest = line.strip_prefix("SSH-").ok_or(ParseError::Malformed)?;
    let (protocol_version, rest) = rest.split_once('-').ok_or(ParseError::Malformed)?;
    let (software_version, comments) = match rest.split_once(' ') {
        Some((software, comments)) => (software, Some(comments)),
        None => (rest, None),
    };
    if protocol_version.is_empty() || software_version.is_empty() {
        return Err(ParseError::Malformed);
    }
    Ok(SshMessage::Banner {
        protocol_version,
        software_version,
        comments,
    })
}

pub fn parse(payload: &[u8]) -> Result<SshMessage<'_>, ParseError> {
    if payload.len() < 4 && b"SSH-".starts_with(payload) || payload.starts_with(b"SSH-") {
        return parse_banner(payload);
    }
    let header = payload.get(..5).ok_or(ParseError::Truncated)?;
    let packet_length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
    let packet_len = usize::try_from(packet_length).map_err(|_| ParseError::Malformed)?;
    if !(6..=MAX_PACKET_LEN).contains(&packet_len) {
        return Err(ParseError::Malformed);
    }
    let packet = payload
        .get(4..4 + packet_len)
        .ok_or(ParseError::Truncated)?;
    let padding_length = header[4];
    let padding_len = usize::from(padding_length);
    if padding_len < 4 || padding_len + 2 > packet_len {
        return Err(ParseError::Malformed);
    }
    let payload_end = packet_len - padding_len;
    let message_payload = &packet[1..payload_end];
    let (&message_type, payload) = message_payload.split_first().ok_or(ParseError::Malformed)?;
    Ok(SshMessage::Packet {
        packet_length,
        padding_length,
        message_type,
        payload,
        padding: &packet[payload_end..],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn banner_exact_vector_and_prefixes() {
        let bytes = b"SSH-2.0-OpenSSH_9.6 RadEAU\r\n";
        assert_eq!(
            parse(bytes).unwrap(),
            SshMessage::Banner {
                protocol_version: "2.0",
                software_version: "OpenSSH_9.6",
                comments: Some("RadEAU"),
            }
        );
        for n in 0..bytes.len() {
            assert_eq!(parse(&bytes[..n]), Err(ParseError::Truncated));
        }
    }

    #[test]
    fn packet_exact_vector_and_prefixes() {
        let bytes = [0, 0, 0, 10, 6, 5, 0xaa, 0xbb, 1, 2, 3, 4, 5, 6];
        assert_eq!(
            parse(&bytes).unwrap(),
            SshMessage::Packet {
                packet_length: 10,
                padding_length: 6,
                message_type: 5,
                payload: &[0xaa, 0xbb],
                padding: &[1, 2, 3, 4, 5, 6],
            }
        );
        for n in 0..bytes.len() {
            assert_eq!(parse(&bytes[..n]), Err(ParseError::Truncated));
        }
    }

    #[test]
    fn random_prefix_no_panic() {
        let mut bytes = Vec::new();
        for n in 0..1024u32 {
            bytes.push(n.wrapping_mul(61).wrapping_add(23) as u8);
            let _ = parse(&bytes);
        }
    }
}
