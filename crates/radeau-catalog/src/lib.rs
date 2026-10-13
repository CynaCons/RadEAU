//! Bounded AUTOSAR communication-extract import and SOME/IP signal decoding.

use quick_xml::{events::Event as XmlEvent, Reader, XmlVersion};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    error::Error,
    fmt,
};

pub const MAX_ARXML_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warn,
    Info,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Diagnostic {
    pub severity: Severity,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportError {
    pub message: String,
    pub diagnostics: Vec<Diagnostic>,
}
impl ImportError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            diagnostics: Vec::new(),
        }
    }

    fn with_diagnostics(message: impl Into<String>, diagnostics: Vec<Diagnostic>) -> Self {
        Self {
            message: message.into(),
            diagnostics,
        }
    }
}
impl fmt::Display for ImportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl Error for ImportError {}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BaseType {
    U8,
    U16,
    U32,
    U64,
    I8,
    S16,
    I32,
    I64,
    F32,
    F64,
    Bool,
}
impl BaseType {
    pub fn byte_len(self) -> usize {
        match self {
            Self::U8 | Self::I8 | Self::Bool => 1,
            Self::U16 | Self::S16 => 2,
            Self::U32 | Self::I32 | Self::F32 => 4,
            Self::U64 | Self::I64 | Self::F64 => 8,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    pub name: String,
    pub byte_offset: usize,
    pub byte_len: usize,
    pub base: BaseType,
    pub factor: f64,
    pub offset: f64,
    pub unit: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub value_table: BTreeMap<i64, String>,
}
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    Event,
    FieldNotifier,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub event_id: u16,
    pub name: String,
    pub signals: Vec<Signal>,
    pub kind: EventKind,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Method {
    pub method_id: u16,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub service_id: u16,
    pub name: String,
    pub instance_id: u16,
    pub events: Vec<Event>,
    pub methods: Vec<Method>,
}
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub services: Vec<Service>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DecodedSignal {
    pub name: String,
    pub raw_hex: String,
    pub raw_dec: String,
    pub scaled: f64,
    pub unit: String,
    pub label: Option<String>,
}

#[derive(Default, Debug, Clone)]
struct Node {
    name: String,
    text: String,
    attrs: HashMap<String, String>,
    children: Vec<Node>,
    path: String,
}
const MAX_XML_DEPTH: usize = 256;
fn local(value: &str) -> String {
    value.rsplit(':').next().unwrap_or("").to_string()
}
fn child<'a>(n: &'a Node, name: &str) -> Option<&'a Node> {
    n.children.iter().find(|c| c.name == name)
}
fn children<'a>(n: &'a Node, name: &'a str) -> impl Iterator<Item = &'a Node> {
    n.children.iter().filter(move |c| c.name == name)
}
fn text(n: &Node, name: &str) -> Option<String> {
    child(n, name)
        .map(|x| x.text.trim().to_string())
        .filter(|x| !x.is_empty())
}
fn own_name(n: &Node) -> Option<String> {
    text(n, "SHORT-NAME")
}
fn all<'a>(n: &'a Node, name: &str, out: &mut Vec<&'a Node>) {
    let mut stack = vec![n];
    while let Some(node) = stack.pop() {
        if node.name == name {
            out.push(node);
        }
        stack.extend(node.children.iter().rev());
    }
}
fn parse_num(s: &str) -> Option<u64> {
    let s = s.trim().replace('_', "");
    if let Some(x) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u64::from_str_radix(x, 16).ok()
    } else if let Some(x) = s.strip_prefix("0b").or_else(|| s.strip_prefix("0B")) {
        u64::from_str_radix(x, 2).ok()
    } else {
        s.parse().ok()
    }
}
fn element_path(n: &Node) -> String {
    if n.path.is_empty() {
        n.name.clone()
    } else {
        n.path.clone()
    }
}
fn diag(ds: &mut Vec<Diagnostic>, sev: Severity, n: &Node, msg: impl Into<String>) {
    ds.push(Diagnostic {
        severity: sev,
        path: element_path(n),
        message: msg.into(),
    })
}

fn parse_tree(xml: &str) -> Result<Node, ImportError> {
    let mut r = Reader::from_str(xml);
    r.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut stack: Vec<Node> = Vec::new();
    let mut root = None;
    loop {
        match r.read_event_into(&mut buf) {
            Ok(XmlEvent::Start(e)) => {
                if stack.len() >= MAX_XML_DEPTH {
                    return Err(ImportError::new(format!(
                        "XML nesting exceeds {MAX_XML_DEPTH} element limit"
                    )));
                }
                let mut n = Node {
                    name: local(e.name().as_ref()),
                    ..Default::default()
                };
                for a in e.attributes().with_checks(false) {
                    let a = a.map_err(|e| ImportError::new(format!("XML attribute error: {e}")))?;
                    n.attrs.insert(
                        local(a.key.as_ref()),
                        a.normalized_value(XmlVersion::Implicit1_0)
                            .map_err(|e| ImportError::new(e.to_string()))?
                            .into_owned(),
                    );
                }
                stack.push(n)
            }
            Ok(XmlEvent::Empty(e)) => {
                if stack.len() >= MAX_XML_DEPTH {
                    return Err(ImportError::new(format!(
                        "XML nesting exceeds {MAX_XML_DEPTH} element limit"
                    )));
                }
                let mut n = Node {
                    name: local(e.name().as_ref()),
                    ..Default::default()
                };
                for a in e.attributes().with_checks(false) {
                    let a = a.map_err(|e| ImportError::new(format!("XML attribute error: {e}")))?;
                    n.attrs.insert(
                        local(a.key.as_ref()),
                        a.normalized_value(XmlVersion::Implicit1_0)
                            .map_err(|e| ImportError::new(e.to_string()))?
                            .into_owned(),
                    );
                }
                if let Some(p) = stack.last_mut() {
                    p.children.push(n)
                } else {
                    root = Some(n)
                }
            }
            Ok(XmlEvent::Text(e)) => {
                if let Some(n) = stack.last_mut() {
                    n.text.push_str(&e.xml10_content())
                }
            }
            Ok(XmlEvent::CData(e)) => {
                if let Some(n) = stack.last_mut() {
                    n.text.push_str(e.as_ref())
                }
            }
            Ok(XmlEvent::End(_)) => {
                let n = stack
                    .pop()
                    .ok_or_else(|| ImportError::new("unbalanced XML"))?;
                if let Some(p) = stack.last_mut() {
                    p.children.push(n)
                } else {
                    root = Some(n)
                }
            }
            Ok(XmlEvent::Eof) => break,
            Err(e) => return Err(ImportError::new(format!("XML read error: {e}"))),
            _ => {}
        }
        buf.clear()
    }
    if !stack.is_empty() {
        return Err(ImportError::new("unclosed XML element"));
    }
    let mut root = root.ok_or_else(|| ImportError::new("empty XML"))?;
    assign_paths(&mut root, "");
    Ok(root)
}
fn assign_paths(n: &mut Node, parent: &str) {
    let mut stack = vec![(n, parent.to_string())];
    while let Some((node, parent)) = stack.pop() {
        let here = own_name(node)
            .map(|x| format!("{parent}/{x}"))
            .unwrap_or(parent);
        node.path = if here.is_empty() {
            node.name.clone()
        } else {
            here.clone()
        };
        stack.extend(
            node.children
                .iter_mut()
                .rev()
                .map(|child| (child, here.clone())),
        );
    }
}

#[derive(Clone, Default)]
struct Compu {
    factor: f64,
    offset: f64,
    unit: String,
    table: BTreeMap<i64, String>,
}
#[derive(Clone)]
struct Proto {
    name: String,
    path: String,
    ty: String,
    field: bool,
}
struct Index<'a> {
    abs: HashMap<String, &'a Node>,
    short: HashMap<String, Vec<&'a Node>>,
}
impl<'a> Index<'a> {
    fn new(root: &'a Node) -> Self {
        fn add<'a>(n: &'a Node, i: &mut Index<'a>) {
            if let Some(sn) = own_name(n) {
                i.abs.insert(n.path.clone(), n);
                i.short.entry(sn).or_default().push(n)
            }
            for c in &n.children {
                add(c, i)
            }
        }
        let mut i = Self {
            abs: HashMap::new(),
            short: HashMap::new(),
        };
        add(root, &mut i);
        i
    }
    fn resolve(
        &self,
        r: &str,
        expected: &str,
        owner: &Node,
        ds: &mut Vec<Diagnostic>,
    ) -> Option<&'a Node> {
        if r.starts_with('/') {
            if let Some(n) = self.abs.get(r) {
                return Some(*n);
            }
        }
        let key = r.rsplit('/').next().unwrap_or(r);
        match self.short.get(key).map(Vec::as_slice) {
            Some([n]) => {
                diag(
                    ds,
                    Severity::Warn,
                    owner,
                    format!("reference {r} resolved by short-name fallback"),
                );
                Some(*n)
            }
            Some(v) if v.len() > 1 => {
                diag(
                    ds,
                    Severity::Error,
                    owner,
                    format!("ambiguous {expected} reference {r}"),
                );
                None
            }
            _ => {
                diag(
                    ds,
                    Severity::Error,
                    owner,
                    format!("unknown {expected} reference {r}"),
                );
                None
            }
        }
    }
}

fn rational(n: &Node) -> Option<(f64, f64)> {
    let nums = child(n, "COMPU-RATIONAL-COEFFS")?;
    let num = child(nums, "COMPU-NUMERATOR")?;
    let vals: Vec<f64> = children(num, "V")
        .filter_map(|v| v.text.trim().parse().ok())
        .collect();
    let den = child(nums, "COMPU-DENOMINATOR")
        .and_then(|d| children(d, "V").next())
        .and_then(|v| v.text.trim().parse::<f64>().ok())
        .unwrap_or(1.0);
    Some((
        vals.get(1).copied().unwrap_or(1.0) / den,
        vals.first().copied().unwrap_or(0.0) / den,
    ))
}
fn parse_compu(n: &Node, idx: &Index<'_>, ds: &mut Vec<Diagnostic>) -> Option<Compu> {
    let unit = if let Some(r) = text(n, "UNIT-REF") {
        idx.resolve(&r, "unit", n, ds)
            .and_then(|u| text(u, "DISPLAY-NAME").or_else(|| own_name(u)))
            .unwrap_or_default()
    } else {
        text(n, "UNIT").unwrap_or_default()
    };
    if text(n, "FACTOR").is_some() || text(n, "OFFSET").is_some() {
        diag(
            ds,
            Severity::Info,
            n,
            "accepted legacy flattened COMPU-METHOD",
        );
        return match (
            text(n, "FACTOR").and_then(|x| x.parse().ok()),
            text(n, "OFFSET").and_then(|x| x.parse().ok()),
        ) {
            (Some(f), Some(o)) => Some(Compu {
                factor: f,
                offset: o,
                unit,
                ..Default::default()
            }),
            _ => {
                diag(ds, Severity::Error, n, "invalid legacy scaling");
                None
            }
        };
    }
    let cat = text(n, "CATEGORY").unwrap_or_else(|| "IDENTICAL".into());
    if cat == "IDENTICAL" {
        return Some(Compu {
            factor: 1.0,
            unit,
            ..Default::default()
        });
    }
    let mut scales = Vec::new();
    all(n, "COMPU-SCALE", &mut scales);
    if cat == "TEXTTABLE" {
        let mut c = Compu {
            factor: 1.0,
            unit,
            ..Default::default()
        };
        for s in scales {
            if let (Some(v), Some(t)) = (
                text(s, "LOWER-LIMIT")
                    .and_then(|x| parse_num(&x))
                    .map(|x| x as i64),
                text(s, "VT").or_else(|| child(s, "COMPU-CONST").and_then(|c| text(c, "VT"))),
            ) {
                c.table.insert(v, t);
            }
        }
        return Some(c);
    }
    if (cat == "LINEAR" || cat == "SCALE_LINEAR") && scales.len() == 1 {
        if let Some((factor, offset)) = rational(scales[0]) {
            return Some(Compu {
                factor,
                offset,
                unit,
                ..Default::default()
            });
        }
    }
    diag(
        ds,
        Severity::Error,
        n,
        format!("unsupported or multi-scale COMPU-METHOD category {cat}"),
    );
    None
}
fn base_type(n: &Node, ds: &mut Vec<Diagnostic>) -> Option<BaseType> {
    let size = text(n, "BASE-TYPE-SIZE").and_then(|x| parse_num(&x));
    let enc = text(n, "BASE-TYPE-ENCODING")
        .unwrap_or_else(|| "NONE".into())
        .to_ascii_uppercase();
    let signed = matches!(enc.as_str(), "2C" | "SIGNED" | "SINT");
    let float = enc.contains("IEEE") || enc.contains("FLOAT");
    let boolean = enc.contains("BOOL");
    let b = match (size, signed, float, boolean) {
        (Some(8), false, false, false) => Some(BaseType::U8),
        (Some(16), false, false, false) => Some(BaseType::U16),
        (Some(32), false, false, false) => Some(BaseType::U32),
        (Some(64), false, false, false) => Some(BaseType::U64),
        (Some(8), true, false, false) => Some(BaseType::I8),
        (Some(16), true, false, false) => Some(BaseType::S16),
        (Some(32), true, false, false) => Some(BaseType::I32),
        (Some(64), true, false, false) => Some(BaseType::I64),
        (Some(32), _, true, _) => Some(BaseType::F32),
        (Some(64), _, true, _) => Some(BaseType::F64),
        (Some(1 | 8), _, _, true) => Some(BaseType::Bool),
        _ => None,
    };
    if b.is_none() {
        diag(
            ds,
            Severity::Error,
            n,
            format!("unsupported base type size/encoding {:?}/{enc}", size),
        )
    }
    b
}

pub fn from_arxml_bytes(bytes: &[u8]) -> Result<(Catalog, Vec<Diagnostic>), ImportError> {
    if bytes.len() > MAX_ARXML_BYTES {
        return Err(ImportError::new(format!(
            "ARXML exceeds 64 MiB limit ({} bytes)",
            bytes.len()
        )));
    }
    let s = if bytes.starts_with(&[0xff, 0xfe]) {
        let words: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|x| u16::from_le_bytes(*x))
            .collect();
        String::from_utf16(&words)
            .map_err(|e| ImportError::new(format!("invalid UTF-16LE: {e}")))?
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        let words: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|x| u16::from_be_bytes(*x))
            .collect();
        String::from_utf16(&words)
            .map_err(|e| ImportError::new(format!("invalid UTF-16BE: {e}")))?
    } else {
        String::from_utf8(
            bytes
                .strip_prefix(&[0xef, 0xbb, 0xbf])
                .unwrap_or(bytes)
                .to_vec(),
        )
        .map_err(|e| ImportError::new(format!("invalid UTF-8: {e}")))?
    };
    from_arxml(&s)
}

pub fn from_arxml(xml: &str) -> Result<(Catalog, Vec<Diagnostic>), ImportError> {
    if xml.len() > MAX_ARXML_BYTES {
        return Err(ImportError::new("ARXML exceeds 64 MiB limit"));
    }
    let root = parse_tree(xml)?;
    let idx = Index::new(&root);
    let mut ds = Vec::new();
    for marker in [
        "SERVICE-INSTANCE-COLLECTION-SET",
        "SOCKET-ADDRESS",
        "PDU-TRIGGERING",
    ] {
        let mut v = Vec::new();
        all(&root, marker, &mut v);
        if let Some(n) = v.first() {
            diag(
                &mut ds,
                Severity::Error,
                n,
                format!("classic-platform System Description marker {marker}"),
            );
        }
    }
    let mut bases: HashMap<String, BaseType> = HashMap::new();
    let mut nodes = Vec::new();
    all(&root, "SW-BASE-TYPE", &mut nodes);
    for n in nodes {
        if let Some(b) = base_type(n, &mut ds) {
            bases.insert(n.path.clone(), b);
        }
    }
    let mut compus: HashMap<String, Compu> = HashMap::new();
    nodes = Vec::new();
    all(&root, "COMPU-METHOD", &mut nodes);
    for n in nodes {
        if let Some(c) = parse_compu(n, &idx, &mut ds) {
            compus.insert(n.path.clone(), c);
        }
    }
    let mut types: HashMap<String, Vec<Signal>> = HashMap::new();
    nodes = Vec::new();
    all(&root, "IMPLEMENTATION-DATA-TYPE", &mut nodes);
    for n in nodes {
        let mut sigs = Vec::new();
        let mut at = 0;
        if let Some(subs) = child(n, "SUB-ELEMENTS") {
            for el in children(subs, "IMPLEMENTATION-DATA-TYPE-ELEMENT") {
                let Some(name) = own_name(el) else {
                    diag(&mut ds, Severity::Error, el, "missing SHORT-NAME");
                    continue;
                };
                let Some(br) = text(el, "BASE-TYPE-REF").or_else(|| {
                    child(el, "SW-DATA-DEF-PROPS").and_then(|p| {
                        let mut x = Vec::new();
                        all(p, "BASE-TYPE-REF", &mut x);
                        x.first().map(|n| n.text.trim().to_string())
                    })
                }) else {
                    diag(&mut ds, Severity::Error, el, "missing BASE-TYPE-REF");
                    continue;
                };
                let Some(bn) = idx.resolve(&br, "base type", el, &mut ds) else {
                    continue;
                };
                let Some(base) = bases.get(&bn.path).copied() else {
                    continue;
                };
                let cr = text(el, "COMPU-METHOD-REF").or_else(|| {
                    let mut x = Vec::new();
                    all(el, "COMPU-METHOD-REF", &mut x);
                    x.first().map(|n| n.text.trim().to_string())
                });
                let c = if let Some(cr) = cr {
                    idx.resolve(&cr, "COMPU-METHOD", el, &mut ds)
                        .and_then(|cn| compus.get(&cn.path))
                        .cloned()
                        .unwrap_or_default()
                } else {
                    Compu {
                        factor: 1.0,
                        ..Default::default()
                    }
                };
                let len = base.byte_len();
                sigs.push(Signal {
                    name,
                    byte_offset: at,
                    byte_len: len,
                    base,
                    factor: c.factor,
                    offset: c.offset,
                    unit: c.unit,
                    value_table: c.table,
                });
                at += len
            }
        } else {
            diag(&mut ds, Severity::Warn, n, "no SUB-ELEMENTS")
        }
        types.insert(n.path.clone(), sigs);
    }
    let mut interfaces: HashMap<String, Vec<Proto>> = HashMap::new();
    nodes = Vec::new();
    all(&root, "SERVICE-INTERFACE", &mut nodes);
    for n in nodes {
        let mut p = Vec::new();
        if let Some(es) = child(n, "EVENTS") {
            for e in children(es, "VARIABLE-DATA-PROTOTYPE") {
                if let (Some(name), Some(ty)) = (own_name(e), text(e, "TYPE-TREF")) {
                    p.push(Proto {
                        name,
                        path: e.path.clone(),
                        ty,
                        field: false,
                    })
                } else {
                    diag(&mut ds, Severity::Error, e, "incomplete event prototype")
                }
            }
        }
        if let Some(fs) = child(n, "FIELDS") {
            for f in children(fs, "FIELD").chain(children(fs, "VARIABLE-DATA-PROTOTYPE")) {
                if let (Some(name), Some(ty)) = (own_name(f), text(f, "TYPE-TREF")) {
                    p.push(Proto {
                        name,
                        path: f.path.clone(),
                        ty,
                        field: true,
                    })
                } else {
                    diag(&mut ds, Severity::Error, f, "incomplete field prototype")
                }
            }
        }
        interfaces.insert(n.path.clone(), p);
    }
    let mut instances = HashMap::new();
    nodes = Vec::new();
    all(&root, "PROVIDED-SOMEIP-SERVICE-INSTANCE", &mut nodes);
    for n in nodes {
        if let (Some(r), Some(id)) = (
            text(n, "SERVICE-INTERFACE-DEPLOYMENT-REF"),
            text(n, "SERVICE-INSTANCE-ID").and_then(|x| parse_num(&x)),
        ) {
            if let Some(d) = idx.resolve(&r, "deployment", n, &mut ds) {
                instances.insert(d.path.clone(), id as u16);
            }
        } else {
            diag(
                &mut ds,
                Severity::Error,
                n,
                "incomplete provided service instance",
            )
        }
    }
    let mut services = Vec::new();
    nodes = Vec::new();
    all(&root, "SOMEIP-SERVICE-INTERFACE-DEPLOYMENT", &mut nodes);
    for n in nodes {
        let Some(ir) = text(n, "SERVICE-INTERFACE-REF") else {
            diag(&mut ds, Severity::Error, n, "missing SERVICE-INTERFACE-REF");
            continue;
        };
        let Some(inode) = idx.resolve(&ir, "service interface", n, &mut ds) else {
            continue;
        };
        let Some(id) = text(n, "SERVICE-INTERFACE-ID")
            .and_then(|x| parse_num(&x))
            .filter(|x| *x <= u16::MAX as u64)
        else {
            diag(&mut ds, Severity::Error, n, "invalid service id");
            continue;
        };
        let protos = interfaces.get(&inode.path).cloned().unwrap_or_default();
        let mut events = Vec::new();
        let mut methods = Vec::new();
        let mut deps = Vec::new();
        all(n, "SOMEIP-EVENT-DEPLOYMENT", &mut deps);
        for d in deps {
            let r = text(d, "EVENT-REF").or_else(|| text(d, "FIELD-REF"));
            let fallback = own_name(d);
            let proto = if let Some(r) = r {
                protos.iter().find(|p| p.path == r).or_else(|| {
                    let sn = r.rsplit('/').next()?;
                    let hits: Vec<_> = protos.iter().filter(|p| p.name == sn).collect();
                    if hits.len() == 1 {
                        diag(
                            &mut ds,
                            Severity::Warn,
                            d,
                            format!("deployment reference {r} matched by short-name fallback"),
                        );
                        hits.first().copied()
                    } else {
                        diag(
                            &mut ds,
                            Severity::Error,
                            d,
                            format!("unknown or ambiguous deployment reference {r}"),
                        );
                        None
                    }
                })
            } else {
                fallback.as_ref().and_then(|x| {
                    let hits: Vec<_> = protos.iter().filter(|p| &p.name == x).collect();
                    if hits.len() == 1 {
                        diag(
                            &mut ds,
                            Severity::Warn,
                            d,
                            "deployment lacks EVENT-REF/FIELD-REF; matched by short name",
                        );
                        hits.first().copied()
                    } else {
                        None
                    }
                })
            };
            let Some(p) = proto else { continue };
            let Some(eid) = text(d, "EVENT-ID").and_then(|x| parse_num(&x)) else {
                diag(&mut ds, Severity::Error, d, "invalid event id");
                continue;
            };
            let sigs = idx
                .resolve(&p.ty, "data type", d, &mut ds)
                .and_then(|t| types.get(&t.path))
                .cloned()
                .unwrap_or_default();
            events.push(Event {
                event_id: eid as u16,
                name: p.name.clone(),
                signals: sigs,
                kind: if p.field {
                    EventKind::FieldNotifier
                } else {
                    EventKind::Event
                },
            })
        }
        let mut mdeps = Vec::new();
        all(n, "SOMEIP-METHOD-DEPLOYMENT", &mut mdeps);
        for d in mdeps {
            if let (Some(mid), Some(name)) = (
                text(d, "METHOD-ID").and_then(|x| parse_num(&x)),
                own_name(d).or_else(|| {
                    text(d, "METHOD-REF").map(|x| x.rsplit('/').next().unwrap_or(&x).to_string())
                }),
            ) {
                methods.push(Method {
                    method_id: mid as u16,
                    name,
                })
            } else {
                diag(&mut ds, Severity::Error, d, "incomplete method deployment")
            }
        }
        let name = own_name(inode).unwrap_or_else(|| inode.path.clone());
        services.push(Service {
            service_id: id as u16,
            name,
            instance_id: *instances.get(&n.path).unwrap_or(&0),
            events,
            methods,
        });
    }
    if services.is_empty() {
        return Err(ImportError::with_diagnostics(
            "ARXML import yielded zero services",
            ds,
        ));
    }
    Ok((Catalog { services }, ds))
}

// SP-021/SP-005: fixed-offset big-endian catalog decode skips truncated fields.
pub fn decode(signals: &[Signal], payload: &[u8]) -> Vec<DecodedSignal> {
    signals
        .iter()
        .filter_map(|s| {
            let b = payload.get(s.byte_offset..s.byte_offset + s.byte_len)?;
            let hex = b.iter().map(|x| format!("{x:02X}")).collect::<String>();
            let (raw_dec, raw, lookup) = match s.base {
                BaseType::U8 => (b[0].to_string(), b[0] as f64, Some(b[0] as i64)),
                BaseType::U16 => {
                    let v = u16::from_be_bytes(b.try_into().ok()?);
                    (v.to_string(), v as f64, Some(v as i64))
                }
                BaseType::U32 => {
                    let v = u32::from_be_bytes(b.try_into().ok()?);
                    (v.to_string(), v as f64, Some(v as i64))
                }
                BaseType::U64 => {
                    let v = u64::from_be_bytes(b.try_into().ok()?);
                    (v.to_string(), v as f64, i64::try_from(v).ok())
                }
                BaseType::I8 => {
                    let v = b[0] as i8;
                    (v.to_string(), v as f64, Some(v as i64))
                }
                BaseType::S16 => {
                    let v = i16::from_be_bytes(b.try_into().ok()?);
                    (v.to_string(), v as f64, Some(v as i64))
                }
                BaseType::I32 => {
                    let v = i32::from_be_bytes(b.try_into().ok()?);
                    (v.to_string(), v as f64, Some(v as i64))
                }
                BaseType::I64 => {
                    let v = i64::from_be_bytes(b.try_into().ok()?);
                    (v.to_string(), v as f64, Some(v))
                }
                BaseType::F32 => {
                    let v = f32::from_be_bytes(b.try_into().ok()?) as f64;
                    (v.to_string(), v, None)
                }
                BaseType::F64 => {
                    let v = f64::from_be_bytes(b.try_into().ok()?);
                    (v.to_string(), v, None)
                }
                BaseType::Bool => {
                    let v = b[0] != 0;
                    (
                        v.to_string(),
                        if v { 1.0 } else { 0.0 },
                        Some(if v { 1 } else { 0 }),
                    )
                }
            };
            Some(DecodedSignal {
                name: s.name.clone(),
                raw_hex: hex,
                raw_dec,
                scaled: raw * s.factor + s.offset,
                unit: s.unit.clone(),
                label: lookup.and_then(|v| s.value_table.get(&v).cloned()),
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
    use std::time::{Duration, Instant};

    const XML: &str = include_str!("../../../catalog/sensor-fusion.arxml");

    #[test]
    fn rejects_excessive_xml_nesting_without_building_the_tree() {
        let depth = 10_000;
        let mut xml = String::with_capacity(depth * 7);
        xml.push_str(&"<N>".repeat(depth));
        xml.push_str(&"</N>".repeat(depth));

        let err = from_arxml(&xml).unwrap_err();
        assert_eq!(
            err.message,
            format!("XML nesting exceeds {MAX_XML_DEPTH} element limit")
        );
    }

    fn snapshot(catalog: &Catalog) -> String {
        catalog
            .services
            .iter()
            .map(|service| {
                let events = service
                    .events
                    .iter()
                    .map(|event| {
                        let signals = event
                            .signals
                            .iter()
                            .map(|signal| {
                                format!(
                                    "{}@{}:{:?}:{}:{}:{}",
                                    signal.name,
                                    signal.byte_offset,
                                    signal.base,
                                    signal.factor,
                                    signal.offset,
                                    signal.unit
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(",");
                        format!("{}#{:04X}[{}]", event.name, event.event_id, signals)
                    })
                    .collect::<Vec<_>>()
                    .join(";");
                let methods = service
                    .methods
                    .iter()
                    .map(|method| format!("{}#{:04X}", method.name, method.method_id))
                    .collect::<Vec<_>>()
                    .join(",");
                format!(
                    "{}#{:04X}@{}|{}|{}",
                    service.name, service.service_id, service.instance_id, events, methods
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn reference_extract() {
        let (c, d) = from_arxml(XML).unwrap();
        assert!(
            d.iter()
                .all(|x| !matches!(x.severity, Severity::Warn | Severity::Error)),
            "{d:?}"
        );
        assert_eq!(
            snapshot(&c),
            "CameraObjects#1101@1|ObjectList#8001[ObjectCount@0:U8:1:0:,FrameCounter@1:U16:1:0:,ExposureTime@3:U16:0.01:0:ms]|\n\
RadarTargets#1102@1|TargetList#8001[TargetCount@0:U8:1:0:,NearestRange@1:U16:0.01:0:m,NearestSpeed@3:S16:0.01:0:m/s]|\n\
LidarClusters#1103@1|ClusterList#8001[ClusterCount@0:U8:1:0:,PointCount@1:U32:1:0:,MeanIntensity@5:U8:1:0:%]|\n\
VehicleDynamics#1104@1|DynamicsState#8001[VehicleSpeed@0:U16:0.01:0:m/s,YawRate@2:S16:0.001:0:rad/s,AccelX@4:S16:0.001:0:m/s^2]|\n\
FusedObjects#1201@1|FusedTrackList#8001[TrackCount@0:U8:1:0:,QualityMean@1:U8:1:0:%,LeadRange@2:U16:0.01:0:m,LeadSpeed@4:S16:0.01:0:m/s];FusionStats#8002[InputLatencyCam@0:U16:0.1:0:ms,MatchedTracks@2:U16:1:0:,UnmatchedTracks@4:U16:1:0:]|SetFusionMode#0001"
        );
    }

    #[test]
    fn real_style_fixture_has_fields_tables_wide_types_and_no_diagnostics() {
        let xml = include_str!("../../../fixtures/arxml/real-style.arxml");
        let (catalog, diagnostics) = from_arxml(xml).unwrap();
        assert_eq!(diagnostics, vec![]);
        let service = &catalog.services[0];
        assert_eq!((service.service_id, service.instance_id), (0x4321, 0x2a));
        let event = &service.events[0];
        assert_eq!(
            (event.event_id, event.kind),
            (0x800a, EventKind::FieldNotifier)
        );
        assert_eq!(event.signals[0].base, BaseType::F32);
        assert_eq!(
            (event.signals[0].factor, event.signals[0].offset),
            (0.5, -0.5)
        );
        assert_eq!(event.signals[1].base, BaseType::U64);
        assert_eq!(
            event.signals[2].value_table.get(&1).map(String::as_str),
            Some("on")
        );
    }

    #[test]
    fn classic_system_description_is_loud_and_fatal() {
        let xml = include_str!("../../../fixtures/arxml/classic-system-description.arxml");
        let error = from_arxml(xml).unwrap_err();
        assert_eq!(error.message, "ARXML import yielded zero services");
        assert_eq!(
            error.diagnostics,
            vec![Diagnostic {
                severity: Severity::Error,
                path: "/ClassicSystem/ClassicInstances".into(),
                message:
                    "classic-platform System Description marker SERVICE-INSTANCE-COLLECTION-SET"
                        .into(),
            }]
        );
    }

    #[test]
    fn utf16_bom_fixture_imports() {
        let source =
            include_str!("../../../fixtures/arxml/utf16-bom.arxml").trim_start_matches('\u{feff}');
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend(source.encode_utf16().flat_map(u16::to_le_bytes));
        let (catalog, diagnostics) = from_arxml_bytes(&bytes).unwrap();
        assert_eq!(diagnostics, vec![]);
        assert_eq!(catalog.event(3, 4).unwrap().signals[0].base, BaseType::U8);
    }

    #[test]
    fn legacy_flattened_fixture_has_exact_info_diagnostic() {
        let xml = include_str!("../../../fixtures/arxml/legacy-flattened.arxml");
        let (catalog, diagnostics) = from_arxml(xml).unwrap();
        assert_eq!(catalog.event(1, 2).unwrap().signals[0].factor, 2.0);
        assert_eq!(
            diagnostics,
            vec![Diagnostic {
                severity: Severity::Info,
                path: "/C/Legacy".into(),
                message: "accepted legacy flattened COMPU-METHOD".into(),
            }]
        );
    }

    #[test]
    fn ten_megabyte_debug_parse_budget() {
        let closing = "</AUTOSAR>";
        let split = XML.rfind(closing).unwrap();
        let padding_len = 10 * 1024 * 1024 - XML.len() - 7;
        let mut xml = String::with_capacity(10 * 1024 * 1024);
        xml.push_str(&XML[..split]);
        xml.push_str("<!--");
        xml.extend(std::iter::repeat_n('x', padding_len));
        xml.push_str("-->");
        xml.push_str(&XML[split..]);
        assert_eq!(xml.len(), 10 * 1024 * 1024);
        let started = Instant::now();
        let (catalog, diagnostics) = from_arxml(&xml).unwrap();
        assert_eq!(catalog.services.len(), 5);
        assert!(diagnostics.iter().all(|d| d.severity == Severity::Info));
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "10 MiB parse took {:?}",
            started.elapsed()
        );
    }
    #[test]
    fn numeric_decode_sp_004() {
        // SP-021
        let mk = |base: BaseType| Signal {
            name: "x".into(),
            byte_offset: 0,
            byte_len: base.byte_len(),
            base,
            factor: 1.0,
            offset: 0.0,
            unit: String::new(),
            value_table: BTreeMap::new(),
        };
        assert_eq!(
            decode(&[mk(BaseType::I32)], &(-7i32).to_be_bytes())[0].raw_dec,
            "-7"
        );
        assert_eq!(
            decode(&[mk(BaseType::F32)], &1.5f32.to_be_bytes())[0].scaled,
            1.5
        )
    }

    #[test]
    fn truncated_payload_skips_field_sp_005() {
        // SP-005
        let signal = Signal {
            name: "speed".into(),
            byte_offset: 1,
            byte_len: 2,
            base: BaseType::U16,
            factor: 0.01,
            offset: -1.0,
            unit: "m/s".into(),
            value_table: BTreeMap::new(),
        };
        assert!(decode(std::slice::from_ref(&signal), &[0]).is_empty());
        let decoded = decode(&[signal], &[0, 0x01, 0x2c]);
        assert_eq!(decoded[0].raw_dec, "300");
        assert_eq!(decoded[0].scaled, 2.0);
    }
    #[test]
    fn zero_services_is_fatal() {
        assert!(from_arxml("<AUTOSAR/>").is_err())
    }
}
