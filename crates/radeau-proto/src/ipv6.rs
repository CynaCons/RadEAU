//! IPv6 fixed-header codec with payload-length bounds.
use crate::ParseError;
pub const HEADER_LEN: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fragment {
    pub offset: u16,
    pub more: bool,
    pub id: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ipv6Ext {
    pub kind: u8,
    pub offset: usize,
    pub len: usize,
    pub fragment: Option<Fragment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ipv6Walk<'a> {
    pub final_next_header: u8,
    pub headers: Vec<Ipv6Ext>,
    pub payload_offset: usize,
    pub payload: &'a [u8],
}

/// Walks the IPv6 extension headers that have an unambiguous bounded size.
/// AH and ESP are deliberately left unconsumed for a named terminal layer.
pub fn walk_extensions(next_header: u8, payload: &[u8]) -> Result<Ipv6Walk<'_>, ParseError> {
    let mut kind = next_header;
    let mut offset = 0usize;
    let mut headers = Vec::new();
    loop {
        match kind {
            0 | 43 | 60 => {
                let prefix = payload
                    .get(offset..offset.saturating_add(2))
                    .ok_or(ParseError::Truncated)?;
                let len = (prefix[1] as usize + 1)
                    .checked_mul(8)
                    .ok_or(ParseError::Malformed)?;
                let end = offset.checked_add(len).ok_or(ParseError::Malformed)?;
                if end > payload.len() {
                    return Err(ParseError::Truncated);
                }
                headers.push(Ipv6Ext {
                    kind,
                    offset,
                    len,
                    fragment: None,
                });
                kind = prefix[0];
                offset = end;
            }
            44 => {
                let end = offset.checked_add(8).ok_or(ParseError::Malformed)?;
                let h = payload.get(offset..end).ok_or(ParseError::Truncated)?;
                let field = u16::from_be_bytes([h[2], h[3]]);
                headers.push(Ipv6Ext {
                    kind,
                    offset,
                    len: 8,
                    fragment: Some(Fragment {
                        offset: field >> 3,
                        more: field & 1 != 0,
                        id: u32::from_be_bytes(h[4..8].try_into().expect("exact")),
                    }),
                });
                kind = h[0];
                offset = end;
            }
            _ => break,
        }
    }
    Ok(Ipv6Walk {
        final_next_header: kind,
        headers,
        payload_offset: offset,
        payload: &payload[offset..],
    })
}

pub fn next_header_name(n: u8) -> &'static str {
    match n {
        6 => "TCP",
        17 => "UDP",
        58 => "ICMPv6",
        132 => "SCTP",
        44 => "Fragment",
        0 => "HopByHop",
        43 => "Routing",
        60 => "DestOpts",
        51 => "AH",
        50 => "ESP",
        59 => "NoNext",
        _ => "protocol n",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ipv6Packet<'a> {
    pub payload_length: u16,
    pub next_header: u8,
    pub hop_limit: u8,
    pub src: [u8; 16],
    pub dst: [u8; 16],
    pub payload: &'a [u8],
}
impl<'a> Ipv6Packet<'a> {
    pub fn parse(buf: &'a [u8]) -> Result<Self, ParseError> {
        let h = buf.get(..HEADER_LEN).ok_or(ParseError::Truncated)?;
        if h[0] >> 4 != 6 {
            return Err(ParseError::Malformed);
        }
        let n = u16::from_be_bytes([h[4], h[5]]) as usize;
        let end = HEADER_LEN.checked_add(n).ok_or(ParseError::Malformed)?;
        if buf.len() < end {
            return Err(ParseError::Truncated);
        }
        Ok(Self {
            payload_length: n as u16,
            next_header: h[6],
            hop_limit: h[7],
            src: h[8..24].try_into().expect("exact"),
            dst: h[24..40].try_into().expect("exact"),
            payload: &buf[40..end],
        })
    }
    pub fn build(
        src: [u8; 16],
        dst: [u8; 16],
        next_header: u8,
        hop_limit: u8,
        payload: &[u8],
        out: &mut Vec<u8>,
    ) {
        out.extend_from_slice(&0x6000_0000_u32.to_be_bytes());
        out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        out.push(next_header);
        out.push(hop_limit);
        out.extend_from_slice(&src);
        out.extend_from_slice(&dst);
        out.extend_from_slice(payload);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_and_prefixes() {
        let mut w = vec![];
        Ipv6Packet::build([1; 16], [2; 16], 58, 64, &[3, 4], &mut w);
        let p = Ipv6Packet::parse(&w).unwrap();
        assert_eq!(p.payload, &[3, 4]);
        for n in 0..w.len() {
            assert_eq!(
                Ipv6Packet::parse(&w[..n]).unwrap_err(),
                ParseError::Truncated
            );
        }
    }
    #[test]
    fn bad_version() {
        let mut w = vec![0; 40];
        assert_eq!(Ipv6Packet::parse(&w), Err(ParseError::Malformed));
        w[0] = 0x60;
        assert!(Ipv6Packet::parse(&w).is_ok());
    }

    #[test]
    fn walks_options_and_fragment_byte_exact() {
        let bytes = [
            44, 0, 1, 2, 3, 4, 5, 6, // hop-by-hop
            17, 0, 0, 0x09, 0x12, 0x34, 0x56, 0x78, // fragment offset 1, M
            0xaa, 0xbb,
        ];
        let walk = walk_extensions(0, &bytes).unwrap();
        assert_eq!(walk.final_next_header, 17);
        assert_eq!(walk.payload_offset, 16);
        assert_eq!(walk.payload, &[0xaa, 0xbb]);
        assert_eq!(walk.headers[0].offset, 0);
        assert_eq!(walk.headers[0].len, 8);
        assert_eq!(
            walk.headers[1].fragment,
            Some(Fragment {
                offset: 1,
                more: true,
                id: 0x1234_5678
            })
        );
    }

    #[test]
    fn ah_esp_and_unknown_are_not_consumed() {
        for kind in [51, 50, 6, 250] {
            let walk = walk_extensions(kind, &[1, 2, 3]).unwrap();
            assert_eq!(walk.final_next_header, kind);
            assert_eq!(walk.payload_offset, 0);
            assert_eq!(walk.headers, [] as [Ipv6Ext; 0]);
        }
    }

    #[test]
    fn bad_extension_lengths_and_prefixes_never_panic() {
        let bytes = [60, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
        for n in 0..bytes.len() {
            let _ = walk_extensions(0, &bytes[..n]);
        }
        assert_eq!(
            walk_extensions(0, &[6, 1, 0, 0, 0, 0, 0, 0]),
            Err(ParseError::Truncated)
        );
        let mut seed = 0x1234_5678u32;
        for len in 0..96 {
            let mut random = vec![0u8; len];
            for byte in &mut random {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *byte = seed as u8;
            }
            let _ = walk_extensions([0, 43, 44, 60][len % 4], &random);
        }
    }

    #[test]
    fn header_names() {
        assert_eq!(next_header_name(58), "ICMPv6");
        assert_eq!(next_header_name(222), "protocol n");
    }

    #[test]
    fn packet_random_prefixes_never_panic() {
        let mut seed = 0xc001_d00du32;
        for len in 0..128 {
            let mut bytes = vec![0; len];
            for byte in &mut bytes {
                seed = seed.rotate_left(5).wrapping_add(0x9e37_79b9);
                *byte = seed as u8;
            }
            let _ = Ipv6Packet::parse(&bytes);
        }
    }
}
