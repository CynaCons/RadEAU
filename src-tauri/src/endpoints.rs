use std::collections::HashMap;

use serde::Serialize;

use crate::codes::{ENDPOINT_MAX_INDEX, ENDPOINT_OVERFLOW};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EndpointKey {
    Ipv4(u32),
    Mac(u64),
}

#[derive(Debug, Clone)]
struct Entry {
    key: EndpointKey,
    hint: Option<String>,
}

#[derive(Debug, Default)]
pub struct EndpointTable {
    indexes: HashMap<EndpointKey, u8>,
    entries: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EndpointDto {
    pub name: String,
    pub ip: String,
}

impl EndpointTable {
    pub fn assign(&mut self, key: EndpointKey) -> (u8, bool) {
        if let Some(&index) = self.indexes.get(&key) {
            return (index, false);
        }
        if self.entries.len() > ENDPOINT_MAX_INDEX as usize {
            return (ENDPOINT_OVERFLOW, false);
        }
        let index = self.entries.len() as u8;
        self.entries.push(Entry { key, hint: None });
        self.indexes.insert(key, index);
        (index, true)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn with_hint(&mut self, ip: u32, name: String) {
        let key = EndpointKey::Ipv4(ip);
        let (index, grew) = self.assign(key);
        if index != ENDPOINT_OVERFLOW && (grew || self.entries[index as usize].hint.is_none()) {
            self.entries[index as usize].hint = Some(name);
        }
    }

    pub fn to_dtos(&self) -> Vec<EndpointDto> {
        self.entries
            .iter()
            .map(|entry| match entry.key {
                EndpointKey::Ipv4(ip) => {
                    let text = ipv4_text(ip);
                    EndpointDto {
                        name: entry.hint.clone().unwrap_or_else(|| text.clone()),
                        ip: text,
                    }
                }
                EndpointKey::Mac(mac) => EndpointDto {
                    name: entry.hint.clone().unwrap_or_else(|| mac_text(mac)),
                    ip: String::new(),
                },
            })
            .collect()
    }
}

pub fn ipv4_u32(ip: [u8; 4]) -> u32 {
    u32::from_be_bytes(ip)
}
fn ipv4_text(ip: u32) -> String {
    let b = ip.to_be_bytes();
    format!("{}.{}.{}.{}", b[0], b[1], b[2], b[3])
}
fn mac_text(mac: u64) -> String {
    (0..6)
        .rev()
        .map(|n| format!("{:02x}", (mac >> (n * 8)) & 0xff))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn growth_and_stability() {
        let mut t = EndpointTable::default();
        assert_eq!(t.assign(EndpointKey::Ipv4(1)), (0, true));
        assert_eq!(t.assign(EndpointKey::Ipv4(1)), (0, false));
        assert_eq!(t.assign(EndpointKey::Mac(2)), (1, true));
    }
    #[test]
    fn overflow_after_255_entries() {
        let mut t = EndpointTable::default();
        for n in 0..=254 {
            assert_eq!(t.assign(EndpointKey::Ipv4(n)).0, n as u8);
        }
        assert_eq!(t.assign(EndpointKey::Ipv4(999)), (ENDPOINT_OVERFLOW, false));
    }
    #[test]
    fn hint_precedes_address() {
        let mut t = EndpointTable::default();
        t.with_hint(u32::from_be_bytes([10, 42, 0, 11]), "camera".into());
        assert_eq!(
            t.to_dtos()[0],
            EndpointDto {
                name: "camera".into(),
                ip: "10.42.0.11".into()
            }
        );
    }
}
