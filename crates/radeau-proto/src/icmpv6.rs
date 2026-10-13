//! ICMPv6, NDP, echo, redirect, and MLD codecs.

use crate::{internet_checksum, ParseError};

pub const HEADER_LEN: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Icmpv6Message<'a> {
    pub msg_type: u8,
    pub code: u8,
    pub checksum: u16,
    pub body: &'a [u8],
}

impl<'a> Icmpv6Message<'a> {
    pub fn parse(buf: &'a [u8]) -> Result<Self, ParseError> {
        let h = buf.get(..HEADER_LEN).ok_or(ParseError::Truncated)?;
        Ok(Self {
            msg_type: h[0],
            code: h[1],
            checksum: u16::from_be_bytes([h[2], h[3]]),
            body: &buf[HEADER_LEN..],
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NdpOption<'a> {
    pub kind: u8,
    pub offset: usize,
    pub len: usize,
    pub data: &'a [u8],
}

fn parse_options(bytes: &[u8]) -> Result<Vec<NdpOption<'_>>, ParseError> {
    let mut options = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        let h = bytes
            .get(offset..offset.saturating_add(2))
            .ok_or(ParseError::Truncated)?;
        if h[1] == 0 {
            return Err(ParseError::Malformed);
        }
        let len = (h[1] as usize)
            .checked_mul(8)
            .ok_or(ParseError::Malformed)?;
        let end = offset.checked_add(len).ok_or(ParseError::Malformed)?;
        let whole = bytes.get(offset..end).ok_or(ParseError::Truncated)?;
        options.push(NdpOption {
            kind: h[0],
            offset,
            len,
            data: &whole[2..],
        });
        offset = end;
    }
    Ok(options)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeighborSolicitation<'a> {
    pub target: [u8; 16],
    pub options: Vec<NdpOption<'a>>,
}

impl<'a> NeighborSolicitation<'a> {
    pub fn parse(body: &'a [u8]) -> Result<Self, ParseError> {
        let b = body.get(..20).ok_or(ParseError::Truncated)?;
        Ok(Self {
            target: b[4..20].try_into().expect("exact"),
            options: parse_options(&body[20..])?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeighborAdvertisement<'a> {
    pub router: bool,
    pub solicited: bool,
    pub override_flag: bool,
    pub target: [u8; 16],
    pub options: Vec<NdpOption<'a>>,
}

impl<'a> NeighborAdvertisement<'a> {
    pub fn parse(body: &'a [u8]) -> Result<Self, ParseError> {
        let b = body.get(..20).ok_or(ParseError::Truncated)?;
        Ok(Self {
            router: b[0] & 0x80 != 0,
            solicited: b[0] & 0x40 != 0,
            override_flag: b[0] & 0x20 != 0,
            target: b[4..20].try_into().expect("exact"),
            options: parse_options(&body[20..])?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterAdvertisement<'a> {
    pub cur_hop_limit: u8,
    pub managed: bool,
    pub other: bool,
    pub router_lifetime: u16,
    pub reachable_time: u32,
    pub retrans_timer: u32,
    pub options: Vec<NdpOption<'a>>,
}

impl<'a> RouterAdvertisement<'a> {
    pub fn parse(body: &'a [u8]) -> Result<Self, ParseError> {
        let b = body.get(..12).ok_or(ParseError::Truncated)?;
        Ok(Self {
            cur_hop_limit: b[0],
            managed: b[1] & 0x80 != 0,
            other: b[1] & 0x40 != 0,
            router_lifetime: u16::from_be_bytes([b[2], b[3]]),
            reachable_time: u32::from_be_bytes(b[4..8].try_into().expect("exact")),
            retrans_timer: u32::from_be_bytes(b[8..12].try_into().expect("exact")),
            options: parse_options(&body[12..])?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterSolicitation<'a> {
    pub options: Vec<NdpOption<'a>>,
}

impl<'a> RouterSolicitation<'a> {
    pub fn parse(body: &'a [u8]) -> Result<Self, ParseError> {
        body.get(..4).ok_or(ParseError::Truncated)?;
        Ok(Self {
            options: parse_options(&body[4..])?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Echo {
    pub identifier: u16,
    pub sequence: u16,
}

impl Echo {
    pub fn parse(body: &[u8]) -> Result<Self, ParseError> {
        let b = body.get(..4).ok_or(ParseError::Truncated)?;
        Ok(Self {
            identifier: u16::from_be_bytes([b[0], b[1]]),
            sequence: u16::from_be_bytes([b[2], b[3]]),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redirect<'a> {
    pub target: [u8; 16],
    pub destination: [u8; 16],
    pub options: Vec<NdpOption<'a>>,
}

impl<'a> Redirect<'a> {
    pub fn parse(body: &'a [u8]) -> Result<Self, ParseError> {
        let b = body.get(..36).ok_or(ParseError::Truncated)?;
        Ok(Self {
            target: b[4..20].try_into().expect("exact"),
            destination: b[20..36].try_into().expect("exact"),
            options: parse_options(&body[36..])?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MldQuery {
    pub max_response_delay: u16,
    pub multicast_address: [u8; 16],
}

impl MldQuery {
    pub fn parse(body: &[u8]) -> Result<Self, ParseError> {
        let b = body.get(..20).ok_or(ParseError::Truncated)?;
        Ok(Self {
            max_response_delay: u16::from_be_bytes([b[0], b[1]]),
            multicast_address: b[4..20].try_into().expect("exact"),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MldReport {
    pub multicast_address: [u8; 16],
}

impl MldReport {
    pub fn parse(body: &[u8]) -> Result<Self, ParseError> {
        let b = body.get(..20).ok_or(ParseError::Truncated)?;
        Ok(Self {
            multicast_address: b[4..20].try_into().expect("exact"),
        })
    }
}

pub fn type_name(t: u8) -> &'static str {
    match t {
        1 => "Destination Unreachable",
        2 => "Packet Too Big",
        3 => "Time Exceeded",
        4 => "Parameter Problem",
        128 => "Echo Request",
        129 => "Echo Reply",
        130 => "MLD Query",
        131 => "MLD Report",
        132 => "MLD Done",
        133 => "Router Solicitation",
        134 => "Router Advertisement",
        135 => "Neighbor Solicitation",
        136 => "Neighbor Advertisement",
        137 => "Redirect",
        143 => "MLDv2 Report",
        _ => "type n",
    }
}

pub fn ndp_option_name(kind: u8) -> &'static str {
    match kind {
        1 => "Source Link-Layer Address",
        2 => "Target Link-Layer Address",
        3 => "Prefix Information",
        4 => "Redirected Header",
        5 => "MTU",
        24 => "Route Information",
        25 => "RDNSS",
        31 => "DNSSL",
        _ => "option n",
    }
}

fn pseudo_header(src: &[u8; 16], dst: &[u8; 16], len: usize) -> [u8; 40] {
    let mut pseudo = [0u8; 40];
    pseudo[..16].copy_from_slice(src);
    pseudo[16..32].copy_from_slice(dst);
    pseudo[32..36].copy_from_slice(&(len as u32).to_be_bytes());
    pseudo[39] = 58;
    pseudo
}

pub fn checksum_ok(src: &[u8; 16], dst: &[u8; 16], bytes: &[u8]) -> bool {
    internet_checksum(&[&pseudo_header(src, dst, bytes.len()), bytes]) == 0
}

fn finish(src: [u8; 16], dst: [u8; 16], start: usize, out: &mut [u8]) {
    let bytes = &out[start..];
    let sum = internet_checksum(&[&pseudo_header(&src, &dst, bytes.len()), bytes]);
    out[start + 2..start + 4].copy_from_slice(&sum.to_be_bytes());
}

fn begin(msg_type: u8, out: &mut Vec<u8>) -> usize {
    let start = out.len();
    out.extend_from_slice(&[msg_type, 0, 0, 0]);
    start
}

pub fn build_router_solicitation(src: [u8; 16], dst: [u8; 16], options: &[u8], out: &mut Vec<u8>) {
    let start = begin(133, out);
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(options);
    finish(src, dst, start, out);
}

#[allow(clippy::too_many_arguments)]
pub fn build_router_advertisement(
    src: [u8; 16],
    dst: [u8; 16],
    cur_hop_limit: u8,
    managed: bool,
    other: bool,
    router_lifetime: u16,
    reachable_time: u32,
    retrans_timer: u32,
    options: &[u8],
    out: &mut Vec<u8>,
) {
    let start = begin(134, out);
    out.push(cur_hop_limit);
    out.push(u8::from(managed) << 7 | u8::from(other) << 6);
    out.extend_from_slice(&router_lifetime.to_be_bytes());
    out.extend_from_slice(&reachable_time.to_be_bytes());
    out.extend_from_slice(&retrans_timer.to_be_bytes());
    out.extend_from_slice(options);
    finish(src, dst, start, out);
}

pub fn build_neighbor_solicitation(
    src: [u8; 16],
    dst: [u8; 16],
    target: [u8; 16],
    options: &[u8],
    out: &mut Vec<u8>,
) {
    let start = begin(135, out);
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&target);
    out.extend_from_slice(options);
    finish(src, dst, start, out);
}

#[allow(clippy::too_many_arguments)]
pub fn build_neighbor_advertisement(
    src: [u8; 16],
    dst: [u8; 16],
    router: bool,
    solicited: bool,
    override_flag: bool,
    target: [u8; 16],
    options: &[u8],
    out: &mut Vec<u8>,
) {
    let start = begin(136, out);
    out.push(u8::from(router) << 7 | u8::from(solicited) << 6 | u8::from(override_flag) << 5);
    out.extend_from_slice(&[0; 3]);
    out.extend_from_slice(&target);
    out.extend_from_slice(options);
    finish(src, dst, start, out);
}

#[allow(clippy::too_many_arguments)]
pub fn build_echo(
    src: [u8; 16],
    dst: [u8; 16],
    msg_type: u8,
    identifier: u16,
    sequence: u16,
    payload: &[u8],
    out: &mut Vec<u8>,
) {
    let start = begin(msg_type, out);
    out.extend_from_slice(&identifier.to_be_bytes());
    out.extend_from_slice(&sequence.to_be_bytes());
    out.extend_from_slice(payload);
    finish(src, dst, start, out);
}

pub fn build_echo_request(
    src: [u8; 16],
    dst: [u8; 16],
    identifier: u16,
    sequence: u16,
    payload: &[u8],
    out: &mut Vec<u8>,
) {
    build_echo(src, dst, 128, identifier, sequence, payload, out);
}

pub fn build_echo_reply(
    src: [u8; 16],
    dst: [u8; 16],
    identifier: u16,
    sequence: u16,
    payload: &[u8],
    out: &mut Vec<u8>,
) {
    build_echo(src, dst, 129, identifier, sequence, payload, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: [u8; 16] = [0x11; 16];
    const DST: [u8; 16] = [0x22; 16];

    #[test]
    fn ns_byte_exact_parse_and_checksum() {
        let option = [1, 1, 0, 1, 2, 3, 4, 5];
        let mut wire = Vec::new();
        build_neighbor_solicitation(SRC, DST, [0xaa; 16], &option, &mut wire);
        assert_eq!(wire.len(), 32);
        assert_eq!(wire[0..4], [135, 0, 0x82, 0xac]);
        assert!(checksum_ok(&SRC, &DST, &wire));
        let msg = Icmpv6Message::parse(&wire).unwrap();
        let ns = NeighborSolicitation::parse(msg.body).unwrap();
        assert_eq!(ns.target, [0xaa; 16]);
        assert_eq!(ns.options[0].kind, 1);
        assert_eq!(ns.options[0].offset, 0);
        assert_eq!(ns.options[0].len, 8);
        assert_eq!(ns.options[0].data, &[0, 1, 2, 3, 4, 5]);
    }

    #[test]
    fn all_builders_decode() {
        let mut wire = Vec::new();
        build_router_solicitation(SRC, DST, &[], &mut wire);
        assert!(RouterSolicitation::parse(Icmpv6Message::parse(&wire).unwrap().body).is_ok());
        wire.clear();
        build_router_advertisement(SRC, DST, 64, true, false, 1800, 10, 20, &[], &mut wire);
        let ra = RouterAdvertisement::parse(Icmpv6Message::parse(&wire).unwrap().body).unwrap();
        assert_eq!(
            (ra.cur_hop_limit, ra.managed, ra.router_lifetime),
            (64, true, 1800)
        );
        wire.clear();
        build_neighbor_advertisement(SRC, DST, true, true, false, [3; 16], &[], &mut wire);
        let na = NeighborAdvertisement::parse(Icmpv6Message::parse(&wire).unwrap().body).unwrap();
        assert!(na.router && na.solicited && !na.override_flag);
        wire.clear();
        build_echo_request(SRC, DST, 0x1234, 2, &[9, 8, 7], &mut wire);
        assert!(checksum_ok(&SRC, &DST, &wire));
        assert_eq!(
            Echo::parse(Icmpv6Message::parse(&wire).unwrap().body).unwrap(),
            Echo {
                identifier: 0x1234,
                sequence: 2
            }
        );
    }

    #[test]
    fn option_errors_and_every_prefix_never_panic() {
        let mut wire = Vec::new();
        build_neighbor_solicitation(SRC, DST, [0xaa; 16], &[1, 1, 0, 1, 2, 3, 4, 5], &mut wire);
        for n in 0..wire.len() {
            if let Ok(msg) = Icmpv6Message::parse(&wire[..n]) {
                let _ = NeighborSolicitation::parse(msg.body);
            }
        }
        let mut bad = vec![0; 20];
        bad.extend_from_slice(&[1, 0]);
        assert_eq!(
            NeighborSolicitation::parse(&bad),
            Err(ParseError::Malformed)
        );
        let mut seed = 7u32;
        for len in 0..128 {
            let mut bytes = vec![0; len];
            for byte in &mut bytes {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                *byte = seed as u8;
            }
            if let Ok(msg) = Icmpv6Message::parse(&bytes) {
                let _ = NeighborSolicitation::parse(msg.body);
                let _ = NeighborAdvertisement::parse(msg.body);
                let _ = RouterAdvertisement::parse(msg.body);
                let _ = RouterSolicitation::parse(msg.body);
                let _ = Redirect::parse(msg.body);
                let _ = MldQuery::parse(msg.body);
            }
        }
    }

    #[test]
    fn names_are_stable() {
        assert_eq!(type_name(143), "MLDv2 Report");
        assert_eq!(type_name(42), "type n");
        assert_eq!(ndp_option_name(25), "RDNSS");
    }
}
