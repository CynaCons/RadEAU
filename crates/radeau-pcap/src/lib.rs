//! Bounded, incremental pcap/pcapng parsing without libpcap (CP-002, CP-009).

use std::fmt;
use std::io::{self, Write};

pub const DIR_TX: u8 = 0;
pub const DIR_RX: u8 = 1;
pub const DIR_UNKNOWN: u8 = 2;
pub const MAX_RECORD_LEN: usize = 256 * 1024;
// Enough for the largest supported packet plus its EPB fixed header/trailer.
// Options are intentionally bounded by this same allowance.
const BLOCK_HEADER_LEN: usize = 32;
const MAX_BUFFER_LEN: usize = MAX_RECORD_LEN + BLOCK_HEADER_LEN;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub ts_ns: u64,
    pub dir: u8,
    pub interface: u16,
    pub caplen_truncated: bool,
    /// True only for pcapng Simple Packet Blocks, which carry no timestamp.
    /// In that case `ts_ns` is the preceding packet timestamp (or zero when
    /// there is no preceding packet).
    pub ts_reused: bool,
    pub wire: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PcapError {
    Invalid(String),
    UnsupportedLinkType(u16),
    Ended { cut: bool },
    Io(String),
}
impl fmt::Display for PcapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(s) => write!(f, "invalid capture: {s}"),
            Self::UnsupportedLinkType(n) => write!(f, "unsupported link type {n}"),
            Self::Ended { cut } => {
                write!(f, "capture ended{}", if *cut { " (truncated)" } else { "" })
            }
            Self::Io(s) => write!(f, "I/O: {s}"),
        }
    }
}
impl std::error::Error for PcapError {}

#[derive(Debug, Clone, Copy)]
enum Endian {
    Little,
    Big,
}
impl Endian {
    fn u16(self, b: &[u8]) -> u16 {
        let a = [b[0], b[1]];
        match self {
            Self::Little => u16::from_le_bytes(a),
            Self::Big => u16::from_be_bytes(a),
        }
    }
    fn u32(self, b: &[u8]) -> u32 {
        let a = [b[0], b[1], b[2], b[3]];
        match self {
            Self::Little => u32::from_le_bytes(a),
            Self::Big => u32::from_be_bytes(a),
        }
    }
}

#[derive(Debug, Clone)]
struct Interface {
    snaplen: u32,
    units_per_second: u64,
    #[allow(dead_code)]
    name: Option<String>,
}
#[derive(Debug)]
enum Format {
    Unknown,
    Classic {
        endian: Endian,
        nanos: bool,
        snaplen: u32,
    },
    Ng {
        endian: Endian,
        interfaces: Vec<Interface>,
    },
}

#[derive(Debug)]
pub struct PcapReader {
    buf: Vec<u8>,
    offset: usize,
    format: Format,
    finished: bool,
    last_ts: Option<u64>,
    skip_remaining: usize,
    input_cut: bool,
}
impl Default for PcapReader {
    fn default() -> Self {
        Self::new()
    }
}
impl PcapReader {
    pub fn new() -> Self {
        Self {
            buf: Vec::new(),
            offset: 0,
            format: Format::Unknown,
            finished: false,
            last_ts: None,
            skip_remaining: 0,
            input_cut: false,
        }
    }
    pub fn push(&mut self, mut bytes: &[u8]) {
        let skipped = bytes.len().min(self.skip_remaining);
        self.skip_remaining -= skipped;
        bytes = &bytes[skipped..];
        if self.offset > 0 {
            self.buf.drain(..self.offset);
            self.offset = 0;
        }
        let room = MAX_BUFFER_LEN.saturating_sub(self.buf.len());
        self.buf.extend_from_slice(&bytes[..bytes.len().min(room)]);
        self.input_cut |= bytes.len() > room;
    }
    pub fn finish(&mut self) {
        self.finished = true;
    }
    fn available(&self) -> &[u8] {
        &self.buf[self.offset..]
    }
    fn need(&self) -> Result<Option<Record>, PcapError> {
        if self.input_cut
            || (self.finished && (self.skip_remaining > 0 || !self.available().is_empty()))
        {
            Err(PcapError::Ended { cut: true })
        } else if self.finished {
            Err(PcapError::Ended { cut: false })
        } else {
            Ok(None)
        }
    }
    pub fn next_record(&mut self) -> Result<Option<Record>, PcapError> {
        loop {
            match &self.format {
                Format::Unknown => {
                    if self.available().len() < 4 {
                        return self.need();
                    }
                    let magic = &self.available()[..4];
                    let (endian, nanos, ng) = match magic {
                        [0xd4, 0xc3, 0xb2, 0xa1] => (Endian::Little, false, false),
                        [0xa1, 0xb2, 0xc3, 0xd4] => (Endian::Big, false, false),
                        [0x4d, 0x3c, 0xb2, 0xa1] => (Endian::Little, true, false),
                        [0xa1, 0xb2, 0x3c, 0x4d] => (Endian::Big, true, false),
                        [0x0a, 0x0d, 0x0d, 0x0a] => (Endian::Little, false, true),
                        _ => return Err(PcapError::Invalid("unrecognized magic".into())),
                    };
                    if ng {
                        if self.available().len() < 12 {
                            return self.need();
                        }
                        let bom = &self.available()[8..12];
                        let endian = match bom {
                            [0x4d, 0x3c, 0x2b, 0x1a] => Endian::Little,
                            [0x1a, 0x2b, 0x3c, 0x4d] => Endian::Big,
                            _ => return Err(PcapError::Invalid("pcapng byte-order magic".into())),
                        };
                        self.format = Format::Ng {
                            endian,
                            interfaces: Vec::new(),
                        };
                    } else {
                        if self.available().len() < 24 {
                            return self.need();
                        }
                        let h = self.available();
                        if endian.u16(&h[4..6]) != 2 {
                            return Err(PcapError::Invalid("classic version".into()));
                        }
                        let snaplen = endian.u32(&h[16..20]);
                        let link = endian.u32(&h[20..24]) as u16;
                        if link != 1 {
                            return Err(PcapError::UnsupportedLinkType(link));
                        }
                        self.offset += 24;
                        self.format = Format::Classic {
                            endian,
                            nanos,
                            snaplen,
                        };
                    }
                }
                Format::Classic {
                    endian,
                    nanos,
                    snaplen,
                } => {
                    let endian = *endian;
                    let nanos = *nanos;
                    let snaplen = *snaplen;
                    if self.available().len() < 16 {
                        return self.need();
                    }
                    let h = self.available();
                    let sec = u64::from(endian.u32(&h[0..4]));
                    let frac = u64::from(endian.u32(&h[4..8]));
                    let cap = endian.u32(&h[8..12]) as usize;
                    let orig = endian.u32(&h[12..16]) as usize;
                    if cap > MAX_RECORD_LEN {
                        return Err(PcapError::Ended { cut: true });
                    }
                    if self.available().len() < 16 + cap {
                        return self.need();
                    }
                    let ts_ns = sec.saturating_mul(1_000_000_000).saturating_add(if nanos {
                        frac
                    } else {
                        frac.saturating_mul(1_000)
                    });
                    let wire = self.available()[16..16 + cap].to_vec();
                    self.offset += 16 + cap;
                    self.last_ts = Some(ts_ns);
                    return Ok(Some(Record {
                        ts_ns,
                        dir: DIR_UNKNOWN,
                        interface: 0,
                        caplen_truncated: cap < orig || cap as u32 > snaplen,
                        ts_reused: false,
                        wire,
                    }));
                }
                Format::Ng { endian, .. } => {
                    let mut endian = *endian;
                    if self.available().len() < 12 {
                        return self.need();
                    }
                    let b = self.available();
                    let is_shb = b[..4] == [0x0a, 0x0d, 0x0d, 0x0a];
                    if is_shb {
                        endian = match &b[8..12] {
                            [0x4d, 0x3c, 0x2b, 0x1a] => Endian::Little,
                            [0x1a, 0x2b, 0x3c, 0x4d] => Endian::Big,
                            _ => return Err(PcapError::Invalid("pcapng byte-order magic".into())),
                        };
                    }
                    let kind = if is_shb {
                        0x0a0d_0d0a
                    } else {
                        endian.u32(&b[0..4])
                    };
                    let len = endian.u32(&b[4..8]) as usize;
                    if len < 12 || !len.is_multiple_of(4) {
                        return Err(PcapError::Invalid(format!("pcapng block length {len}")));
                    }
                    if !matches!(kind, 0x0a0d_0d0a | 1 | 3 | 6) && len > MAX_BUFFER_LEN {
                        let consumed = self.available().len().min(len);
                        self.offset += consumed;
                        self.skip_remaining = len - consumed;
                        if self.skip_remaining > 0 {
                            return self.need();
                        }
                        continue;
                    }
                    if len > MAX_BUFFER_LEN {
                        return Err(PcapError::Ended { cut: true });
                    }
                    if b.len() < len {
                        return self.need();
                    }
                    if endian.u32(&b[len - 4..len]) as usize != len {
                        return Err(PcapError::Invalid("pcapng trailing block length".into()));
                    }
                    let block = b[..len].to_vec();
                    self.offset += len;
                    match kind {
                        0x0a0d_0d0a => {
                            if len < 28 {
                                return Err(PcapError::Invalid("short section header".into()));
                            }
                            let next_endian = endian;
                            self.format = Format::Ng {
                                endian: next_endian,
                                interfaces: Vec::new(),
                            };
                        }
                        1 => {
                            if len < 20 {
                                return Err(PcapError::Invalid("short IDB".into()));
                            }
                            let link = endian.u16(&block[8..10]);
                            if link != 1 {
                                return Err(PcapError::UnsupportedLinkType(link));
                            }
                            let snaplen = endian.u32(&block[12..16]);
                            let mut units = 1_000_000u64;
                            let mut name = None;
                            for (code, value) in options(&block[16..len - 4], endian)? {
                                match code {
                                    2 => name = Some(String::from_utf8_lossy(value).into_owned()),
                                    9 if !value.is_empty() => {
                                        let r = value[0];
                                        units = if r & 0x80 == 0 {
                                            10u64.checked_pow(u32::from(r)).unwrap_or(u64::MAX)
                                        } else {
                                            1u64.checked_shl(u32::from(r & 0x7f))
                                                .unwrap_or(u64::MAX)
                                        };
                                    }
                                    _ => {}
                                }
                            }
                            if let Format::Ng { interfaces, .. } = &mut self.format {
                                interfaces.push(Interface {
                                    snaplen,
                                    units_per_second: units.max(1),
                                    name,
                                });
                            }
                        }
                        6 => {
                            if len < 32 {
                                return Err(PcapError::Invalid("short EPB".into()));
                            }
                            let iface = endian.u32(&block[8..12]) as usize;
                            if iface > u16::MAX as usize {
                                return Err(PcapError::Invalid(format!(
                                    "interface id {iface} exceeds u16"
                                )));
                            }
                            let ticks = (u64::from(endian.u32(&block[12..16])) << 32)
                                | u64::from(endian.u32(&block[16..20]));
                            let cap = endian.u32(&block[20..24]) as usize;
                            let orig = endian.u32(&block[24..28]) as usize;
                            if cap > MAX_RECORD_LEN {
                                return Err(PcapError::Ended { cut: true });
                            }
                            let padded = (cap + 3) & !3;
                            if 28 + padded + 4 > len {
                                return Err(PcapError::Ended { cut: true });
                            }
                            let (snaplen, units) = match &self.format {
                                Format::Ng { interfaces, .. } => interfaces
                                    .get(iface)
                                    .map(|i| (i.snaplen, i.units_per_second))
                                    .ok_or_else(|| {
                                        PcapError::Invalid(format!("unknown interface {iface}"))
                                    })?,
                                _ => unreachable!(),
                            };
                            let mut dir = DIR_UNKNOWN;
                            for (code, value) in options(&block[28 + padded..len - 4], endian)? {
                                if code == 2 && value.len() >= 4 {
                                    dir = match endian.u32(value) & 3 {
                                        1 => DIR_RX,
                                        2 => DIR_TX,
                                        _ => DIR_UNKNOWN,
                                    };
                                }
                            }
                            let ts_ns = ((u128::from(ticks) * 1_000_000_000u128)
                                / u128::from(units))
                            .min(u128::from(u64::MAX))
                                as u64;
                            let wire = block[28..28 + cap].to_vec();
                            self.last_ts = Some(ts_ns);
                            return Ok(Some(Record {
                                ts_ns,
                                dir,
                                interface: iface as u16,
                                caplen_truncated: cap < orig || cap as u32 > snaplen,
                                ts_reused: false,
                                wire,
                            }));
                        }
                        3 => {
                            if len < 16 {
                                return Err(PcapError::Invalid("short SPB".into()));
                            }
                            let orig = endian.u32(&block[8..12]) as usize;
                            let data_area = len - 16;
                            let snaplen = match &self.format {
                                Format::Ng { interfaces, .. } => interfaces
                                    .first()
                                    .map(|i| i.snaplen as usize)
                                    .ok_or_else(|| {
                                        PcapError::Invalid(
                                            "SPB before interface description".into(),
                                        )
                                    })?,
                                _ => unreachable!(),
                            };
                            let cap = orig.min(snaplen);
                            if cap > MAX_RECORD_LEN {
                                return Err(PcapError::Ended { cut: true });
                            }
                            let padded = cap
                                .checked_add(3)
                                .map(|n| n & !3)
                                .ok_or(PcapError::Ended { cut: true })?;
                            if padded != data_area {
                                return Err(PcapError::Ended { cut: true });
                            }
                            return Ok(Some(Record {
                                ts_ns: self.last_ts.unwrap_or(0),
                                dir: DIR_UNKNOWN,
                                interface: 0,
                                caplen_truncated: cap < orig,
                                ts_reused: true,
                                wire: block[12..12 + cap].to_vec(),
                            }));
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

fn options(mut bytes: &[u8], endian: Endian) -> Result<Vec<(u16, &[u8])>, PcapError> {
    let mut out = Vec::new();
    while bytes.len() >= 4 {
        let code = endian.u16(&bytes[..2]);
        let len = endian.u16(&bytes[2..4]) as usize;
        bytes = &bytes[4..];
        if code == 0 {
            break;
        }
        if len > bytes.len() {
            return Err(PcapError::Invalid("cut option".into()));
        }
        out.push((code, &bytes[..len]));
        let padded = (len + 3) & !3;
        if padded > bytes.len() {
            return Err(PcapError::Invalid("cut option padding".into()));
        }
        bytes = &bytes[padded..];
    }
    Ok(out)
}

pub struct PcapWriter<W: Write> {
    inner: W,
}
impl<W: Write> PcapWriter<W> {
    pub fn new(mut inner: W) -> io::Result<Self> {
        // CP-006 and CP-014: all exported/recorded files are classic ns pcap, link type 1.
        inner.write_all(&[0x4d, 0x3c, 0xb2, 0xa1])?;
        inner.write_all(&2u16.to_le_bytes())?;
        inner.write_all(&4u16.to_le_bytes())?;
        inner.write_all(&0i32.to_le_bytes())?;
        inner.write_all(&0u32.to_le_bytes())?;
        inner.write_all(&65535u32.to_le_bytes())?;
        inner.write_all(&1u32.to_le_bytes())?;
        Ok(Self { inner })
    }
    pub fn write_record(&mut self, ts_ns: u64, wire: &[u8]) -> io::Result<()> {
        if wire.len() > 65_535 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "record exceeds writer snaplen 65535",
            ));
        }
        self.inner.write_all(
            &(ts_ns / 1_000_000_000)
                .min(u64::from(u32::MAX))
                .to_le_bytes()[..4],
        )?;
        self.inner
            .write_all(&((ts_ns % 1_000_000_000) as u32).to_le_bytes())?;
        let len = wire.len() as u32;
        self.inner.write_all(&len.to_le_bytes())?;
        self.inner.write_all(&len.to_le_bytes())?;
        self.inner.write_all(wire)
    }
    pub fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
    pub fn into_inner(self) -> W {
        self.inner
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_all_chunked(data: &[u8], chunk: usize) -> Result<Vec<Record>, PcapError> {
        let mut r = PcapReader::new();
        let mut out = Vec::new();
        for c in data.chunks(chunk) {
            r.push(c);
            while let Some(x) = r.next_record()? {
                out.push(x);
            }
        }
        r.finish();
        loop {
            match r.next_record() {
                Ok(Some(x)) => out.push(x),
                Err(PcapError::Ended { cut: false }) => break,
                Err(e) => return Err(e),
                Ok(None) => unreachable!(),
            }
        }
        Ok(out)
    }

    fn read_all(data: &[u8]) -> Result<Vec<Record>, PcapError> {
        read_all_chunked(data, 7)
    }

    fn put16(out: &mut Vec<u8>, endian: Endian, value: u16) {
        out.extend(match endian {
            Endian::Little => value.to_le_bytes(),
            Endian::Big => value.to_be_bytes(),
        });
    }

    fn put32(out: &mut Vec<u8>, endian: Endian, value: u32) {
        out.extend(match endian {
            Endian::Little => value.to_le_bytes(),
            Endian::Big => value.to_be_bytes(),
        });
    }

    fn option(out: &mut Vec<u8>, endian: Endian, code: u16, value: &[u8]) {
        put16(out, endian, code);
        put16(out, endian, value.len() as u16);
        out.extend(value);
        out.resize((out.len() + 3) & !3, 0);
    }

    fn block(endian: Endian, kind: u32, body: &[u8]) -> Vec<u8> {
        let len = (12 + body.len()) as u32;
        assert_eq!(len % 4, 0);
        let mut out = Vec::new();
        put32(&mut out, endian, kind);
        put32(&mut out, endian, len);
        out.extend(body);
        put32(&mut out, endian, len);
        out
    }

    fn shb(endian: Endian) -> Vec<u8> {
        let mut body = Vec::new();
        put32(&mut body, endian, 0x1a2b_3c4d);
        put16(&mut body, endian, 1);
        put16(&mut body, endian, 0);
        match endian {
            Endian::Little => body.extend((-1i64).to_le_bytes()),
            Endian::Big => body.extend((-1i64).to_be_bytes()),
        }
        block(endian, 0x0a0d_0d0a, &body)
    }

    fn idb(endian: Endian, snaplen: u32, resolution: u8, name: &str) -> Vec<u8> {
        let mut body = Vec::new();
        put16(&mut body, endian, 1);
        put16(&mut body, endian, 0);
        put32(&mut body, endian, snaplen);
        option(&mut body, endian, 2, name.as_bytes());
        option(&mut body, endian, 9, &[resolution]);
        option(&mut body, endian, 0, &[]);
        block(endian, 1, &body)
    }

    fn epb(
        endian: Endian,
        interface: u32,
        ticks: u64,
        wire: &[u8],
        original: u32,
        flags: Option<u32>,
    ) -> Vec<u8> {
        let mut body = Vec::new();
        put32(&mut body, endian, interface);
        put32(&mut body, endian, (ticks >> 32) as u32);
        put32(&mut body, endian, ticks as u32);
        put32(&mut body, endian, wire.len() as u32);
        put32(&mut body, endian, original);
        body.extend(wire);
        body.resize((body.len() + 3) & !3, 0);
        if let Some(flags) = flags {
            let value = match endian {
                Endian::Little => flags.to_le_bytes(),
                Endian::Big => flags.to_be_bytes(),
            };
            option(&mut body, endian, 2, &value);
        }
        option(&mut body, endian, 0, &[]);
        block(endian, 6, &body)
    }

    fn spb(endian: Endian, wire: &[u8], original: u32) -> Vec<u8> {
        let mut body = Vec::new();
        put32(&mut body, endian, original);
        body.extend(wire);
        body.resize((body.len() + 3) & !3, 0);
        block(endian, 3, &body)
    }

    fn classic(
        endian: Endian,
        nanos: bool,
        link: u32,
        records: &[(u32, u32, &[u8], u32)],
    ) -> Vec<u8> {
        let mut out = match (endian, nanos) {
            (Endian::Little, false) => vec![0xd4, 0xc3, 0xb2, 0xa1],
            (Endian::Big, false) => vec![0xa1, 0xb2, 0xc3, 0xd4],
            (Endian::Little, true) => vec![0x4d, 0x3c, 0xb2, 0xa1],
            (Endian::Big, true) => vec![0xa1, 0xb2, 0x3c, 0x4d],
        };
        put16(&mut out, endian, 2);
        put16(&mut out, endian, 4);
        put32(&mut out, endian, 0);
        put32(&mut out, endian, 0);
        put32(&mut out, endian, 65_535);
        put32(&mut out, endian, link);
        for &(seconds, fraction, wire, original) in records {
            put32(&mut out, endian, seconds);
            put32(&mut out, endian, fraction);
            put32(&mut out, endian, wire.len() as u32);
            put32(&mut out, endian, original);
            out.extend(wire);
        }
        out
    }

    #[test]
    fn writer_reader_roundtrip() {
        // CP-006: pcap writer output reads back byte-for-byte through the same parser.
        let frames = [b"abc".as_slice(), b"defgh".as_slice()];
        let mut w = PcapWriter::new(Vec::new()).unwrap();
        w.write_record(1_700_000_000_123_456_789, frames[0])
            .unwrap();
        w.write_record(1_700_000_001_000_000_007, frames[1])
            .unwrap();
        let data = w.into_inner();
        let r = read_all(&data).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(
            r.iter().map(|x| x.wire.as_slice()).collect::<Vec<_>>(),
            frames
        );
        assert_eq!(
            r.iter().map(|x| x.ts_ns).collect::<Vec<_>>(),
            [1_700_000_000_123_456_789, 1_700_000_001_000_000_007]
        );
        assert_eq!(r[0].dir, DIR_UNKNOWN);
        assert!(!r[0].ts_reused);
    }

    #[test]
    fn classic_all_magics_and_byte_orders() {
        // CP-002: classic pcap supports both byte orders and µs/ns magic values.
        for endian in [Endian::Little, Endian::Big] {
            for nanos in [false, true] {
                let d = classic(endian, nanos, 1, &[(10, 123_456, b"abc", 4)]);
                let r = read_all(&d).unwrap();
                assert_eq!(
                    r[0].ts_ns,
                    if nanos {
                        10_000_123_456
                    } else {
                        10_123_456_000
                    }
                );
                assert!(r[0].caplen_truncated);
            }
        }
    }

    #[test]
    fn pcapng_endian_interfaces_resolutions_directions_and_spb() {
        // CP-002 and CP-009: pcapng byte order, if_tsresol, EPB direction, and SPB reuse.
        for endian in [Endian::Little, Endian::Big] {
            let mut d = shb(endian);
            d.extend(idb(endian, 4, 6, "camera"));
            d.extend(idb(endian, 65_535, 0x8a, "radar"));
            d.extend(epb(endian, 0, 1_500_000, b"abcd", 5, Some(1)));
            d.extend(epb(endian, 1, 1024, b"ef", 2, Some(2)));
            d.extend(epb(endian, 1, 2048, b"gh", 2, Some(3)));
            d.extend(spb(endian, b"ijk", 3));
            let r = read_all(&d).unwrap();
            assert_eq!(r.len(), 4);
            assert_eq!(
                (r[0].interface, r[0].ts_ns, r[0].dir),
                (0, 1_500_000_000, DIR_RX)
            );
            assert!(r[0].caplen_truncated);
            assert_eq!(
                (r[1].interface, r[1].ts_ns, r[1].dir),
                (1, 1_000_000_000, DIR_TX)
            );
            assert_eq!(r[2].dir, DIR_UNKNOWN);
            assert_eq!(r[3].ts_ns, r[2].ts_ns);
            assert!(r[3].ts_reused);
            assert!(!r[3].caplen_truncated);
        }
    }

    #[test]
    fn pcapng_section_can_switch_byte_order() {
        let mut d = shb(Endian::Little);
        d.extend(idb(Endian::Little, 65_535, 9, "le"));
        d.extend(epb(Endian::Little, 0, 7, b"a", 1, None));
        d.extend(shb(Endian::Big));
        d.extend(idb(Endian::Big, 65_535, 9, "be"));
        d.extend(epb(Endian::Big, 0, 8, b"b", 1, None));
        let r = read_all(&d).unwrap();
        assert_eq!(
            r.iter().map(|x| x.wire.as_slice()).collect::<Vec<_>>(),
            [b"a", b"b"]
        );
    }

    #[test]
    fn unknown_blocks_are_stream_skipped_with_bounded_buffer() {
        let mut r = PcapReader::new();
        let mut prefix = shb(Endian::Little);
        prefix.extend(idb(Endian::Little, 65_535, 9, "eth0"));
        r.push(&prefix);
        assert_eq!(r.next_record().unwrap(), None);

        let large_len = MAX_BUFFER_LEN + 4096;
        let mut header = Vec::new();
        put32(&mut header, Endian::Little, 0x1234_5678);
        put32(&mut header, Endian::Little, large_len as u32);
        header.extend([0; 4]);
        r.push(&header);
        assert_eq!(r.next_record().unwrap(), None);
        assert!(r.buf.len() <= MAX_BUFFER_LEN);
        for zeros in vec![0u8; large_len - 12].chunks(8192) {
            r.push(zeros);
            assert!(r.buf.len() <= MAX_BUFFER_LEN);
        }
        let packet = epb(Endian::Little, 0, 1, b"after", 5, None);
        r.push(&packet);
        assert_eq!(r.next_record().unwrap().unwrap().wire, b"after");
        r.finish();
        assert_eq!(r.next_record(), Err(PcapError::Ended { cut: false }));
    }

    #[test]
    fn unsupported_links_and_oversized_records_are_diagnosed() {
        // CP-002: unsupported link types and oversized records refuse cleanly.
        assert_eq!(
            read_all(&classic(Endian::Little, false, 113, &[])),
            Err(PcapError::UnsupportedLinkType(113))
        );
        let mut ng = shb(Endian::Little);
        let mut bad_idb = idb(Endian::Little, 65_535, 6, "sll");
        bad_idb[8..10].copy_from_slice(&276u16.to_le_bytes());
        ng.extend(bad_idb);
        assert_eq!(read_all(&ng), Err(PcapError::UnsupportedLinkType(276)));

        let mut d = classic(Endian::Little, true, 1, &[]);
        put32(&mut d, Endian::Little, 0);
        put32(&mut d, Endian::Little, 0);
        put32(&mut d, Endian::Little, (MAX_RECORD_LEN + 1) as u32);
        put32(&mut d, Endian::Little, (MAX_RECORD_LEN + 1) as u32);
        assert_eq!(read_all(&d), Err(PcapError::Ended { cut: true }));
    }

    #[test]
    fn truncated_tail_delivers_complete_records_before_cut() {
        // CP-002: a truncated tail preserves every complete record before the cut.
        let d = classic(
            Endian::Big,
            false,
            1,
            &[(1, 2, b"complete", 8), (3, 4, b"cut-tail", 8)],
        );
        let d = &d[..d.len() - 3];
        let mut r = PcapReader::new();
        r.push(d);
        assert_eq!(r.next_record().unwrap().unwrap().wire, b"complete");
        assert_eq!(r.next_record().unwrap(), None);
        r.finish();
        assert_eq!(r.next_record(), Err(PcapError::Ended { cut: true }));
    }

    #[test]
    fn spb_without_preceding_timestamp_reuses_zero_and_marks_truncation() {
        let mut d = shb(Endian::Little);
        d.extend(idb(Endian::Little, 3, 6, "first"));
        d.extend(spb(Endian::Little, b"abc", 8));
        let r = read_all(&d).unwrap();
        assert_eq!(r[0].ts_ns, 0);
        assert!(r[0].ts_reused);
        assert!(r[0].caplen_truncated);
    }

    #[test]
    fn random_prefixes_of_every_fixture_never_panic() {
        // CP-002: fuzz-style fixture prefixes never panic.
        let mut writer = PcapWriter::new(Vec::new()).unwrap();
        writer.write_record(1, b"hello").unwrap();
        let mut ng = shb(Endian::Little);
        ng.extend(idb(Endian::Little, 65_535, 9, "fixture"));
        ng.extend(epb(Endian::Little, 0, 5, b"world", 5, Some(1)));
        ng.extend(spb(Endian::Little, b"spb", 3));
        let fixtures = [
            writer.into_inner(),
            classic(Endian::Big, false, 1, &[(1, 2, b"swap", 4)]),
            ng,
        ];
        for fixture in fixtures {
            for n in 0..=fixture.len() {
                assert!(std::panic::catch_unwind(|| {
                    let _ = read_all(&fixture[..n]);
                })
                .is_ok());
            }
        }
    }
}
