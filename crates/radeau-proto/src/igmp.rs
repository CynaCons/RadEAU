//! Internet Group Management Protocol (IGMP) v1-v3 codec.

use crate::{internet_checksum, ParseError};

pub const HEADER_LEN: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IgmpGroupRecord {
    pub record_type: u8,
    pub multicast_address: [u8; 4],
    pub sources: Vec<[u8; 4]>,
    pub auxiliary_data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IgmpMessage {
    pub msg_type: u8,
    pub max_response_code: u8,
    pub checksum: u16,
    pub group_address: [u8; 4],
    pub records: Vec<IgmpGroupRecord>,
}

impl IgmpMessage {
    pub fn parse(buf: &[u8]) -> Result<Self, ParseError> {
        let h = buf.get(..HEADER_LEN).ok_or(ParseError::Truncated)?;
        let msg_type = h[0];
        let mut message = Self {
            msg_type,
            max_response_code: h[1],
            checksum: u16::from_be_bytes([h[2], h[3]]),
            group_address: h[4..8].try_into().expect("exact"),
            records: Vec::new(),
        };

        if msg_type != 0x22 {
            return Ok(message);
        }

        // In a v3 report, bytes 4..6 are reserved and bytes 6..8 are the
        // record count; retain the common-header view above for diagnostics.
        let count = u16::from_be_bytes([h[6], h[7]]) as usize;
        let mut offset = HEADER_LEN;
        for _ in 0..count {
            let prefix = buf
                .get(offset..offset.saturating_add(8))
                .ok_or(ParseError::Truncated)?;
            let source_count = u16::from_be_bytes([prefix[2], prefix[3]]) as usize;
            let sources_len = source_count.checked_mul(4).ok_or(ParseError::Malformed)?;
            let auxiliary_len = (prefix[1] as usize)
                .checked_mul(4)
                .ok_or(ParseError::Malformed)?;
            let record_len = 8usize
                .checked_add(sources_len)
                .and_then(|n| n.checked_add(auxiliary_len))
                .ok_or(ParseError::Malformed)?;
            let end = offset
                .checked_add(record_len)
                .ok_or(ParseError::Malformed)?;
            let record = buf.get(offset..end).ok_or(ParseError::Truncated)?;
            let mut sources = Vec::with_capacity(source_count);
            for source in record[8..8 + sources_len].as_chunks::<4>().0 {
                sources.push(*source);
            }
            message.records.push(IgmpGroupRecord {
                record_type: prefix[0],
                multicast_address: prefix[4..8].try_into().expect("exact"),
                sources,
                auxiliary_data: record[8 + sources_len..].to_vec(),
            });
            offset = end;
        }
        Ok(message)
    }
}

pub fn type_name(msg_type: u8) -> &'static str {
    match msg_type {
        0x11 => "Membership Query",
        0x12 => "Version 1 Membership Report",
        0x16 => "Version 2 Membership Report",
        0x17 => "Leave Group",
        0x22 => "Version 3 Membership Report",
        _ => "type n",
    }
}

pub fn checksum_ok(bytes: &[u8]) -> bool {
    internet_checksum(&[bytes]) == 0
}

pub fn build(msg_type: u8, max_response_code: u8, group_address: [u8; 4], out: &mut Vec<u8>) {
    let start = out.len();
    out.extend_from_slice(&[msg_type, max_response_code, 0, 0]);
    out.extend_from_slice(&group_address);
    let checksum = internet_checksum(&[&out[start..]]);
    out[start + 2..start + 4].copy_from_slice(&checksum.to_be_bytes());
}

pub fn build_v3_report(records: &[IgmpGroupRecord], out: &mut Vec<u8>) {
    let start = out.len();
    out.extend_from_slice(&[0x22, 0, 0, 0, 0, 0]);
    out.extend_from_slice(&(records.len() as u16).to_be_bytes());
    for record in records {
        out.push(record.record_type);
        out.push((record.auxiliary_data.len() / 4) as u8);
        out.extend_from_slice(&(record.sources.len() as u16).to_be_bytes());
        out.extend_from_slice(&record.multicast_address);
        for source in &record.sources {
            out.extend_from_slice(source);
        }
        out.extend_from_slice(&record.auxiliary_data);
    }
    let checksum = internet_checksum(&[&out[start..]]);
    out[start + 2..start + 4].copy_from_slice(&checksum.to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_report_is_byte_exact() {
        let mut wire = Vec::new();
        build(0x16, 0, [239, 1, 2, 3], &mut wire);
        assert_eq!(wire, [0x16, 0, 0xf8, 0xfa, 239, 1, 2, 3]);
        assert!(checksum_ok(&wire));
        let message = IgmpMessage::parse(&wire).unwrap();
        assert_eq!(message.msg_type, 0x16);
        assert_eq!(message.group_address, [239, 1, 2, 3]);
    }

    #[test]
    fn v3_records_are_byte_exact() {
        let records = [IgmpGroupRecord {
            record_type: 1,
            multicast_address: [239, 1, 2, 3],
            sources: vec![[10, 0, 0, 1], [10, 0, 0, 2]],
            auxiliary_data: vec![0xaa, 0xbb, 0xcc, 0xdd],
        }];
        let mut wire = Vec::new();
        build_v3_report(&records, &mut wire);
        assert_eq!(
            wire,
            [
                0x22, 0, 0x60, 0x5a, 0, 0, 0, 1, 1, 1, 0, 2, 239, 1, 2, 3, 10, 0, 0, 1, 10, 0, 0,
                2, 0xaa, 0xbb, 0xcc, 0xdd
            ]
        );
        assert!(checksum_ok(&wire));
        assert_eq!(IgmpMessage::parse(&wire).unwrap().records, records);
        for n in 0..wire.len() {
            assert!(IgmpMessage::parse(&wire[..n]).is_err());
        }
    }

    #[test]
    fn malformed_prefixes_and_random_bytes_never_panic() {
        let bad = [0x22, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 224, 0, 0, 1];
        assert_eq!(IgmpMessage::parse(&bad), Err(ParseError::Truncated));
        let mut seed = 0x51a7_1234u32;
        for len in 0..128 {
            let mut bytes = vec![0; len];
            for byte in &mut bytes {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *byte = seed as u8;
            }
            let _ = IgmpMessage::parse(&bytes);
        }
        assert_eq!(type_name(0x22), "Version 3 Membership Report");
        assert_eq!(type_name(0xff), "type n");
    }
}
