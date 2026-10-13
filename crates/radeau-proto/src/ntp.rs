//! Network Time Protocol fixed-header codec.

use crate::ParseError;

pub const PORT: u16 = 123;
pub const PACKET_LEN: usize = 48;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NtpPacket {
    pub li: u8,
    pub version: u8,
    pub mode: u8,
    pub stratum: u8,
    pub poll: u8,
    pub precision: u8,
    pub root_delay: u32,
    pub root_dispersion: u32,
    pub reference_id: [u8; 4],
    pub reference_ts: u64,
    pub origin_ts: u64,
    pub receive_ts: u64,
    pub transmit_ts: u64,
}

pub fn parse(buf: &[u8]) -> Result<NtpPacket, ParseError> {
    let b = buf.get(..PACKET_LEN).ok_or(ParseError::Truncated)?;
    Ok(NtpPacket {
        li: b[0] >> 6,
        version: (b[0] >> 3) & 7,
        mode: b[0] & 7,
        stratum: b[1],
        poll: b[2],
        precision: b[3],
        root_delay: u32::from_be_bytes(b[4..8].try_into().expect("exact")),
        root_dispersion: u32::from_be_bytes(b[8..12].try_into().expect("exact")),
        reference_id: b[12..16].try_into().expect("exact"),
        reference_ts: u64::from_be_bytes(b[16..24].try_into().expect("exact")),
        origin_ts: u64::from_be_bytes(b[24..32].try_into().expect("exact")),
        receive_ts: u64::from_be_bytes(b[32..40].try_into().expect("exact")),
        transmit_ts: u64::from_be_bytes(b[40..48].try_into().expect("exact")),
    })
}

pub fn build(packet: &NtpPacket, out: &mut Vec<u8>) {
    out.push((packet.li << 6) | ((packet.version & 7) << 3) | (packet.mode & 7));
    out.extend_from_slice(&[packet.stratum, packet.poll, packet.precision]);
    out.extend_from_slice(&packet.root_delay.to_be_bytes());
    out.extend_from_slice(&packet.root_dispersion.to_be_bytes());
    out.extend_from_slice(&packet.reference_id);
    out.extend_from_slice(&packet.reference_ts.to_be_bytes());
    out.extend_from_slice(&packet.origin_ts.to_be_bytes());
    out.extend_from_slice(&packet.receive_ts.to_be_bytes());
    out.extend_from_slice(&packet.transmit_ts.to_be_bytes());
}

pub fn mode_name(mode: u8) -> &'static str {
    match mode {
        1 => "symmetric active",
        2 => "symmetric passive",
        3 => "client",
        4 => "server",
        5 => "broadcast",
        6 => "control",
        7 => "private",
        _ => "reserved",
    }
}

/// Converts an era-zero NTP timestamp to Unix milliseconds.
pub fn ntp_to_unix_ms(ts: u64) -> Option<f64> {
    const NTP_UNIX_DELTA: u64 = 2_208_988_800;
    let seconds = ts >> 32;
    if seconds < NTP_UNIX_DELTA {
        return None;
    }
    let fraction = (ts & 0xffff_ffff) as f64 / 4_294_967_296.0;
    Some(((seconds - NTP_UNIX_DELTA) as f64 + fraction) * 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> NtpPacket {
        NtpPacket {
            li: 0,
            version: 4,
            mode: 4,
            stratum: 2,
            poll: 6,
            precision: 0xec,
            root_delay: 0x0001_8000,
            root_dispersion: 0x0000_4000,
            reference_id: *b"GPS\0",
            reference_ts: 1,
            origin_ts: 2,
            receive_ts: 3,
            transmit_ts: 0x83aa_7e80_8000_0000,
        }
    }

    #[test]
    fn byte_exact_round_trip() {
        let mut wire = Vec::new();
        build(&sample(), &mut wire);
        assert_eq!(wire.len(), 48);
        assert_eq!(
            &wire[..16],
            &[0x24, 2, 6, 0xec, 0, 1, 0x80, 0, 0, 0, 0x40, 0, b'G', b'P', b'S', 0]
        );
        assert_eq!(parse(&wire).unwrap(), sample());
        assert_eq!(ntp_to_unix_ms(0x83aa_7e80_8000_0000), Some(500.0));
    }

    #[test]
    fn bounded_all_prefixes_and_noise() {
        let mut wire = Vec::new();
        build(&sample(), &mut wire);
        for n in 0..48 {
            assert_eq!(parse(&wire[..n]), Err(ParseError::Truncated));
        }
        let mut x = 1u32;
        for n in 0..512 {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let v = vec![(x >> 24) as u8; n % 80];
            let _ = parse(&v);
        }
    }
}
