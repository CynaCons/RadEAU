//! Bounded TCP header codec; options are length-skipped.
use crate::ParseError;
pub const MIN_HEADER_LEN: usize = 20;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TcpSegment<'a> {
    pub src_port: u16,
    pub dst_port: u16,
    pub seq: u32,
    pub ack: u32,
    pub data_offset: u8,
    pub flags: u16,
    pub window: u16,
    pub payload: &'a [u8],
}
impl<'a> TcpSegment<'a> {
    pub fn parse(buf: &'a [u8]) -> Result<Self, ParseError> {
        let h = buf.get(..MIN_HEADER_LEN).ok_or(ParseError::Truncated)?;
        let off = h[12] >> 4;
        if off < 5 {
            return Err(ParseError::Malformed);
        }
        let len = off as usize * 4;
        if buf.len() < len {
            return Err(ParseError::Truncated);
        }
        Ok(Self {
            src_port: u16::from_be_bytes([h[0], h[1]]),
            dst_port: u16::from_be_bytes([h[2], h[3]]),
            seq: u32::from_be_bytes(h[4..8].try_into().expect("exact")),
            ack: u32::from_be_bytes(h[8..12].try_into().expect("exact")),
            data_offset: off,
            flags: ((h[12] as u16 & 1) << 8) | h[13] as u16,
            window: u16::from_be_bytes([h[14], h[15]]),
            payload: &buf[len..],
        })
    }
    pub fn syn(&self) -> bool {
        self.flags & 0x002 != 0
    }
    pub fn ack_flag(&self) -> bool {
        self.flags & 0x010 != 0
    }
    pub fn fin(&self) -> bool {
        self.flags & 0x001 != 0
    }
    pub fn rst(&self) -> bool {
        self.flags & 0x004 != 0
    }
    pub fn psh(&self) -> bool {
        self.flags & 0x008 != 0
    }
    pub fn build(
        src_port: u16,
        dst_port: u16,
        seq: u32,
        ack: u32,
        flags: u16,
        window: u16,
        payload: &[u8],
        out: &mut Vec<u8>,
    ) {
        out.extend_from_slice(&src_port.to_be_bytes());
        out.extend_from_slice(&dst_port.to_be_bytes());
        out.extend_from_slice(&seq.to_be_bytes());
        out.extend_from_slice(&ack.to_be_bytes());
        out.push(0x50 | ((flags >> 8) as u8 & 1));
        out.push(flags as u8);
        out.extend_from_slice(&window.to_be_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(payload);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_and_prefixes() {
        let mut w = vec![];
        TcpSegment::build(1, 2, 3, 4, 0x1b, 1024, &[9], &mut w);
        let s = TcpSegment::parse(&w).unwrap();
        assert!(s.syn() && s.ack_flag() && s.fin() && s.psh() && !s.rst());
        assert_eq!(s.payload, &[9]);
        for n in 0..MIN_HEADER_LEN {
            assert_eq!(
                TcpSegment::parse(&w[..n]).unwrap_err(),
                ParseError::Truncated
            )
        }
    }
    #[test]
    fn short_offset_malformed() {
        let mut w = vec![0; 20];
        w[12] = 0x40;
        assert_eq!(TcpSegment::parse(&w), Err(ParseError::Malformed));
    }
}
