//! Bounded Link Layer Discovery Protocol (IEEE 802.1AB) codec.
use crate::ParseError;

pub const ETHERTYPE: u16 = 0x88CC;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tlv<'a> {
    pub tlv_type: u8,
    pub offset: usize,
    pub len: usize,
    pub data: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LldpFrame<'a> {
    pub tlvs: Vec<Tlv<'a>>,
    pub chassis_id: Option<String>,
    pub port_id: Option<String>,
    pub ttl: Option<u16>,
    pub port_description: Option<String>,
    pub system_name: Option<String>,
    pub system_description: Option<String>,
    pub capabilities: Option<(u16, u16)>,
    pub management_addresses: Vec<String>,
    pub ended: bool,
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn identifier(value: &[u8], mac_subtype: u8) -> Result<String, ParseError> {
    let (&subtype, value) = value.split_first().ok_or(ParseError::Malformed)?;
    if subtype == mac_subtype {
        let mac: [u8; 6] = value.try_into().map_err(|_| ParseError::Malformed)?;
        Ok(format!(
            "{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
            mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]
        ))
    } else {
        Ok(text(value))
    }
}

fn management_address(value: &[u8]) -> Option<String> {
    let address_len = usize::from(*value.first()?);
    if address_len < 1 || value.len() < 1 + address_len {
        return None;
    }
    let subtype = value[1];
    let address = &value[2..=address_len];
    match (subtype, address) {
        (1, [a, b, c, d]) => Some(format!("{a}.{b}.{c}.{d}")),
        (2, bytes) if bytes.len() == 16 => {
            let mut words = [0u16; 8];
            for (word, pair) in words.iter_mut().zip(bytes.as_chunks::<2>().0) {
                *word = u16::from_be_bytes(*pair);
            }
            Some(
                words
                    .iter()
                    .map(|word| format!("{word:x}"))
                    .collect::<Vec<_>>()
                    .join(":"),
            )
        }
        _ => Some(
            address
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<Vec<_>>()
                .join(":"),
        ),
    }
}

pub fn parse(buf: &[u8]) -> Result<LldpFrame<'_>, ParseError> {
    let mut frame = LldpFrame {
        tlvs: Vec::new(),
        chassis_id: None,
        port_id: None,
        ttl: None,
        port_description: None,
        system_name: None,
        system_description: None,
        capabilities: None,
        management_addresses: Vec::new(),
        ended: false,
    };
    let mut offset = 0usize;
    while offset < buf.len() {
        let header = buf.get(offset..offset + 2).ok_or(ParseError::Truncated)?;
        let raw = u16::from_be_bytes([header[0], header[1]]);
        let tlv_type = (raw >> 9) as u8;
        let len = usize::from(raw & 0x01ff);
        let data_offset = offset + 2;
        let data = buf
            .get(data_offset..data_offset + len)
            .ok_or(ParseError::Truncated)?;
        frame.tlvs.push(Tlv {
            tlv_type,
            offset,
            len,
            data,
        });
        offset = data_offset + len;

        match tlv_type {
            0 => {
                if len != 0 {
                    return Err(ParseError::Malformed);
                }
                frame.ended = true;
                break;
            }
            1 => frame.chassis_id = Some(identifier(data, 4)?),
            2 => frame.port_id = Some(identifier(data, 3)?),
            3 => {
                let value: [u8; 2] = data.try_into().map_err(|_| ParseError::Malformed)?;
                frame.ttl = Some(u16::from_be_bytes(value));
            }
            4 => frame.port_description = Some(text(data)),
            5 => frame.system_name = Some(text(data)),
            6 => frame.system_description = Some(text(data)),
            7 => {
                let value: [u8; 4] = data.try_into().map_err(|_| ParseError::Malformed)?;
                frame.capabilities = Some((
                    u16::from_be_bytes([value[0], value[1]]),
                    u16::from_be_bytes([value[2], value[3]]),
                ));
            }
            8 => {
                if let Some(address) = management_address(data) {
                    frame.management_addresses.push(address);
                }
            }
            _ => {}
        }
    }
    if frame.ended {
        Ok(frame)
    } else {
        Err(ParseError::Truncated)
    }
}

pub fn tlv_name(tlv_type: u8) -> String {
    match tlv_type {
        0 => "End of LLDPDU".into(),
        1 => "Chassis ID".into(),
        2 => "Port ID".into(),
        3 => "TTL".into(),
        4 => "Port Description".into(),
        5 => "System Name".into(),
        6 => "System Description".into(),
        7 => "System Capabilities".into(),
        8 => "Management Address".into(),
        127 => "Organization Specific".into(),
        value => format!("TLV {value}"),
    }
}

fn push_tlv(out: &mut Vec<u8>, tlv_type: u8, data: &[u8]) {
    let len = data.len().min(0x01ff);
    let header = (u16::from(tlv_type) << 9) | len as u16;
    out.extend_from_slice(&header.to_be_bytes());
    out.extend_from_slice(&data[..len]);
}

pub fn build(chassis_mac: [u8; 6], port_id: &str, ttl: u16, system_name: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut chassis = vec![4];
    chassis.extend_from_slice(&chassis_mac);
    push_tlv(&mut out, 1, &chassis);
    let mut port = vec![5];
    port.extend_from_slice(port_id.as_bytes());
    push_tlv(&mut out, 2, &port);
    push_tlv(&mut out, 3, &ttl.to_be_bytes());
    push_tlv(&mut out, 5, system_name.as_bytes());
    push_tlv(&mut out, 0, &[]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vector_and_prefixes() {
        let bytes = build([2, 0x52, 0x41, 0x44, 0, 1], "eth0", 120, "CameraECU");
        assert_eq!(
            bytes,
            [
                0x02, 0x07, 0x04, 0x02, 0x52, 0x41, 0x44, 0, 1, 0x04, 0x05, 0x05, b'e', b't', b'h',
                b'0', 0x06, 0x02, 0, 120, 0x0a, 0x09, b'C', b'a', b'm', b'e', b'r', b'a', b'E',
                b'C', b'U', 0, 0,
            ]
        );
        let parsed = parse(&bytes).unwrap();
        assert_eq!(parsed.chassis_id.as_deref(), Some("02:52:41:44:00:01"));
        assert_eq!(parsed.port_id.as_deref(), Some("eth0"));
        assert_eq!(parsed.ttl, Some(120));
        assert!(parsed.ended);
        for n in 0..bytes.len() {
            assert_eq!(parse(&bytes[..n]), Err(ParseError::Truncated));
        }
    }

    #[test]
    fn random_prefix_no_panic() {
        let mut bytes = Vec::new();
        for n in 0..1024u32 {
            bytes.push((n.wrapping_mul(73).wrapping_add(19) >> 3) as u8);
            let _ = parse(&bytes);
        }
    }
}
