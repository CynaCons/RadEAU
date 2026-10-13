//! Trivial File Transfer Protocol packet codec.

use crate::ParseError;

pub const PORT: u16 = 69;
pub const MAX_STRING_LEN: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TftpPacket<'a> {
    ReadRequest { filename: String, mode: String },
    WriteRequest { filename: String, mode: String },
    Data { block: u16, data: &'a [u8] },
    Ack { block: u16 },
    Error { code: u16, message: String },
}

fn zstr(buf: &[u8], start: usize) -> Result<(&str, usize), ParseError> {
    let tail = buf.get(start..).ok_or(ParseError::Truncated)?;
    let end = tail
        .iter()
        .position(|&b| b == 0)
        .ok_or(ParseError::Truncated)?;
    if end > MAX_STRING_LEN {
        return Err(ParseError::Malformed);
    }
    let value = core::str::from_utf8(&tail[..end]).map_err(|_| ParseError::Malformed)?;
    Ok((value, start + end + 1))
}

pub fn parse(buf: &[u8]) -> Result<TftpPacket<'_>, ParseError> {
    let h = buf.get(..2).ok_or(ParseError::Truncated)?;
    match u16::from_be_bytes([h[0], h[1]]) {
        op @ (1 | 2) => {
            let (filename, p) = zstr(buf, 2)?;
            let (mode, end) = zstr(buf, p)?;
            if filename.is_empty() || mode.is_empty() || end != buf.len() {
                return Err(ParseError::Malformed);
            }
            let packet = if op == 1 {
                TftpPacket::ReadRequest {
                    filename: filename.into(),
                    mode: mode.into(),
                }
            } else {
                TftpPacket::WriteRequest {
                    filename: filename.into(),
                    mode: mode.into(),
                }
            };
            Ok(packet)
        }
        3 => {
            let b = buf.get(2..4).ok_or(ParseError::Truncated)?;
            Ok(TftpPacket::Data {
                block: u16::from_be_bytes([b[0], b[1]]),
                data: &buf[4..],
            })
        }
        4 => {
            let b = buf.get(2..4).ok_or(ParseError::Truncated)?;
            if buf.len() != 4 {
                return Err(ParseError::Malformed);
            }
            Ok(TftpPacket::Ack {
                block: u16::from_be_bytes([b[0], b[1]]),
            })
        }
        5 => {
            let b = buf.get(2..4).ok_or(ParseError::Truncated)?;
            let (message, end) = zstr(buf, 4)?;
            if end != buf.len() {
                return Err(ParseError::Malformed);
            }
            Ok(TftpPacket::Error {
                code: u16::from_be_bytes([b[0], b[1]]),
                message: message.into(),
            })
        }
        _ => Err(ParseError::Malformed),
    }
}

pub fn opcode_name(opcode: u16) -> &'static str {
    match opcode {
        1 => "RRQ",
        2 => "WRQ",
        3 => "DATA",
        4 => "ACK",
        5 => "ERROR",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_vectors() {
        let rrq = b"\0\x01boot.bin\0octet\0";
        assert_eq!(
            parse(rrq).unwrap(),
            TftpPacket::ReadRequest {
                filename: "boot.bin".into(),
                mode: "octet".into()
            }
        );
        assert_eq!(
            parse(b"\0\x03\0\x07abc").unwrap(),
            TftpPacket::Data {
                block: 7,
                data: b"abc"
            }
        );
        assert_eq!(
            parse(b"\0\x04\0\x07").unwrap(),
            TftpPacket::Ack { block: 7 }
        );
        assert_eq!(
            parse(b"\0\x05\0\x01missing\0").unwrap(),
            TftpPacket::Error {
                code: 1,
                message: "missing".into()
            }
        );
    }
    #[test]
    fn prefixes_and_noise() {
        let v = b"\0\x01boot.bin\0octet\0";
        for n in 0..v.len() {
            assert_eq!(parse(&v[..n]), Err(ParseError::Truncated));
        }
        let mut x = 7u32;
        for n in 0..512 {
            x = x.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            let v = vec![(x >> 16) as u8; n % 100];
            let _ = parse(&v);
        }
    }
}
