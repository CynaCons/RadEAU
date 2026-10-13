//! Bounded DHCPv4 and DHCPv6 codecs.

use crate::ParseError;

pub const PORTS_V4: (u16, u16) = (67, 68);
pub const PORTS_V6: (u16, u16) = (546, 547);
const V4_FIXED_LEN: usize = 240;
const MAX_OPTIONS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DhcpOption<'a> {
    pub code: u8,
    pub offset: usize,
    pub data: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dhcpv4<'a> {
    pub op: u8,
    pub htype: u8,
    pub hlen: u8,
    pub hops: u8,
    pub xid: u32,
    pub secs: u16,
    pub flags: u16,
    pub ciaddr: [u8; 4],
    pub yiaddr: [u8; 4],
    pub siaddr: [u8; 4],
    pub giaddr: [u8; 4],
    pub chaddr: [u8; 16],
    pub options: Vec<DhcpOption<'a>>,
    pub message_type: Option<u8>,
}

pub fn parse(buf: &[u8]) -> Result<Dhcpv4<'_>, ParseError> {
    let b = buf.get(..V4_FIXED_LEN).ok_or(ParseError::Truncated)?;
    if b[236..240] != [0x63, 0x82, 0x53, 0x63] || b[2] > 16 {
        return Err(ParseError::Malformed);
    }
    let mut options = Vec::new();
    let mut message_type = None;
    let mut pos = V4_FIXED_LEN;
    let mut ended = false;
    while pos < buf.len() {
        let offset = pos;
        let code = buf[pos];
        pos += 1;
        if code == 255 {
            ended = true;
            break;
        }
        if code == 0 {
            continue;
        }
        if options.len() == MAX_OPTIONS {
            return Err(ParseError::Malformed);
        }
        let len = *buf.get(pos).ok_or(ParseError::Truncated)? as usize;
        pos += 1;
        let data = buf
            .get(pos..pos.checked_add(len).ok_or(ParseError::Malformed)?)
            .ok_or(ParseError::Truncated)?;
        pos += len;
        if code == 53 {
            if len != 1 {
                return Err(ParseError::Malformed);
            }
            message_type = Some(data[0]);
        }
        options.push(DhcpOption { code, offset, data });
    }
    if !ended {
        return Err(ParseError::Truncated);
    }
    Ok(Dhcpv4 {
        op: b[0],
        htype: b[1],
        hlen: b[2],
        hops: b[3],
        xid: u32::from_be_bytes(b[4..8].try_into().expect("exact")),
        secs: u16::from_be_bytes([b[8], b[9]]),
        flags: u16::from_be_bytes([b[10], b[11]]),
        ciaddr: b[12..16].try_into().expect("exact"),
        yiaddr: b[16..20].try_into().expect("exact"),
        siaddr: b[20..24].try_into().expect("exact"),
        giaddr: b[24..28].try_into().expect("exact"),
        chaddr: b[28..44].try_into().expect("exact"),
        options,
        message_type,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dhcpv6Option<'a> {
    pub code: u16,
    pub offset: usize,
    pub data: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dhcpv6<'a> {
    pub msg_type: u8,
    pub transaction_id: u32,
    pub options: Vec<Dhcpv6Option<'a>>,
}

pub fn parse_v6(buf: &[u8]) -> Result<Dhcpv6<'_>, ParseError> {
    let h = buf.get(..4).ok_or(ParseError::Truncated)?;
    let mut pos = 4;
    let mut options = Vec::new();
    while pos < buf.len() {
        if options.len() == MAX_OPTIONS {
            return Err(ParseError::Malformed);
        }
        let offset = pos;
        let head = buf.get(pos..pos + 4).ok_or(ParseError::Truncated)?;
        let code = u16::from_be_bytes([head[0], head[1]]);
        let len = u16::from_be_bytes([head[2], head[3]]) as usize;
        pos += 4;
        let data = buf
            .get(pos..pos.checked_add(len).ok_or(ParseError::Malformed)?)
            .ok_or(ParseError::Truncated)?;
        pos += len;
        options.push(Dhcpv6Option { code, offset, data });
    }
    Ok(Dhcpv6 {
        msg_type: h[0],
        transaction_id: u32::from_be_bytes([0, h[1], h[2], h[3]]),
        options,
    })
}

pub fn message_type_name(t: u8) -> &'static str {
    match t {
        1 => "Discover",
        2 => "Offer",
        3 => "Request",
        4 => "Decline",
        5 => "Ack",
        6 => "Nak",
        7 => "Release",
        8 => "Inform",
        _ => "Unknown",
    }
}
pub fn option_name(code: u8) -> String {
    match code {
        1 => "Subnet Mask",
        3 => "Router",
        6 => "DNS",
        12 => "Host Name",
        50 => "Requested IP",
        51 => "Lease Time",
        53 => "Message Type",
        54 => "Server Identifier",
        55 => "Parameter Request List",
        58 => "Renewal",
        59 => "Rebinding",
        61 => "Client Identifier",
        _ => return format!("option {code}"),
    }
    .into()
}
pub fn v6_message_type_name(t: u8) -> &'static str {
    match t {
        1 => "Solicit",
        2 => "Advertise",
        3 => "Request",
        4 => "Confirm",
        5 => "Renew",
        6 => "Rebind",
        7 => "Reply",
        8 => "Release",
        9 => "Decline",
        10 => "Reconfigure",
        11 => "Information-request",
        _ => "Unknown",
    }
}
pub fn v6_option_name(code: u16) -> String {
    match code {
        1 => "Client Identifier",
        2 => "Server Identifier",
        3 => "IA_NA",
        5 => "IA Address",
        23 => "DNS Servers",
        24 => "Domain List",
        _ => return format!("option {code}"),
    }
    .into()
}

fn build_v4(
    op: u8,
    xid: u32,
    chaddr: [u8; 6],
    yiaddr: [u8; 4],
    options: &[(u8, &[u8])],
    out: &mut Vec<u8>,
) {
    out.extend_from_slice(&[op, 1, 6, 0]);
    out.extend_from_slice(&xid.to_be_bytes());
    out.extend_from_slice(&[0, 0, 0x80, 0]);
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&yiaddr);
    out.extend_from_slice(&[0; 8]);
    out.extend_from_slice(&chaddr);
    out.extend_from_slice(&[0; 10]);
    out.extend_from_slice(&[0; 64 + 128]);
    out.extend_from_slice(&[0x63, 0x82, 0x53, 0x63]);
    for (code, data) in options {
        if u8::try_from(data.len()).is_ok() {
            out.extend_from_slice(&[*code, data.len() as u8]);
            out.extend_from_slice(data);
        }
    }
    out.push(255);
}

pub fn build_discover(xid: u32, chaddr: [u8; 6], out: &mut Vec<u8>) {
    build_v4(
        1,
        xid,
        chaddr,
        [0; 4],
        &[(53, &[1]), (55, &[1, 3, 6, 51, 54])],
        out,
    );
}
pub fn build_offer(
    xid: u32,
    chaddr: [u8; 6],
    yiaddr: [u8; 4],
    server_id: [u8; 4],
    out: &mut Vec<u8>,
) {
    build_v4(2, xid, chaddr, yiaddr, &[(53, &[2]), (54, &server_id)], out);
}
pub fn build_solicit(transaction_id: u32, client_id: &[u8], out: &mut Vec<u8>) {
    out.push(1);
    let id = transaction_id.to_be_bytes();
    out.extend_from_slice(&id[1..]);
    out.extend_from_slice(&1u16.to_be_bytes());
    out.extend_from_slice(&(client_id.len() as u16).to_be_bytes());
    out.extend_from_slice(client_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vectors() {
        let mut d = Vec::new();
        build_discover(0x1234_5678, [0, 1, 2, 3, 4, 5], &mut d);
        assert_eq!(
            &d[..12],
            &[1, 1, 6, 0, 0x12, 0x34, 0x56, 0x78, 0, 0, 0x80, 0]
        );
        let p = parse(&d).unwrap();
        assert_eq!(p.message_type, Some(1));
        assert_eq!(p.chaddr[..6], [0, 1, 2, 3, 4, 5]);
        let mut o = Vec::new();
        build_offer(1, [1; 6], [10, 0, 0, 2], [10, 0, 0, 1], &mut o);
        assert_eq!(parse(&o).unwrap().yiaddr, [10, 0, 0, 2]);
        let mut s = Vec::new();
        build_solicit(0x0012_3456, &[0, 1, 2], &mut s);
        assert_eq!(s, [1, 0x12, 0x34, 0x56, 0, 1, 0, 3, 0, 1, 2]);
        assert_eq!(parse_v6(&s).unwrap().transaction_id, 0x0012_3456);
    }
    #[test]
    fn prefixes_and_noise() {
        let mut d = Vec::new();
        build_discover(1, [0; 6], &mut d);
        for n in 0..d.len() {
            assert_eq!(parse(&d[..n]), Err(ParseError::Truncated));
        }
        let mut s = Vec::new();
        build_solicit(1, &[1, 2], &mut s);
        // The 4-byte header alone is a complete option-less message; every
        // cut inside the header or inside an option must be Truncated.
        for n in 0..s.len() {
            let result = parse_v6(&s[..n]);
            if n == 4 {
                assert!(result.is_ok(), "header-only prefix is a valid message");
            } else {
                assert_eq!(result, Err(ParseError::Truncated), "prefix len {n}");
            }
        }
        let mut x = 9u32;
        for n in 0..1024 {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let v = vec![(x >> 24) as u8; n % 300];
            let _ = parse(&v);
            let _ = parse_v6(&v);
        }
    }
    #[test]
    fn malformed_cookie_and_option() {
        let mut d = Vec::new();
        build_discover(1, [0; 6], &mut d);
        d[236] = 0;
        assert_eq!(parse(&d), Err(ParseError::Malformed));
        let mut d = vec![0; 240];
        d[236..240].copy_from_slice(&[0x63, 0x82, 0x53, 0x63]);
        d.extend_from_slice(&[53, 2, 1]);
        assert_eq!(parse(&d), Err(ParseError::Truncated));
    }
}
