//! Bounded TLS record and ClientHello/ServerHello decoder.
use crate::ParseError;

pub const RECORD_HEADER_LEN: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Handshake {
    ClientHello {
        version: u16,
        random: [u8; 32],
        session_id_len: u8,
        cipher_suite_count: u16,
        sni: Option<String>,
        alpn: Vec<String>,
    },
    ServerHello {
        version: u16,
        cipher_suite: u16,
    },
    Other {
        handshake_type: u8,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TlsRecord {
    pub content_type: u8,
    pub version: u16,
    pub length: u16,
    pub handshake: Option<Handshake>,
}

pub fn looks_like_tls(payload: &[u8]) -> bool {
    matches!(payload.first(), Some(20..=23))
        && payload.get(1) == Some(&3)
        && matches!(payload.get(2), Some(0..=4))
}

fn take<'a>(input: &mut &'a [u8], len: usize) -> Result<&'a [u8], ParseError> {
    let value = input.get(..len).ok_or(ParseError::Truncated)?;
    *input = &input[len..];
    Ok(value)
}

fn take_u8(input: &mut &[u8]) -> Result<u8, ParseError> {
    Ok(take(input, 1)?[0])
}

fn take_u16(input: &mut &[u8]) -> Result<u16, ParseError> {
    let bytes = take(input, 2)?;
    Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn parse_extensions(mut input: &[u8]) -> Result<(Option<String>, Vec<String>), ParseError> {
    if input.is_empty() {
        return Ok((None, Vec::new()));
    }
    let extensions_len = usize::from(take_u16(&mut input)?);
    let mut extensions = take(&mut input, extensions_len)?;
    if !input.is_empty() {
        return Err(ParseError::Malformed);
    }

    let mut sni = None;
    let mut alpn = Vec::new();
    while !extensions.is_empty() {
        let extension_type = take_u16(&mut extensions)?;
        let item_len = usize::from(take_u16(&mut extensions)?);
        let mut value = take(&mut extensions, item_len)?;
        match extension_type {
            0 => {
                let list_len = usize::from(take_u16(&mut value)?);
                let mut names = take(&mut value, list_len)?;
                if !value.is_empty() {
                    return Err(ParseError::Malformed);
                }
                while !names.is_empty() {
                    let name_type = take_u8(&mut names)?;
                    let name_len = usize::from(take_u16(&mut names)?);
                    let name = take(&mut names, name_len)?;
                    if name_type == 0 && sni.is_none() {
                        sni = Some(
                            std::str::from_utf8(name)
                                .map_err(|_| ParseError::Malformed)?
                                .to_owned(),
                        );
                    }
                }
            }
            16 => {
                let list_len = usize::from(take_u16(&mut value)?);
                let mut protocols = take(&mut value, list_len)?;
                if !value.is_empty() {
                    return Err(ParseError::Malformed);
                }
                while !protocols.is_empty() {
                    let protocol_len = usize::from(take_u8(&mut protocols)?);
                    let protocol = take(&mut protocols, protocol_len)?;
                    alpn.push(
                        std::str::from_utf8(protocol)
                            .map_err(|_| ParseError::Malformed)?
                            .to_owned(),
                    );
                }
            }
            _ => {}
        }
    }
    Ok((sni, alpn))
}

fn parse_client_hello(mut body: &[u8]) -> Result<Handshake, ParseError> {
    let version = take_u16(&mut body)?;
    let random: [u8; 32] = take(&mut body, 32)?
        .try_into()
        .map_err(|_| ParseError::Malformed)?;
    let session_id_len = take_u8(&mut body)?;
    take(&mut body, usize::from(session_id_len))?;
    let cipher_suite_len = take_u16(&mut body)?;
    if cipher_suite_len == 0 || cipher_suite_len % 2 != 0 {
        return Err(ParseError::Malformed);
    }
    take(&mut body, usize::from(cipher_suite_len))?;
    let compression_len = usize::from(take_u8(&mut body)?);
    if compression_len == 0 {
        return Err(ParseError::Malformed);
    }
    take(&mut body, compression_len)?;
    let (sni, alpn) = parse_extensions(body)?;
    Ok(Handshake::ClientHello {
        version,
        random,
        session_id_len,
        cipher_suite_count: cipher_suite_len / 2,
        sni,
        alpn,
    })
}

fn parse_server_hello(mut body: &[u8]) -> Result<Handshake, ParseError> {
    let version = take_u16(&mut body)?;
    take(&mut body, 32)?;
    let session_id_len = usize::from(take_u8(&mut body)?);
    take(&mut body, session_id_len)?;
    let cipher_suite = take_u16(&mut body)?;
    take_u8(&mut body)?;
    let _ = parse_extensions(body)?;
    Ok(Handshake::ServerHello {
        version,
        cipher_suite,
    })
}

pub fn parse(payload: &[u8]) -> Result<TlsRecord, ParseError> {
    let header = payload
        .get(..RECORD_HEADER_LEN)
        .ok_or(ParseError::Truncated)?;
    let length = u16::from_be_bytes([header[3], header[4]]);
    let body = payload
        .get(RECORD_HEADER_LEN..RECORD_HEADER_LEN + usize::from(length))
        .ok_or(ParseError::Truncated)?;
    let handshake = if header[0] == 22 {
        let handshake_header = body.get(..4).ok_or(ParseError::Truncated)?;
        let handshake_len = (usize::from(handshake_header[1]) << 16)
            | (usize::from(handshake_header[2]) << 8)
            | usize::from(handshake_header[3]);
        let handshake_body = body
            .get(4..4 + handshake_len)
            .ok_or(ParseError::Truncated)?;
        Some(match handshake_header[0] {
            1 => parse_client_hello(handshake_body)?,
            2 => parse_server_hello(handshake_body)?,
            handshake_type => Handshake::Other { handshake_type },
        })
    } else {
        None
    };
    Ok(TlsRecord {
        content_type: header[0],
        version: u16::from_be_bytes([header[1], header[2]]),
        length,
        handshake,
    })
}

pub fn content_type_name(content_type: u8) -> String {
    match content_type {
        20 => "ChangeCipherSpec".into(),
        21 => "Alert".into(),
        22 => "Handshake".into(),
        23 => "Application Data".into(),
        value => format!("content type {value}"),
    }
}

pub fn handshake_type_name(handshake_type: u8) -> String {
    match handshake_type {
        0 => "HelloRequest".into(),
        1 => "ClientHello".into(),
        2 => "ServerHello".into(),
        4 => "NewSessionTicket".into(),
        8 => "EncryptedExtensions".into(),
        11 => "Certificate".into(),
        13 => "CertificateRequest".into(),
        15 => "CertificateVerify".into(),
        20 => "Finished".into(),
        value => format!("handshake type {value}"),
    }
}

fn push_extension(out: &mut Vec<u8>, extension_type: u16, value: &[u8]) {
    out.extend_from_slice(&extension_type.to_be_bytes());
    out.extend_from_slice(&(value.len() as u16).to_be_bytes());
    out.extend_from_slice(value);
}

pub fn build_client_hello(sni: &str, alpn: &[&str]) -> Vec<u8> {
    const MAX_EXTENSIONS_LEN: usize = 65_484;
    let mut sni_len = sni.len().min(MAX_EXTENSIONS_LEN - 9);
    while !sni.is_char_boundary(sni_len) {
        sni_len -= 1;
    }
    let sni_bytes = &sni.as_bytes()[..sni_len];
    let mut extensions = Vec::new();
    if !sni_bytes.is_empty() {
        let mut value = Vec::new();
        value.extend_from_slice(&(sni_bytes.len() as u16 + 3).to_be_bytes());
        value.push(0);
        value.extend_from_slice(&(sni_bytes.len() as u16).to_be_bytes());
        value.extend_from_slice(sni_bytes);
        push_extension(&mut extensions, 0, &value);
    }
    if !alpn.is_empty() {
        let mut protocols = Vec::new();
        for protocol in alpn {
            let bytes = protocol.as_bytes();
            let len = bytes.len().min(usize::from(u8::MAX));
            if extensions.len() + 6 + protocols.len() + 1 + len > MAX_EXTENSIONS_LEN {
                break;
            }
            protocols.push(len as u8);
            protocols.extend_from_slice(&bytes[..len]);
        }
        if !protocols.is_empty() {
            let mut value = Vec::with_capacity(protocols.len() + 2);
            value.extend_from_slice(&(protocols.len() as u16).to_be_bytes());
            value.extend_from_slice(&protocols);
            push_extension(&mut extensions, 16, &value);
        }
    }

    let mut hello = Vec::new();
    hello.extend_from_slice(&0x0303u16.to_be_bytes());
    hello.extend(0u8..32);
    hello.push(0);
    hello.extend_from_slice(&6u16.to_be_bytes());
    hello.extend_from_slice(&[0x13, 0x01, 0x13, 0x02, 0xc0, 0x2f]);
    hello.extend_from_slice(&[1, 0]);
    hello.extend_from_slice(&(extensions.len() as u16).to_be_bytes());
    hello.extend_from_slice(&extensions);

    let mut record = Vec::with_capacity(hello.len() + 9);
    record.extend_from_slice(&[22, 3, 1]);
    record.extend_from_slice(&(hello.len() as u16 + 4).to_be_bytes());
    record.push(1);
    let len = hello.len() as u32;
    record.extend_from_slice(&len.to_be_bytes()[1..]);
    record.extend_from_slice(&hello);
    record
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_hello_vector_and_prefixes() {
        let bytes = build_client_hello("ecu.local", &["h2", "http/1.1"]);
        assert_eq!(&bytes[..11], &[22, 3, 1, 0, 87, 1, 0, 0, 83, 3, 3]);
        let parsed = parse(&bytes).unwrap();
        assert_eq!(parsed.length, 87);
        assert_eq!(
            parsed.handshake,
            Some(Handshake::ClientHello {
                version: 0x0303,
                random: core::array::from_fn(|index| index as u8),
                session_id_len: 0,
                cipher_suite_count: 3,
                sni: Some("ecu.local".into()),
                alpn: vec!["h2".into(), "http/1.1".into()],
            })
        );
        for n in 0..bytes.len() {
            assert_eq!(parse(&bytes[..n]), Err(ParseError::Truncated));
        }
    }

    #[test]
    fn server_hello_exact_vector() {
        let mut bytes = vec![22, 3, 3, 0, 42, 2, 0, 0, 38, 3, 3];
        bytes.extend_from_slice(&[0x55; 32]);
        bytes.extend_from_slice(&[0, 0x13, 0x01, 0]);
        assert_eq!(
            parse(&bytes).unwrap().handshake,
            Some(Handshake::ServerHello {
                version: 0x0303,
                cipher_suite: 0x1301,
            })
        );
    }

    #[test]
    fn short_handshake_inputs_are_truncated() {
        let short_header = [22, 3, 3, 0, 3, 1, 0, 0];
        assert_eq!(parse(&short_header), Err(ParseError::Truncated));

        let short_body = [22, 3, 3, 0, 5, 1, 0, 0, 4, 3];
        assert_eq!(parse(&short_body), Err(ParseError::Truncated));
    }

    #[test]
    fn random_prefix_no_panic() {
        let mut bytes = Vec::new();
        for n in 0..1024u32 {
            bytes.push(n.wrapping_mul(131).wrapping_add(17) as u8);
            let _ = parse(&bytes);
        }
    }
}
