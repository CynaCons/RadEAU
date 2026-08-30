//! Bounded HTTP-like SSDP datagram codec.

use crate::ParseError;

pub const PORT: u16 = 1900;
pub const MAX_MESSAGE_LEN: usize = 16 * 1024;
pub const MAX_HEADERS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SsdpKind {
    MSearch,
    Notify,
    Response,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SsdpMessage {
    pub kind: SsdpKind,
    pub start_line: String,
    pub headers: Vec<(String, String)>,
}

pub fn parse(buf: &[u8]) -> Result<SsdpMessage, ParseError> {
    if buf.len() > MAX_MESSAGE_LEN {
        return Err(ParseError::Malformed);
    }
    let text = core::str::from_utf8(buf).map_err(|_| ParseError::Malformed)?;
    let end = text.find("\r\n\r\n").ok_or(ParseError::Truncated)?;
    if end + 4 != text.len() {
        return Err(ParseError::Malformed);
    }
    let mut lines = text[..end].split("\r\n");
    let start = lines
        .next()
        .filter(|s| !s.is_empty())
        .ok_or(ParseError::Malformed)?;
    let kind = if start == "M-SEARCH * HTTP/1.1" {
        SsdpKind::MSearch
    } else if start == "NOTIFY * HTTP/1.1" {
        SsdpKind::Notify
    } else if start.starts_with("HTTP/1.1 ") {
        SsdpKind::Response
    } else {
        return Err(ParseError::Malformed);
    };
    let mut headers = Vec::new();
    for line in lines {
        if headers.len() == MAX_HEADERS {
            return Err(ParseError::Malformed);
        }
        let (name, value) = line.split_once(':').ok_or(ParseError::Malformed)?;
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(ParseError::Malformed);
        }
        headers.push((name.to_string(), value.trim().to_string()));
    }
    Ok(SsdpMessage {
        kind,
        start_line: start.to_string(),
        headers,
    })
}

pub fn build_notify(headers: &[(&str, &str)], out: &mut Vec<u8>) {
    out.extend_from_slice(b"NOTIFY * HTTP/1.1\r\n");
    for (name, value) in headers {
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(value.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"\r\n");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vector_and_round_trip() {
        let mut v = Vec::new();
        build_notify(
            &[("HOST", "239.255.255.250:1900"), ("NT", "upnp:rootdevice")],
            &mut v,
        );
        assert_eq!(
            v,
            b"NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nNT: upnp:rootdevice\r\n\r\n"
        );
        let p = parse(&v).unwrap();
        assert_eq!(p.kind, SsdpKind::Notify);
        assert_eq!(p.headers.len(), 2);
    }
    #[test]
    fn prefixes_and_noise() {
        let v = b"NOTIFY * HTTP/1.1\r\nHOST: x\r\n\r\n";
        for n in 0..v.len() {
            assert_eq!(parse(&v[..n]), Err(ParseError::Truncated));
        }
        for n in 0..512 {
            let v = vec![(n * 73) as u8; n % 90];
            let _ = parse(&v);
        }
    }
    #[test]
    fn caps_headers() {
        let mut v = b"NOTIFY * HTTP/1.1\r\n".to_vec();
        for _ in 0..33 {
            v.extend_from_slice(b"X: y\r\n");
        }
        v.extend_from_slice(b"\r\n");
        assert_eq!(parse(&v), Err(ParseError::Malformed));
    }
}
