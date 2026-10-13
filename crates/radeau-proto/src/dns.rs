//! Bounded Domain Name System message codec.

use crate::ParseError;

pub const PORT: u16 = 53;
pub const MAX_QUESTIONS: usize = 64;
pub const MAX_ANSWERS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DnsQuestion {
    pub name: String,
    pub qtype: u16,
    pub qclass: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rdata {
    A([u8; 4]),
    Aaaa([u8; 16]),
    Ptr(String),
    Cname(String),
    Srv {
        priority: u16,
        weight: u16,
        port: u16,
        target: String,
    },
    Txt(Vec<String>),
    Mx {
        preference: u16,
        exchange: String,
    },
    Ns(String),
    Other {
        rr_type: u16,
        data: Vec<u8>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DnsAnswer {
    pub name: String,
    pub rr_type: u16,
    pub class: u16,
    pub ttl: u32,
    pub rdata: Rdata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DnsMessage {
    pub id: u16,
    pub is_response: bool,
    pub opcode: u8,
    pub authoritative: bool,
    pub truncated: bool,
    pub recursion_desired: bool,
    pub recursion_available: bool,
    pub authenticated_data: bool,
    pub checking_disabled: bool,
    pub rcode: u8,
    pub questions: Vec<DnsQuestion>,
    pub answers: Vec<DnsAnswer>,
    pub authority_count: u16,
    pub additional_count: u16,
}

fn u16_at(buf: &[u8], pos: usize) -> Result<u16, ParseError> {
    let b = buf.get(pos..pos + 2).ok_or(ParseError::Truncated)?;
    Ok(u16::from_be_bytes([b[0], b[1]]))
}

fn parse_name(buf: &[u8], start: usize) -> Result<(String, usize), ParseError> {
    let mut labels = Vec::new();
    let mut pos = start;
    let mut consumed = 0usize;
    let mut jumped = false;
    let mut hops = 0usize;
    let mut expanded = 1usize;
    loop {
        let len = *buf.get(pos).ok_or(ParseError::Truncated)?;
        if len & 0xc0 == 0xc0 {
            let low = *buf.get(pos + 1).ok_or(ParseError::Truncated)?;
            if !jumped {
                consumed = pos + 2 - start;
            }
            let target = (((len & 0x3f) as usize) << 8) | low as usize;
            if target >= buf.len() {
                return Err(ParseError::Malformed);
            }
            hops += 1;
            if hops > 64 {
                return Err(ParseError::Malformed);
            }
            pos = target;
            jumped = true;
        } else if len & 0xc0 != 0 {
            return Err(ParseError::Malformed);
        } else if len == 0 {
            if !jumped {
                consumed = pos + 1 - start;
            }
            break;
        } else {
            let n = len as usize;
            if n > 63 {
                return Err(ParseError::Malformed);
            }
            let label = buf.get(pos + 1..pos + 1 + n).ok_or(ParseError::Truncated)?;
            expanded = expanded
                .checked_add(n + usize::from(!labels.is_empty()))
                .ok_or(ParseError::Malformed)?;
            if expanded > 255 {
                return Err(ParseError::Malformed);
            }
            labels.push(
                core::str::from_utf8(label)
                    .map_err(|_| ParseError::Malformed)?
                    .to_string(),
            );
            pos += n + 1;
            if !jumped {
                consumed = pos - start;
            }
        }
    }
    Ok((labels.join("."), consumed))
}

fn skip_name(buf: &[u8], start: usize) -> Result<usize, ParseError> {
    let mut pos = start;
    let mut consumed = 0usize;
    let mut jumped = false;
    let mut hops = 0usize;
    let mut expanded = 1usize;
    loop {
        let len = *buf.get(pos).ok_or(ParseError::Truncated)?;
        if len & 0xc0 == 0xc0 {
            let low = *buf.get(pos + 1).ok_or(ParseError::Truncated)?;
            if !jumped {
                consumed = pos + 2 - start;
            }
            let target = (((len & 0x3f) as usize) << 8) | usize::from(low);
            if target >= buf.len() {
                return Err(ParseError::Malformed);
            }
            hops += 1;
            if hops > 64 {
                return Err(ParseError::Malformed);
            }
            pos = target;
            jumped = true;
        } else if len & 0xc0 != 0 {
            return Err(ParseError::Malformed);
        } else if len == 0 {
            if !jumped {
                consumed = pos + 1 - start;
            }
            return Ok(consumed);
        } else {
            let len = usize::from(len);
            buf.get(pos + 1..pos + 1 + len)
                .ok_or(ParseError::Truncated)?;
            expanded = expanded.checked_add(len + 1).ok_or(ParseError::Malformed)?;
            if expanded > 255 {
                return Err(ParseError::Malformed);
            }
            pos += len + 1;
            if !jumped {
                consumed = pos - start;
            }
        }
    }
}

fn parse_rr(buf: &[u8], pos: &mut usize, keep: bool) -> Result<Option<DnsAnswer>, ParseError> {
    let (name, used) = if keep {
        let (name, used) = parse_name(buf, *pos)?;
        (Some(name), used)
    } else {
        (None, skip_name(buf, *pos)?)
    };
    *pos += used;
    let head = buf.get(*pos..*pos + 10).ok_or(ParseError::Truncated)?;
    let rr_type = u16::from_be_bytes([head[0], head[1]]);
    let class = u16::from_be_bytes([head[2], head[3]]);
    let ttl = u32::from_be_bytes(head[4..8].try_into().expect("exact"));
    let len = u16::from_be_bytes([head[8], head[9]]) as usize;
    let data_pos = *pos + 10;
    let data = buf
        .get(data_pos..data_pos.checked_add(len).ok_or(ParseError::Malformed)?)
        .ok_or(ParseError::Truncated)?;
    *pos = data_pos + len;
    if !keep {
        return Ok(None);
    }
    let named = |offset: usize| -> Result<String, ParseError> {
        let (value, consumed) = parse_name(buf, data_pos + offset)?;
        if offset + consumed != len {
            return Err(ParseError::Malformed);
        }
        Ok(value)
    };
    let rdata = match rr_type {
        1 if len == 4 => Rdata::A(data.try_into().expect("length checked")),
        28 if len == 16 => Rdata::Aaaa(data.try_into().expect("length checked")),
        12 => Rdata::Ptr(named(0)?),
        5 => Rdata::Cname(named(0)?),
        2 => Rdata::Ns(named(0)?),
        15 if len >= 3 => Rdata::Mx {
            preference: u16::from_be_bytes([data[0], data[1]]),
            exchange: named(2)?,
        },
        33 if len >= 7 => Rdata::Srv {
            priority: u16::from_be_bytes([data[0], data[1]]),
            weight: u16::from_be_bytes([data[2], data[3]]),
            port: u16::from_be_bytes([data[4], data[5]]),
            target: named(6)?,
        },
        16 => {
            let mut strings = Vec::new();
            let mut p = 0;
            while p < data.len() {
                let n = data[p] as usize;
                p += 1;
                let s = data.get(p..p + n).ok_or(ParseError::Malformed)?;
                strings.push(
                    core::str::from_utf8(s)
                        .map_err(|_| ParseError::Malformed)?
                        .to_string(),
                );
                p += n;
            }
            Rdata::Txt(strings)
        }
        _ => Rdata::Other {
            rr_type,
            data: data.to_vec(),
        },
    };
    Ok(Some(DnsAnswer {
        name: name.expect("kept record has a parsed owner name"),
        rr_type,
        class,
        ttl,
        rdata,
    }))
}

pub fn parse(buf: &[u8]) -> Result<DnsMessage, ParseError> {
    let h = buf.get(..12).ok_or(ParseError::Truncated)?;
    let flags = u16::from_be_bytes([h[2], h[3]]);
    let qd = u16::from_be_bytes([h[4], h[5]]) as usize;
    let an = u16::from_be_bytes([h[6], h[7]]) as usize;
    let ns = u16::from_be_bytes([h[8], h[9]]);
    let ar = u16::from_be_bytes([h[10], h[11]]);
    if qd > MAX_QUESTIONS || an > MAX_ANSWERS {
        return Err(ParseError::Malformed);
    }
    let mut pos = 12;
    let mut questions = Vec::with_capacity(qd);
    for _ in 0..qd {
        let (name, used) = parse_name(buf, pos)?;
        pos += used;
        let qtype = u16_at(buf, pos)?;
        let qclass = u16_at(buf, pos + 2)?;
        pos += 4;
        questions.push(DnsQuestion {
            name,
            qtype,
            qclass,
        });
    }
    let mut answers = Vec::with_capacity(an);
    for _ in 0..an {
        answers.push(parse_rr(buf, &mut pos, true)?.expect("kept"));
    }
    for _ in 0..usize::from(ns) + usize::from(ar) {
        parse_rr(buf, &mut pos, false)?;
    }
    if pos != buf.len() {
        return Err(ParseError::Malformed);
    }
    Ok(DnsMessage {
        id: u16::from_be_bytes([h[0], h[1]]),
        is_response: flags & 0x8000 != 0,
        opcode: ((flags >> 11) & 0xf) as u8,
        authoritative: flags & 0x0400 != 0,
        truncated: flags & 0x0200 != 0,
        recursion_desired: flags & 0x0100 != 0,
        recursion_available: flags & 0x0080 != 0,
        authenticated_data: flags & 0x0020 != 0,
        checking_disabled: flags & 0x0010 != 0,
        rcode: (flags & 0xf) as u8,
        questions,
        answers,
        authority_count: ns,
        additional_count: ar,
    })
}

pub fn qtype_name(t: u16) -> &'static str {
    match t {
        1 => "A",
        2 => "NS",
        5 => "CNAME",
        12 => "PTR",
        15 => "MX",
        16 => "TXT",
        28 => "AAAA",
        33 => "SRV",
        255 => "ANY",
        _ => "unknown",
    }
}

pub fn rcode_name(code: u8) -> &'static str {
    match code {
        0 => "NoError",
        1 => "FormErr",
        2 => "ServFail",
        3 => "NXDomain",
        4 => "NotImp",
        5 => "Refused",
        _ => "Unknown",
    }
}

fn put_name(name: &str, out: &mut Vec<u8>) -> Result<(), ParseError> {
    if name.is_empty() {
        out.push(0);
        return Ok(());
    }
    let mut total = 1usize;
    for label in name.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err(ParseError::Malformed);
        }
        total += label.len() + 1;
        if total > 255 {
            return Err(ParseError::Malformed);
        }
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    Ok(())
}

pub fn build_query(id: u16, name: &str, qtype: u16, out: &mut Vec<u8>) -> Result<(), ParseError> {
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(&0x0100u16.to_be_bytes());
    out.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 0]);
    put_name(name, out)?;
    out.extend_from_slice(&qtype.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    Ok(())
}

pub fn build_response(
    id: u16,
    name: &str,
    ttl: u32,
    value: &Rdata,
    out: &mut Vec<u8>,
) -> Result<(), ParseError> {
    let rr_type: u16 = match value {
        Rdata::A(_) => 1,
        Rdata::Ptr(_) => 12,
        Rdata::Txt(_) => 16,
        Rdata::Srv { .. } => 33,
        _ => return Err(ParseError::Malformed),
    };
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(&0x8400u16.to_be_bytes());
    out.extend_from_slice(&[0, 1, 0, 1, 0, 0, 0, 0]);
    put_name(name, out)?;
    out.extend_from_slice(&rr_type.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    out.extend_from_slice(&[0xc0, 0x0c]);
    out.extend_from_slice(&rr_type.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    out.extend_from_slice(&ttl.to_be_bytes());
    let len_at = out.len();
    out.extend_from_slice(&[0, 0]);
    let start = out.len();
    match value {
        Rdata::A(a) => out.extend_from_slice(a),
        Rdata::Ptr(n) => put_name(n, out)?,
        Rdata::Srv {
            priority,
            weight,
            port,
            target,
        } => {
            out.extend_from_slice(&priority.to_be_bytes());
            out.extend_from_slice(&weight.to_be_bytes());
            out.extend_from_slice(&port.to_be_bytes());
            put_name(target, out)?;
        }
        Rdata::Txt(items) => {
            for item in items {
                if item.len() > 255 {
                    return Err(ParseError::Malformed);
                }
                out.push(item.len() as u8);
                out.extend_from_slice(item.as_bytes());
            }
        }
        _ => unreachable!(),
    }
    let len = out.len() - start;
    if len > u16::MAX as usize {
        return Err(ParseError::Malformed);
    }
    out[len_at..len_at + 2].copy_from_slice(&(len as u16).to_be_bytes());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_query_and_answers() {
        let mut q = Vec::new();
        build_query(0x1234, "example.com", 1, &mut q).unwrap();
        assert_eq!(&q[..12], &[0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        let p = parse(&q).unwrap();
        assert_eq!(p.questions[0].name, "example.com");
        for value in [
            Rdata::A([192, 0, 2, 1]),
            Rdata::Ptr("host.local".into()),
            Rdata::Srv {
                priority: 0,
                weight: 5,
                port: 80,
                target: "host.local".into(),
            },
            Rdata::Txt(vec!["hello".into()]),
        ] {
            let mut wire = Vec::new();
            build_response(7, "service.local", 120, &value, &mut wire).unwrap();
            assert_eq!(parse(&wire).unwrap().answers[0].rdata, value);
        }
    }
    #[test]
    fn every_prefix_and_noise() {
        let mut q = Vec::new();
        build_query(1, "a.example", 1, &mut q).unwrap();
        for n in 0..q.len() {
            assert_eq!(parse(&q[..n]), Err(ParseError::Truncated));
        }
        let mut x = 3u32;
        for n in 0..1024 {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let v = vec![(x >> 24) as u8; n % 200];
            let _ = parse(&v);
        }
    }
    #[test]
    fn compression_loop_is_malformed() {
        let wire = [0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c, 0, 1, 0, 1];
        assert_eq!(parse(&wire), Err(ParseError::Malformed));
    }

    #[test]
    fn discarded_record_owner_is_skipped_without_utf8_decoding() {
        let wire = [
            0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, // header: one authority RR
            1, 0xff, 0, // structurally valid opaque owner label
            0, 1, 0, 1, // A, IN
            0, 0, 0, 0, // TTL
            0, 4, 192, 0, 2, 1, // RDATA
        ];
        let parsed = parse(&wire).unwrap();
        assert_eq!(parsed.authority_count, 1);
        assert_eq!(parsed.answers, [] as [DnsAnswer; 0]);
    }
}
