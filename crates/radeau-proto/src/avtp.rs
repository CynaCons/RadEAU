//! Bounded IEEE 1722 Audio Video Transport Protocol decoder.
use crate::ParseError;

pub const ETHERTYPE: u16 = 0x22F0;
pub const AAF_SUBTYPE: u8 = 2;
pub const STREAM_HEADER_LEN: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AafFormat {
    pub format: u8,
    pub nsr: u8,
    pub channels_per_frame: u16,
    pub bit_depth: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvtpHeader {
    pub subtype: u8,
    pub stream_id_valid: bool,
    pub version: u8,
    pub sequence_num: u8,
    pub timestamp_valid: bool,
    pub avtp_timestamp: u32,
    pub stream_id: u64,
    pub stream_data_length: u16,
    pub format: Option<AafFormat>,
}

pub fn parse(buf: &[u8]) -> Result<AvtpHeader, ParseError> {
    let prefix = buf.get(..4).ok_or(ParseError::Truncated)?;
    let control = prefix[0] & 0x80 != 0;
    let subtype = prefix[0] & 0x7f;
    let flags = prefix[1];
    if control {
        return Ok(AvtpHeader {
            subtype,
            stream_id_valid: flags & 0x80 != 0,
            version: (flags >> 4) & 0x07,
            sequence_num: prefix[2],
            timestamp_valid: flags & 0x01 != 0,
            avtp_timestamp: 0,
            stream_id: 0,
            stream_data_length: 0,
            format: None,
        });
    }

    let header = buf.get(..STREAM_HEADER_LEN).ok_or(ParseError::Truncated)?;
    let stream_data_length = u16::from_be_bytes([header[20], header[21]]);
    buf.get(..STREAM_HEADER_LEN + usize::from(stream_data_length))
        .ok_or(ParseError::Truncated)?;
    let format = (subtype == AAF_SUBTYPE).then(|| AafFormat {
        format: header[16],
        nsr: header[17] >> 4,
        channels_per_frame: (u16::from(header[17] & 0x03) << 8) | u16::from(header[18]),
        bit_depth: header[19],
    });
    Ok(AvtpHeader {
        subtype,
        stream_id_valid: flags & 0x80 != 0,
        version: (flags >> 4) & 0x07,
        sequence_num: header[2],
        timestamp_valid: flags & 0x01 != 0,
        avtp_timestamp: u32::from_be_bytes(header[12..16].try_into().expect("exact")),
        stream_id: u64::from_be_bytes(header[4..12].try_into().expect("exact")),
        stream_data_length,
        format,
    })
}

pub fn subtype_name(subtype: u8) -> String {
    match subtype & 0x7f {
        0 => "61883/IIDC".into(),
        1 => "MMA".into(),
        2 => "AAF".into(),
        3 => "CVF".into(),
        4 => "CRF".into(),
        5 => "TSCF".into(),
        6 => "SVF".into(),
        7 => "RVF".into(),
        0x6e => "AEF".into(),
        0x6f => "VSF".into(),
        0x7a => "ACF/NTSCF".into(),
        0x7f => "ACF/TSCF".into(),
        value => format!("subtype {value}"),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn build_aaf(
    stream_id: u64,
    sequence_num: u8,
    avtp_timestamp: u32,
    format: u8,
    nsr: u8,
    channels_per_frame: u16,
    bit_depth: u8,
    payload: &[u8],
) -> Vec<u8> {
    let payload_len = payload.len().min(usize::from(u16::MAX));
    let mut out = Vec::with_capacity(STREAM_HEADER_LEN + payload_len);
    out.extend_from_slice(&[AAF_SUBTYPE, 0x81, sequence_num, 0]);
    out.extend_from_slice(&stream_id.to_be_bytes());
    out.extend_from_slice(&avtp_timestamp.to_be_bytes());
    out.push(format);
    out.push(((nsr & 0x0f) << 4) | ((channels_per_frame >> 8) as u8 & 0x03));
    out.push(channels_per_frame as u8);
    out.push(bit_depth);
    out.extend_from_slice(&(payload_len as u16).to_be_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&payload[..payload_len]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aaf_vector_and_prefixes() {
        let bytes = build_aaf(0x0200_0000_0001_0001, 9, 0x1234_5678, 4, 5, 2, 24, &[1, 2]);
        assert_eq!(
            &bytes[..24],
            &[
                2, 0x81, 9, 0, 2, 0, 0, 0, 0, 1, 0, 1, 0x12, 0x34, 0x56, 0x78, 4, 0x50, 2, 24, 0,
                2, 0, 0,
            ]
        );
        let header = parse(&bytes).unwrap();
        assert_eq!(header.stream_data_length, 2);
        assert_eq!(header.format.unwrap().channels_per_frame, 2);
        for n in 0..bytes.len() {
            assert_eq!(parse(&bytes[..n]), Err(ParseError::Truncated));
        }
    }

    #[test]
    fn control_and_random_prefixes() {
        assert_eq!(parse(&[0xfa, 0, 7, 0]).unwrap().subtype, 0x7a);
        let mut bytes = Vec::new();
        for n in 0..512u32 {
            bytes.push(n.wrapping_mul(29).wrapping_add(7) as u8);
            let _ = parse(&bytes);
        }
    }
}
