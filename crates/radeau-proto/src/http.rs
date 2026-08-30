//! Bounded HTTP/1.x start-line and header decoder.
use crate::ParseError;

pub const MAX_HEADER_BLOCK: usize = 16 * 1024;
pub const MAX_HEADERS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpMessage {
    Request {
        method: String,
        target: String,
        version: String,
        headers: Vec<(String, String)>,
        body_len: usize,
    },
    Response {
        version: String,
        status: u16,
        reason: String,
        headers: Vec<(String, String)>,
        body_len: usize,
    },
}

pub fn looks_like_http(payload: &[u8]) -> bool {
    payload.starts_with(b"HTTP/")
        || [
            b"GET ".as_slice(),
            b"POST ",
            b"PUT ",
            b"DELETE ",
            b"HEAD ",
            b"OPTIONS ",
            b"PATCH ",
            b"CONNECT ",
            b"TRACE ",
        ]
        .iter()
        .any(|method| payload.starts_with(method))
}

fn header_end(payload: &[u8]) -> Result<(usize, usize), ParseError> {
    let scan_len = payload.len().min(MAX_HEADER_BLOCK + 1);
    let scan = &payload[..scan_len];
    if let Some(position) = scan.windows(4).position(|window| window == b"\r\n\r\n") {
        return (position + 4 <= MAX_HEADER_BLOCK)
            .then_some((position, 4))
            .ok_or(ParseError::Malformed);
    }
    if let Some(position) = scan.windows(2).position(|window| window == b"\n\n") {
        return (position + 2 <= MAX_HEADER_BLOCK)
            .then_some((position, 2))
            .ok_or(ParseError::Malformed);
    }
    if payload.len() >= MAX_HEADER_BLOCK {
        Err(ParseError::Malformed)
    } else {
        Err(ParseError::Truncated)
    }
}

pub fn parse(payload: &[u8]) -> Result<HttpMessage, ParseError> {
    let (end, delimiter_len) = header_end(payload)?;
    let block = std::str::from_utf8(&payload[..end]).map_err(|_| ParseError::Malformed)?;
    let mut lines = block.lines().map(|line| line.trim_end_matches('\r'));
    let start = lines.next().ok_or(ParseError::Malformed)?;
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':').ok_or(ParseError::Malformed)?;
        if name.is_empty() {
            return Err(ParseError::Malformed);
        }
        if headers.len() < MAX_HEADERS {
            headers.push((name.to_owned(), value.trim().to_owned()));
        }
    }
    let body_len = payload.len() - end - delimiter_len;
    if start.starts_with("HTTP/") {
        let mut parts = start.splitn(3, ' ');
        let version = parts.next().ok_or(ParseError::Malformed)?;
        let status = parts
            .next()
            .ok_or(ParseError::Malformed)?
            .parse::<u16>()
            .map_err(|_| ParseError::Malformed)?;
        let reason = parts.next().unwrap_or("");
        Ok(HttpMessage::Response {
            version: version.to_owned(),
            status,
            reason: reason.to_owned(),
            headers,
            body_len,
        })
    } else {
        let mut parts = start.split(' ');
        let method = parts.next().ok_or(ParseError::Malformed)?;
        let target = parts.next().ok_or(ParseError::Malformed)?;
        let version = parts.next().ok_or(ParseError::Malformed)?;
        if parts.next().is_some() || method_code(method) == 0 || !version.starts_with("HTTP/") {
            return Err(ParseError::Malformed);
        }
        Ok(HttpMessage::Request {
            method: method.to_owned(),
            target: target.to_owned(),
            version: version.to_owned(),
            headers,
            body_len,
        })
    }
}

pub fn method_code(method: &str) -> u8 {
    match method {
        "GET" => 1,
        "POST" => 2,
        "PUT" => 3,
        "DELETE" => 4,
        "HEAD" => 5,
        "OPTIONS" => 6,
        "PATCH" => 7,
        "CONNECT" => 8,
        "TRACE" => 9,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_vector_and_prefixes() {
        let bytes = b"GET /status HTTP/1.1\r\nHost: ecu.local\r\nUser-Agent: RadEAU\r\n\r\nbody";
        let message = parse(bytes).unwrap();
        assert_eq!(
            message,
            HttpMessage::Request {
                method: "GET".into(),
                target: "/status".into(),
                version: "HTTP/1.1".into(),
                headers: vec![
                    ("Host".into(), "ecu.local".into()),
                    ("User-Agent".into(), "RadEAU".into())
                ],
                body_len: 4,
            }
        );
        let complete = bytes.len() - 4;
        for n in 0..complete {
            assert_eq!(parse(&bytes[..n]), Err(ParseError::Truncated));
        }
    }

    #[test]
    fn response_and_random_prefixes() {
        assert!(matches!(
            parse(b"HTTP/1.1 200 OK\nServer: x\n\n").unwrap(),
            HttpMessage::Response { status: 200, .. }
        ));
        let mut bytes = Vec::new();
        for n in 0..1024u32 {
            bytes.push(n.wrapping_mul(97).wrapping_add(11) as u8);
            let _ = parse(&bytes);
        }
    }
}
