//! Minimal bounded SNMPv1/v2c BER decoder.

use crate::ParseError;

pub const PORT: u16 = 161;
pub const TRAP_PORT: u16 = 162;
pub const MAX_DEPTH: usize = 8;
pub const MAX_BINDINGS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BerValue {
    Integer(i64),
    OctetString(Vec<u8>),
    Oid(Vec<u32>),
    Null,
    Counter32(u32),
    TimeTicks(u32),
    Gauge32(u32),
    Other { tag: u8, data: Vec<u8> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VarBind {
    pub oid: Vec<u32>,
    pub value: BerValue,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnmpMessage {
    pub version: i64,
    pub community: Vec<u8>,
    pub pdu_type: u8,
    pub request_id: i64,
    pub error_status: i64,
    pub error_index: i64,
    pub bindings: Vec<VarBind>,
}

#[derive(Clone, Copy)]
struct Tlv<'a> {
    tag: u8,
    value: &'a [u8],
}

fn tlv<'a>(buf: &'a [u8], pos: &mut usize, depth: usize) -> Result<Tlv<'a>, ParseError> {
    if depth > MAX_DEPTH {
        return Err(ParseError::Malformed);
    }
    let tag = *buf.get(*pos).ok_or(ParseError::Truncated)?;
    *pos += 1;
    let first = *buf.get(*pos).ok_or(ParseError::Truncated)?;
    *pos += 1;
    let len = if first & 0x80 == 0 {
        first as usize
    } else {
        let count = (first & 0x7f) as usize;
        if count == 0 || count > core::mem::size_of::<usize>() {
            return Err(ParseError::Malformed);
        }
        let bytes = buf.get(*pos..*pos + count).ok_or(ParseError::Truncated)?;
        if bytes[0] == 0 {
            return Err(ParseError::Malformed);
        }
        *pos += count;
        let mut n = 0usize;
        for &b in bytes {
            n = n
                .checked_mul(256)
                .and_then(|v| v.checked_add(b as usize))
                .ok_or(ParseError::Malformed)?;
        }
        if n < 128 {
            return Err(ParseError::Malformed);
        }
        n
    };
    let end = pos.checked_add(len).ok_or(ParseError::Malformed)?;
    let value = buf.get(*pos..end).ok_or(ParseError::Truncated)?;
    *pos = end;
    Ok(Tlv { tag, value })
}

fn integer(bytes: &[u8]) -> Result<i64, ParseError> {
    if bytes.is_empty() || bytes.len() > 8 {
        return Err(ParseError::Malformed);
    }
    if bytes.len() > 1
        && ((bytes[0] == 0 && bytes[1] & 0x80 == 0) || (bytes[0] == 0xff && bytes[1] & 0x80 != 0))
    {
        return Err(ParseError::Malformed);
    }
    let mut value = if bytes[0] & 0x80 != 0 { -1i64 } else { 0 };
    for &b in bytes {
        value = (value << 8) | i64::from(b);
    }
    Ok(value)
}

fn unsigned32(bytes: &[u8]) -> Result<u32, ParseError> {
    if bytes.is_empty()
        || bytes.len() > 5
        || bytes[0] & 0x80 != 0
        || (bytes.len() == 5 && bytes[0] != 0)
    {
        return Err(ParseError::Malformed);
    }
    let mut value = 0u32;
    for &b in bytes {
        value = value
            .checked_mul(256)
            .and_then(|v| v.checked_add(u32::from(b)))
            .ok_or(ParseError::Malformed)?;
    }
    Ok(value)
}

fn oid(bytes: &[u8]) -> Result<Vec<u32>, ParseError> {
    if bytes.is_empty() {
        return Err(ParseError::Malformed);
    }
    let mut subids = Vec::new();
    let mut value = 0u32;
    let mut open = false;
    for &b in bytes {
        open = true;
        value = value
            .checked_mul(128)
            .and_then(|v| v.checked_add(u32::from(b & 0x7f)))
            .ok_or(ParseError::Malformed)?;
        if b & 0x80 == 0 {
            subids.push(value);
            value = 0;
            open = false;
        }
    }
    if open {
        return Err(ParseError::Malformed);
    }
    let first = subids.remove(0);
    let arc0 = if first < 40 {
        0
    } else if first < 80 {
        1
    } else {
        2
    };
    let arc1 = first - arc0 * 40;
    let mut result = vec![arc0, arc1];
    result.extend(subids);
    Ok(result)
}

fn expect<'a>(
    buf: &'a [u8],
    pos: &mut usize,
    tag: u8,
    depth: usize,
) -> Result<&'a [u8], ParseError> {
    let item = tlv(buf, pos, depth)?;
    if item.tag != tag {
        return Err(ParseError::Malformed);
    }
    Ok(item.value)
}

fn parse_value(item: Tlv<'_>) -> Result<BerValue, ParseError> {
    Ok(match item.tag {
        0x02 => BerValue::Integer(integer(item.value)?),
        0x04 => BerValue::OctetString(item.value.to_vec()),
        0x05 if item.value.is_empty() => BerValue::Null,
        0x06 => BerValue::Oid(oid(item.value)?),
        0x41 => BerValue::Counter32(unsigned32(item.value)?),
        0x42 => BerValue::Gauge32(unsigned32(item.value)?),
        0x43 => BerValue::TimeTicks(unsigned32(item.value)?),
        _ => BerValue::Other {
            tag: item.tag,
            data: item.value.to_vec(),
        },
    })
}

pub fn parse(buf: &[u8]) -> Result<SnmpMessage, ParseError> {
    let mut outer_pos = 0;
    let outer = expect(buf, &mut outer_pos, 0x30, 1)?;
    if outer_pos != buf.len() {
        return Err(ParseError::Malformed);
    }
    let mut pos = 0;
    let version = integer(expect(outer, &mut pos, 0x02, 2)?)?;
    if version != 0 && version != 1 {
        return Err(ParseError::Malformed);
    }
    let community = expect(outer, &mut pos, 0x04, 2)?.to_vec();
    let pdu = tlv(outer, &mut pos, 2)?;
    if !(0xa0..=0xa8).contains(&pdu.tag) || pos != outer.len() {
        return Err(ParseError::Malformed);
    }
    let mut p = 0;
    let request_id = integer(expect(pdu.value, &mut p, 0x02, 3)?)?;
    let error_status = integer(expect(pdu.value, &mut p, 0x02, 3)?)?;
    let error_index = integer(expect(pdu.value, &mut p, 0x02, 3)?)?;
    let list = expect(pdu.value, &mut p, 0x30, 3)?;
    if p != pdu.value.len() {
        return Err(ParseError::Malformed);
    }
    let mut bindings = Vec::new();
    let mut lp = 0;
    while lp < list.len() {
        if bindings.len() == MAX_BINDINGS {
            return Err(ParseError::Malformed);
        }
        let binding = expect(list, &mut lp, 0x30, 4)?;
        let mut bp = 0;
        let name = oid(expect(binding, &mut bp, 0x06, 5)?)?;
        let value = parse_value(tlv(binding, &mut bp, 5)?)?;
        if bp != binding.len() {
            return Err(ParseError::Malformed);
        }
        bindings.push(VarBind { oid: name, value });
    }
    Ok(SnmpMessage {
        version,
        community,
        pdu_type: pdu.tag,
        request_id,
        error_status,
        error_index,
        bindings,
    })
}

pub fn pdu_type_name(tag: u8) -> &'static str {
    match tag {
        0xa0 => "GetRequest",
        0xa1 => "GetNextRequest",
        0xa2 => "GetResponse",
        0xa3 => "SetRequest",
        0xa4 => "TrapV1",
        0xa5 => "GetBulkRequest",
        0xa6 => "InformRequest",
        0xa7 => "TrapV2",
        0xa8 => "Report",
        _ => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const GET: &[u8] = &[
        0x30, 0x26, 0x02, 0x01, 0x01, 0x04, 0x06, b'p', b'u', b'b', b'l', b'i', b'c', 0xa0, 0x19,
        0x02, 0x01, 0x7b, 0x02, 0x01, 0, 0x02, 0x01, 0, 0x30, 0x0e, 0x30, 0x0c, 0x06, 0x08, 0x2b,
        0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0, 0x05, 0x00,
    ];
    #[test]
    fn exact_vector() {
        let m = parse(GET).unwrap();
        assert_eq!(m.version, 1);
        assert_eq!(m.community, b"public");
        assert_eq!(m.request_id, 123);
        assert_eq!(m.bindings[0].oid, vec![1, 3, 6, 1, 2, 1, 1, 1, 0]);
        assert_eq!(m.bindings[0].value, BerValue::Null);
    }
    #[test]
    fn prefixes_and_noise() {
        for n in 0..GET.len() {
            assert_eq!(parse(&GET[..n]), Err(ParseError::Truncated));
        }
        let mut x = 11u32;
        for n in 0..1024 {
            x = x.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            let v = vec![(x >> 16) as u8; n % 128];
            let _ = parse(&v);
        }
    }
}
