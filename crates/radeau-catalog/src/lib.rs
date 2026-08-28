//! Bounded AUTOSAR communication-extract import and SOME/IP signal decoding.
//! Only the small, byte-aligned RadEAU subset is modelled; malformed or
//! unmappable elements are diagnosed individually so useful siblings survive.

use quick_xml::events::Event as XmlEvent;
use quick_xml::Reader;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BaseType {
    U8,
    U16,
    U32,
    S16,
}
impl BaseType {
    pub fn byte_len(self) -> usize {
        match self {
            Self::U8 => 1,
            Self::U16 | Self::S16 => 2,
            Self::U32 => 4,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    pub name: String,
    pub byte_offset: usize,
    pub byte_len: usize,
    pub base: BaseType,
    pub factor: f64,
    pub offset: f64,
    pub unit: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub event_id: u16,
    pub name: String,
    pub signals: Vec<Signal>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Method {
    pub method_id: u16,
    pub name: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub service_id: u16,
    pub name: String,
    pub instance_id: u16,
    pub events: Vec<Event>,
    pub methods: Vec<Method>,
}
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub services: Vec<Service>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedSignal {
    pub name: String,
    pub raw_hex: String,
    pub raw_dec: String,
    pub scaled: f64,
    pub unit: String,
}

#[derive(Default, Debug, Clone)]
struct Node {
    name: String,
    text: String,
    children: Vec<Node>,
}
fn local(bytes: &[u8]) -> String {
    std::str::from_utf8(bytes)
        .unwrap_or("")
        .rsplit(':')
        .next()
        .unwrap_or("")
        .to_string()
}
fn child<'a>(n: &'a Node, name: &str) -> Option<&'a Node> {
    n.children.iter().find(|c| c.name == name)
}
fn children<'a>(n: &'a Node, name: &str) -> Vec<&'a Node> {
    n.children.iter().filter(|c| c.name == name).collect()
}
fn text(n: &Node, name: &str) -> Option<String> {
    child(n, name)
        .map(|x| x.text.trim().to_string())
        .filter(|x| !x.is_empty())
}
fn leaf(ref_text: &str) -> &str {
    ref_text.rsplit('/').next().unwrap_or(ref_text)
}
fn all<'a>(n: &'a Node, name: &str, out: &mut Vec<&'a Node>) {
    if n.name == name {
        out.push(n);
    }
    for c in &n.children {
        all(c, name, out);
    }
}

fn parse_tree(xml: &str) -> Result<Node, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut stack: Vec<Node> = Vec::new();
    let mut root = None;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(XmlEvent::Start(e)) => stack.push(Node {
                name: local(e.name().as_ref()),
                ..Default::default()
            }),
            Ok(XmlEvent::Empty(e)) => {
                let n = Node {
                    name: local(e.name().as_ref()),
                    ..Default::default()
                };
                if let Some(p) = stack.last_mut() {
                    p.children.push(n)
                } else {
                    root = Some(n)
                }
            }
            Ok(XmlEvent::Text(e)) => {
                if let Some(n) = stack.last_mut() {
                    n.text.push_str(&e.unescape().map_err(|x| x.to_string())?);
                }
            }
            Ok(XmlEvent::End(_)) => {
                let n = stack.pop().ok_or_else(|| "unbalanced XML".to_string())?;
                if let Some(p) = stack.last_mut() {
                    p.children.push(n)
                } else {
                    root = Some(n)
                }
            }
            Ok(XmlEvent::Eof) => break,
            Err(e) => return Err(format!("XML read error: {e}")),
            _ => {}
        }
        buf.clear();
    }
    if !stack.is_empty() {
        return Err("unclosed XML element".into());
    }
    root.ok_or_else(|| "empty XML".into())
}

/// Imports the RadEAU AUTOSAR subset. XML syntax failures are fatal; individual
/// unknown references and unsupported base types yield diagnostics and skip only
/// the affected element.
pub fn from_arxml(xml: &str) -> Result<(Catalog, Vec<String>), String> {
    let root = parse_tree(xml)?;
    let mut diagnostics = Vec::new();
    let mut compu = HashMap::new();
    let mut base_types = HashMap::new();
    let mut types: HashMap<String, Vec<Signal>> = HashMap::new();
    let mut nodes = Vec::new();
    all(&root, "SW-BASE-TYPE", &mut nodes);
    for n in &nodes {
        if let (Some(name), Some(size)) = (text(n, "SHORT-NAME"), text(n, "BASE-TYPE-SIZE")) {
            let b = match (name.as_str(), size.as_str()) {
                ("uint8", "8") => Some(BaseType::U8),
                ("uint16", "16") => Some(BaseType::U16),
                ("uint32", "32") => Some(BaseType::U32),
                ("sint16", "16") => Some(BaseType::S16),
                _ => None,
            };
            if let Some(b) = b {
                base_types.insert(name, b);
            } else {
                diagnostics.push(format!("unsupported base type {name}"));
            }
        }
    }
    nodes.clear();
    all(&root, "COMPU-METHOD", &mut nodes);
    for n in &nodes {
        match (text(n, "SHORT-NAME"), text(n, "FACTOR"), text(n, "OFFSET")) {
            (Some(name), Some(f), Some(o)) => match (f.parse(), o.parse()) {
                (Ok(f), Ok(o)) => {
                    compu.insert(name, (f, o, text(n, "UNIT").unwrap_or_default()));
                }
                _ => diagnostics.push(format!("invalid scaling for COMPU-METHOD {name}")),
            },
            _ => diagnostics.push("COMPU-METHOD missing name or scaling".into()),
        }
    }
    nodes.clear();
    all(&root, "IMPLEMENTATION-DATA-TYPE", &mut nodes);
    for n in &nodes {
        let Some(name) = text(n, "SHORT-NAME") else {
            diagnostics.push("IMPLEMENTATION-DATA-TYPE missing name".into());
            continue;
        };
        let mut signals = Vec::new();
        let mut at = 0;
        if let Some(subs) = child(n, "SUB-ELEMENTS") {
            for el in children(subs, "IMPLEMENTATION-DATA-TYPE-ELEMENT") {
                let sn = text(el, "SHORT-NAME");
                let bn = text(el, "BASE-TYPE-REF").map(|v| leaf(&v).to_string());
                let cn = text(el, "COMPU-METHOD-REF").map(|v| leaf(&v).to_string());
                match (sn, bn, cn) {
                    (Some(sn), Some(bn), Some(cn)) => match (base_types.get(&bn), compu.get(&cn)) {
                        (Some(base), Some((factor, offset, unit))) => {
                            let len = base.byte_len();
                            signals.push(Signal {
                                name: sn,
                                byte_offset: at,
                                byte_len: len,
                                base: *base,
                                factor: *factor,
                                offset: *offset,
                                unit: unit.clone(),
                            });
                            at += len;
                        }
                        _ => diagnostics.push(format!(
                            "{name}: signal {sn} references unknown base type or COMPU-METHOD"
                        )),
                    },
                    _ => diagnostics.push(format!("{name}: incomplete SUB-ELEMENT")),
                }
            }
        } else {
            diagnostics.push(format!("{name}: no SUB-ELEMENTS"));
        }
        types.insert(name, signals);
    }
    let mut interfaces: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut interface_methods: HashMap<String, Vec<String>> = HashMap::new();
    nodes.clear();
    all(&root, "SERVICE-INTERFACE", &mut nodes);
    for n in &nodes {
        let Some(name) = text(n, "SHORT-NAME") else {
            continue;
        };
        let mut ev = Vec::new();
        if let Some(es) = child(n, "EVENTS") {
            for e in children(es, "VARIABLE-DATA-PROTOTYPE") {
                if let (Some(en), Some(tr)) = (text(e, "SHORT-NAME"), text(e, "TYPE-TREF")) {
                    ev.push((en, leaf(&tr).to_string()))
                } else {
                    diagnostics.push(format!("{name}: incomplete event"))
                }
            }
        };
        let methods = child(n, "METHODS")
            .map(|ms| {
                children(ms, "CLIENT-SERVER-OPERATION")
                    .into_iter()
                    .filter_map(|m| text(m, "SHORT-NAME"))
                    .collect()
            })
            .unwrap_or_default();
        interfaces.insert(name.clone(), ev);
        interface_methods.insert(name, methods);
    }
    let mut instances = HashMap::new();
    nodes.clear();
    all(&root, "PROVIDED-SOMEIP-SERVICE-INSTANCE", &mut nodes);
    for n in &nodes {
        if let (Some(d), Some(i)) = (
            text(n, "SERVICE-INTERFACE-DEPLOYMENT-REF"),
            text(n, "SERVICE-INSTANCE-ID").and_then(|v| v.parse().ok()),
        ) {
            instances.insert(leaf(&d).to_string(), i);
        } else {
            diagnostics.push("incomplete provided service instance".into())
        }
    }
    let mut services = Vec::new();
    nodes.clear();
    all(&root, "SOMEIP-SERVICE-INTERFACE-DEPLOYMENT", &mut nodes);
    for n in &nodes {
        let Some(deploy) = text(n, "SHORT-NAME") else {
            continue;
        };
        let Some(iface_ref) = text(n, "SERVICE-INTERFACE-REF") else {
            diagnostics.push(format!("{deploy}: missing interface reference"));
            continue;
        };
        let iface = leaf(&iface_ref);
        let Some(service_id) = text(n, "SERVICE-INTERFACE-ID").and_then(|v| v.parse().ok()) else {
            diagnostics.push(format!("{deploy}: invalid service id"));
            continue;
        };
        let Some(event_defs) = interfaces.get(iface) else {
            diagnostics.push(format!("{deploy}: unknown interface {iface}"));
            continue;
        };
        let mut events = Vec::new();
        if let Some(ds) = child(n, "EVENT-DEPLOYMENTS") {
            for d in children(ds, "SOMEIP-EVENT-DEPLOYMENT") {
                if let (Some(en), Some(id)) = (
                    text(d, "SHORT-NAME"),
                    text(d, "EVENT-ID").and_then(|v| v.parse().ok()),
                ) {
                    if let Some((_, ty)) = event_defs.iter().find(|(x, _)| x == &en) {
                        if let Some(signals) = types.get(ty) {
                            events.push(Event {
                                event_id: id,
                                name: en,
                                signals: signals.clone(),
                            })
                        } else {
                            diagnostics.push(format!("{deploy}: event type {ty} unavailable"))
                        }
                    } else {
                        diagnostics.push(format!("{deploy}: event {en} absent from interface"))
                    }
                } else {
                    diagnostics.push(format!("{deploy}: incomplete event deployment"))
                }
            }
        };
        let mut methods = Vec::new();
        if let Some(ds) = child(n, "METHOD-DEPLOYMENTS") {
            for d in children(ds, "SOMEIP-METHOD-DEPLOYMENT") {
                if let (Some(mn), Some(id)) = (
                    text(d, "SHORT-NAME"),
                    text(d, "METHOD-ID").and_then(|v| v.parse().ok()),
                ) {
                    methods.push(Method {
                        method_id: id,
                        name: mn,
                    })
                }
            }
        };
        services.push(Service {
            service_id,
            name: iface.to_string(),
            instance_id: *instances.get(&deploy).unwrap_or(&0),
            events,
            methods,
        });
    }
    Ok((Catalog { services }, diagnostics))
}

/// Decodes complete, fixed-width signals only. Fields crossing the payload end
/// are omitted rather than partially decoded; all integer fields are big-endian.
pub fn decode(signals: &[Signal], payload: &[u8]) -> Vec<DecodedSignal> {
    signals
        .iter()
        .filter_map(|s| {
            let b = payload.get(s.byte_offset..s.byte_offset + s.byte_len)?;
            let (raw, hex) = match s.base {
                BaseType::U8 => (b[0] as i64, format!("{:02X}", b[0])),
                BaseType::U16 => (
                    u16::from_be_bytes([b[0], b[1]]) as i64,
                    format!("{:04X}", u16::from_be_bytes([b[0], b[1]])),
                ),
                BaseType::U32 => (
                    u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as i64,
                    format!("{:08X}", u32::from_be_bytes([b[0], b[1], b[2], b[3]])),
                ),
                BaseType::S16 => (
                    i16::from_be_bytes([b[0], b[1]]) as i64,
                    format!("{:04X}", u16::from_be_bytes([b[0], b[1]])),
                ),
            };
            Some(DecodedSignal {
                name: s.name.clone(),
                raw_hex: hex,
                raw_dec: raw.to_string(),
                scaled: raw as f64 * s.factor + s.offset,
                unit: s.unit.clone(),
            })
        })
        .collect()
}

impl Catalog {
    pub fn event(&self, service_id: u16, event_id: u16) -> Option<&Event> {
        self.services
            .iter()
            .find(|s| s.service_id == service_id)
            .and_then(|s| s.events.iter().find(|e| e.event_id == event_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const XML: &str = include_str!("../../../catalog/sensor-fusion.arxml");
    #[test]
    fn imports_actual_extract() {
        let (c, d) = from_arxml(XML).unwrap();
        assert!(d.is_empty(), "{d:?}");
        assert_eq!(c.services.len(), 5);
        let e = c.event(0x1102, 0x8001).unwrap();
        assert_eq!(e.signals[1].byte_offset, 1);
        assert_eq!(e.signals[1].factor, 0.01);
        assert_eq!(e.signals[1].unit, "m");
        assert_eq!(c.event(0x1201, 0x8002).unwrap().signals[0].unit, "ms");
    }
    #[test]
    fn decode_and_truncation() {
        let s = Signal {
            name: "x".into(),
            byte_offset: 0,
            byte_len: 2,
            base: BaseType::S16,
            factor: 0.1,
            offset: 1.0,
            unit: "m".into(),
        };
        let d = decode(&[s.clone()], &(-25i16).to_be_bytes());
        assert_eq!(d[0].raw_hex, "FFE7");
        assert!((d[0].scaled + 1.5).abs() < 1e-9);
        assert!(decode(&[s], &[0]).is_empty());
    }
    #[test]
    fn mangled_element_diagnosed() {
        let x="<AUTOSAR><IMPLEMENTATION-DATA-TYPE><SHORT-NAME>x</SHORT-NAME><SUB-ELEMENTS><IMPLEMENTATION-DATA-TYPE-ELEMENT/></SUB-ELEMENTS></IMPLEMENTATION-DATA-TYPE></AUTOSAR>";
        let (_, d) = from_arxml(x).unwrap();
        assert!(!d.is_empty());
    }
}
