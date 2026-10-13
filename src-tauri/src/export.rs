use std::{
    fs::File,
    io::{BufWriter, Read, Write},
    path::Path,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    classify::classify_frame,
    codes::*,
    dissect::{dissect_with_catalog, FrameLayer},
    endpoints::EndpointTable,
    frame::GenFrame,
};

const EVENT_EXPORT_JSONL: &str = "export:jsonl";
const READ_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportFrom {
    Ring,
    File { path: String },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportJsonlResult {
    pub frames: u64,
    pub bytes: u64,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportJsonlProgress {
    done: u64,
    total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportJsonlLine {
    idx: u64,
    t_ns: u64,
    dir: &'static str,
    len: u32,
    protocol: &'static str,
    name: String,
    #[serde(rename = "type")]
    type_name: String,
    key: String,
    layers: Vec<FrameLayer>,
    payload_hex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    decoded: Option<Vec<radeau_catalog::DecodedSignal>>,
}

type EmitProgress<'a> = dyn FnMut(u64, u64) + 'a;

/// CP-024. Runs on the blocking pool (never the main thread) against a
/// snapshot of the active catalog, so a long export neither freezes the window
/// nor blocks a catalog import.
#[tauri::command]
pub async fn export_jsonl(
    path: String,
    from: ExportFrom,
    catalog: State<'_, crate::catalog::CatalogState>,
    app: AppHandle,
) -> Result<ExportJsonlResult, String> {
    let catalog = catalog.with_active(|active| active.cloned());
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::capture::CaptureState>();
        let progress_app = app.clone();
        let mut progress = JsonlProgress::new(move |done, total| {
            let _ = progress_app.emit(EVENT_EXPORT_JSONL, ExportJsonlProgress { done, total });
        });
        export_jsonl_inner(path, from, &state, catalog.as_ref(), &mut progress)
    })
    .await
    .map_err(|e| format!("export task failed: {e}"))?
}

fn export_jsonl_inner(
    path: String,
    from: ExportFrom,
    state: &crate::capture::CaptureState,
    catalog: Option<&radeau_catalog::Catalog>,
    progress: &mut JsonlProgress<'_>,
) -> Result<ExportJsonlResult, String> {
    match from {
        ExportFrom::Ring => export_ring_jsonl(path, state, catalog, progress),
        ExportFrom::File { path: source } => export_file_jsonl(path, source, catalog, progress),
    }
}

struct JsonlProgress<'a> {
    emit: Box<EmitProgress<'a>>,
    last_done: u64,
    last_percent: u64,
    last_emit: Instant,
}

impl<'a> JsonlProgress<'a> {
    fn new(emit: impl FnMut(u64, u64) + 'a) -> Self {
        Self {
            emit: Box::new(emit),
            last_done: 0,
            last_percent: 0,
            last_emit: Instant::now() - Duration::from_millis(250),
        }
    }

    fn maybe_emit(&mut self, done: u64, total: u64) {
        if done == self.last_done && done != total {
            return;
        }
        let percent = if total == 0 {
            100
        } else {
            done.saturating_mul(100) / total
        };
        let due_percent = percent > self.last_percent;
        let due_time = self.last_emit.elapsed() >= Duration::from_millis(250);
        if due_percent || due_time || done == total {
            (self.emit)(done, total);
            self.last_done = done;
            self.last_percent = percent;
            self.last_emit = Instant::now();
        }
    }
}

fn export_ring_jsonl(
    path: String,
    state: &crate::capture::CaptureState,
    catalog: Option<&radeau_catalog::Catalog>,
    progress: &mut JsonlProgress<'_>,
) -> Result<ExportJsonlResult, String> {
    // CP-024: snapshot retained frames under the ring lock, then classify and dissect off-lock.
    let frames = state.frame_ring_snapshot()?;
    let total = frames.len() as u64;
    let mut out = JsonlWriter::create(&path)?;
    let mut endpoints = EndpointTable::default();
    progress.maybe_emit(0, total);
    for (done, retained) in frames.iter().enumerate() {
        let frame = classify_frame(
            &retained.wire,
            retained.idx,
            retained.t_s,
            DIR_UNKNOWN,
            &mut endpoints,
        );
        out.write_line(&line_from_frame(&frame, &retained.wire, catalog))?;
        progress.maybe_emit(done as u64 + 1, total);
    }
    out.finish(total, path)
}

fn export_file_jsonl(
    path: String,
    source: String,
    catalog: Option<&radeau_catalog::Catalog>,
    progress: &mut JsonlProgress<'_>,
) -> Result<ExportJsonlResult, String> {
    // CP-024: pcap/pcapng export streams through the shared parser with bounded memory.
    let mut input =
        File::open(Path::new(&source)).map_err(|error| format!("open {source}: {error}"))?;
    let total = input
        .metadata()
        .map_err(|error| format!("metadata {source}: {error}"))?
        .len();
    let mut out = JsonlWriter::create(&path)?;
    let mut reader = radeau_pcap::PcapReader::new();
    let mut endpoints = EndpointTable::default();
    let mut buf = [0u8; READ_CHUNK];
    let mut input_done = 0u64;
    let mut frames = 0u64;
    let mut first_ts = None;
    progress.maybe_emit(0, total);
    loop {
        match reader.next_record() {
            Ok(Some(record)) => {
                let first = *first_ts.get_or_insert(record.ts_ns);
                let t_s = record.ts_ns.saturating_sub(first) as f64 / 1_000_000_000.0;
                let frame = classify_frame(&record.wire, frames, t_s, record.dir, &mut endpoints);
                out.write_line(&line_from_frame(&frame, &record.wire, catalog))?;
                frames += 1;
            }
            Ok(None) => {
                let count = input
                    .read(&mut buf)
                    .map_err(|error| format!("read {source}: {error}"))?;
                if count == 0 {
                    reader.finish();
                } else {
                    reader.push(&buf[..count]);
                    input_done = input_done.saturating_add(count as u64);
                    progress.maybe_emit(input_done.min(total), total);
                }
            }
            Err(radeau_pcap::PcapError::Ended { cut }) => {
                if cut {
                    return Err("capture ended (truncated)".into());
                }
                progress.maybe_emit(total, total);
                return out.finish(frames, path);
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

struct JsonlWriter {
    writer: BufWriter<File>,
    bytes: u64,
}

impl JsonlWriter {
    fn create(path: &str) -> Result<Self, String> {
        let file =
            File::create(Path::new(path)).map_err(|error| format!("create {path}: {error}"))?;
        Ok(Self {
            writer: BufWriter::new(file),
            bytes: 0,
        })
    }

    fn write_line(&mut self, line: &ExportJsonlLine) -> Result<(), String> {
        let bytes = serde_json::to_vec(line).map_err(|error| format!("encode jsonl: {error}"))?;
        self.writer
            .write_all(&bytes)
            .and_then(|_| self.writer.write_all(b"\n"))
            .map_err(|error| format!("write jsonl: {error}"))?;
        self.bytes = self.bytes.saturating_add(bytes.len() as u64 + 1);
        Ok(())
    }

    fn finish(mut self, frames: u64, path: String) -> Result<ExportJsonlResult, String> {
        self.writer
            .flush()
            .map_err(|error| format!("flush jsonl: {error}"))?;
        Ok(ExportJsonlResult {
            frames,
            bytes: self.bytes,
            path,
        })
    }
}

fn line_from_frame(
    frame: &GenFrame,
    wire: &[u8],
    catalog: Option<&radeau_catalog::Catalog>,
) -> ExportJsonlLine {
    let detail = dissect_with_catalog(frame.idx, frame.t_s, wire, catalog);
    let payload_start = detail
        .payload_offset
        .saturating_mul(2)
        .min(detail.bytes.len());
    let (name, type_name) = display_name_and_type(frame);
    ExportJsonlLine {
        idx: frame.idx,
        t_ns: seconds_to_ns(frame.t_s),
        dir: dir_label(frame.dir),
        len: frame.wire_len,
        protocol: protocol_label(frame.proto),
        name,
        type_name,
        key: frame_key(frame),
        layers: detail.layers,
        payload_hex: detail.bytes[payload_start..].to_string(),
        decoded: detail.decoded,
    }
}

fn seconds_to_ns(t_s: f64) -> u64 {
    if !t_s.is_finite() || t_s <= 0.0 {
        0
    } else {
        (t_s * 1_000_000_000.0).round().min(u64::MAX as f64) as u64
    }
}

fn dir_label(dir: u8) -> &'static str {
    match dir {
        DIR_RX => "rx",
        DIR_TX => "tx",
        _ => "unknown",
    }
}

fn protocol_label(proto: u8) -> &'static str {
    match proto {
        PROTO_SOMEIP => "SOME/IP",
        PROTO_SD => "SD",
        PROTO_GPTP => "gPTP",
        PROTO_ARP => "ARP",
        PROTO_UDP => "UDP",
        PROTO_TCP => "TCP",
        PROTO_ICMP => "ICMP",
        PROTO_IPV6 => "IPv6",
        PROTO_IPV4_OTHER => "IPv4",
        PROTO_OTHER => "Other",
        PROTO_DOIP => "DoIP",
        PROTO_MALFORMED => "Malformed",
        PROTO_ICMPV6 => "ICMPv6",
        PROTO_IGMP => "IGMP",
        PROTO_DHCP => "DHCP",
        PROTO_DNS => "DNS",
        PROTO_NTP => "NTP",
        PROTO_SSDP => "SSDP",
        PROTO_PTP => "PTP",
        PROTO_LLDP => "LLDP",
        PROTO_AVTP => "AVTP",
        PROTO_MACSEC => "MACsec",
        PROTO_EAPOL => "EAPOL",
        PROTO_HTTP => "HTTP",
        PROTO_TLS => "TLS",
        PROTO_SSH => "SSH",
        PROTO_SCTP => "SCTP",
        PROTO_TFTP => "TFTP",
        PROTO_SNMP => "SNMP",
        _ => "Unknown",
    }
}

fn display_name_and_type(frame: &GenFrame) -> (String, String) {
    match frame.proto {
        PROTO_SOMEIP => (
            format!("Service 0x{:04X}.0x{:04X}", frame.svc, frame.method),
            someip_type(frame.msg_type).into(),
        ),
        PROTO_SD => {
            let ty = sd_type(frame.msg_type);
            (format!("{ty} · {}", source_key(frame)), ty.into())
        }
        PROTO_GPTP => {
            let ty = gptp_type(frame.msg_type);
            (format!("{ty} · {}", source_key(frame)), ty.into())
        }
        PROTO_ARP => {
            let ty = arp_type(frame.msg_type);
            (ty.into(), ty.into())
        }
        PROTO_UDP | PROTO_TCP => (
            format!(
                "{}:{} → {}:{}",
                ipv4(frame.src_ip),
                frame.svc,
                ipv4(frame.dst_ip),
                frame.method
            ),
            String::new(),
        ),
        PROTO_ICMP => (
            format!("type {} code {}", frame.svc, frame.method),
            String::new(),
        ),
        PROTO_IPV6 => (format!("next header {}", frame.svc), String::new()),
        PROTO_IPV4_OTHER => (format!("protocol {}", frame.svc), String::new()),
        PROTO_OTHER => (format!("EtherType 0x{:04X}", frame.svc), String::new()),
        PROTO_MALFORMED => (format!("runt · {} bytes", frame.wire_len), String::new()),
        PROTO_ICMPV6 | PROTO_IGMP | PROTO_AVTP | PROTO_MACSEC | PROTO_EAPOL => (
            format!("{} Type {}", protocol_label(frame.proto), frame.msg_type),
            frame.msg_type.to_string(),
        ),
        PROTO_DHCP | PROTO_DNS | PROTO_NTP | PROTO_SSDP | PROTO_PTP | PROTO_HTTP | PROTO_TLS
        | PROTO_SSH | PROTO_SCTP | PROTO_TFTP | PROTO_SNMP | PROTO_DOIP => (
            format!("{} Type {}", protocol_label(frame.proto), frame.msg_type),
            frame.msg_type.to_string(),
        ),
        _ => (protocol_label(frame.proto).into(), String::new()),
    }
}

fn frame_key(frame: &GenFrame) -> String {
    let addr = source_addr_key(frame);
    match frame.proto {
        PROTO_SOMEIP => format!("0:{}:{}", frame.svc, frame.method),
        PROTO_SD => format!("1:{addr}"),
        PROTO_GPTP => format!("2:{addr}:{}", frame.msg_type),
        PROTO_ARP => format!("3:{addr}"),
        PROTO_UDP | PROTO_TCP => format!(
            "{}:{}:{}>{}:{}",
            frame.proto, frame.src_ip, frame.svc, frame.dst_ip, frame.method
        ),
        PROTO_ICMP => format!("6:{}>{}", frame.src_ip, frame.dst_ip),
        PROTO_IPV6 | PROTO_IPV4_OTHER | PROTO_OTHER => {
            format!("{}:{}:{}", frame.proto, frame.src_mac, frame.svc)
        }
        PROTO_MALFORMED => format!("11:{}", frame.src_mac),
        PROTO_ICMPV6 | PROTO_IGMP | PROTO_PTP => {
            format!("{}:{addr}:{}", frame.proto, frame.msg_type)
        }
        PROTO_LLDP | PROTO_MACSEC | PROTO_EAPOL => format!("{}:{}", frame.proto, frame.src_mac),
        PROTO_AVTP => format!("{}:{}:{}", frame.proto, frame.src_mac, frame.msg_type),
        _ => format!(
            "{}:{}:{}>{}:{}",
            frame.proto, frame.src_ip, frame.svc, frame.dst_ip, frame.method
        ),
    }
}

fn source_addr_key(frame: &GenFrame) -> u64 {
    if frame.src_ip == 0 {
        frame.src_mac
    } else {
        u64::from(frame.src_ip)
    }
}

fn source_key(frame: &GenFrame) -> String {
    if frame.src_ip == 0 {
        mac(frame.src_mac)
    } else {
        ipv4(frame.src_ip)
    }
}

fn ipv4(value: u32) -> String {
    let b = value.to_be_bytes();
    format!("{}.{}.{}.{}", b[0], b[1], b[2], b[3])
}

fn mac(value: u64) -> String {
    (0..6)
        .rev()
        .map(|n| format!("{:02x}", (value >> (n * 8)) & 0xff))
        .collect::<Vec<_>>()
        .join(":")
}

fn someip_type(ty: u8) -> &'static str {
    match ty {
        SOMEIP_TY_NOTIFICATION => "Notification",
        SOMEIP_TY_REQUEST => "Request",
        SOMEIP_TY_REQUEST_NO_RETURN => "RequestNoReturn",
        SOMEIP_TY_RESPONSE => "Response",
        SOMEIP_TY_ERROR => "Error",
        _ => "Other",
    }
}

fn sd_type(ty: u8) -> &'static str {
    match ty {
        SD_TY_OFFER => "Offer",
        SD_TY_FIND => "Find",
        SD_TY_STOP_OFFER => "StopOffer",
        SD_TY_SUBSCRIBE => "Subscribe",
        SD_TY_STOP_SUBSCRIBE => "StopSubscribe",
        SD_TY_SUBSCRIBE_ACK => "SubscribeAck",
        SD_TY_SUBSCRIBE_NACK => "SubscribeNack",
        SD_TY_EMPTY => "Empty",
        _ => "Other",
    }
}

fn gptp_type(ty: u8) -> &'static str {
    match ty {
        GPTP_TY_SYNC => "Sync",
        GPTP_TY_FOLLOW_UP => "FollowUp",
        GPTP_TY_PDELAY_REQ => "PdelayReq",
        GPTP_TY_PDELAY_RESP => "PdelayResp",
        GPTP_TY_PDELAY_RESP_FOLLOW_UP => "PdelayRespFollowUp",
        GPTP_TY_ANNOUNCE => "Announce",
        GPTP_TY_SIGNALING => "Signaling",
        _ => "Other",
    }
}

fn arp_type(ty: u8) -> &'static str {
    match ty {
        ARP_TY_REQUEST => "Request",
        ARP_TY_REPLY => "Reply",
        _ => "Other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::{
        fs,
        sync::{Arc, Mutex},
    };

    fn fixture_path() -> String {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("fixtures")
            .join("pcap")
            .join("sensor-fusion-5s.pcap")
            .to_string_lossy()
            .into_owned()
    }

    fn read_records(path: &str) -> Vec<radeau_pcap::Record> {
        let mut file = File::open(path).expect("fixture opens");
        let mut reader = radeau_pcap::PcapReader::new();
        let mut buf = [0u8; READ_CHUNK];
        let mut out = Vec::new();
        loop {
            match reader.next_record() {
                Ok(Some(record)) => out.push(record),
                Ok(None) => {
                    let count = file.read(&mut buf).expect("fixture reads");
                    if count == 0 {
                        reader.finish();
                    } else {
                        reader.push(&buf[..count]);
                    }
                }
                Err(radeau_pcap::PcapError::Ended { cut }) => {
                    assert!(!cut);
                    return out;
                }
                Err(error) => panic!("parse fixture: {error}"),
            }
        }
    }

    fn export_path(name: &str) -> String {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "radeau-{name}-{}-{}.jsonl",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn export_jsonl_file_fixture_matches_classify_and_dissect_cp_024() {
        // CP-024: one valid JSON line per frame, consistent with classify + dissect.
        let source = fixture_path();
        let out = export_path("fixture");
        let progress_events = Arc::new(Mutex::new(Vec::new()));
        let progress_capture = Arc::clone(&progress_events);
        let mut progress = JsonlProgress::new(move |done, total| {
            progress_capture.lock().unwrap().push((done, total));
        });
        let catalog = crate::catalog::CatalogState::default();
        let result = catalog.with_active(|active| {
            export_file_jsonl(out.clone(), source.clone(), active, &mut progress)
        });
        let result = result.expect("export succeeds");
        let records = read_records(&source);
        assert_eq!(result.frames, records.len() as u64);
        assert!(result.bytes > 0);
        let content = fs::read_to_string(&out).expect("jsonl exists");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), records.len());
        let mut endpoints = EndpointTable::default();
        let first_ts = records.first().map(|r| r.ts_ns).unwrap_or(0);
        for &sample in &[0usize, lines.len() / 2, lines.len().saturating_sub(1)] {
            let value: Value = serde_json::from_str(lines[sample]).expect("line parses");
            let record = &records[sample];
            let t_s = record.ts_ns.saturating_sub(first_ts) as f64 / 1_000_000_000.0;
            let frame =
                classify_frame(&record.wire, sample as u64, t_s, record.dir, &mut endpoints);
            let expected = line_from_frame(&frame, &record.wire, None);
            assert_eq!(value["idx"], expected.idx);
            assert_eq!(value["protocol"], expected.protocol);
            assert_eq!(value["name"], expected.name);
            assert_eq!(
                value["layers"].as_array().unwrap().len(),
                expected.layers.len()
            );
            assert!(value["payloadHex"].is_string());
        }
        assert_eq!(
            progress_events.lock().unwrap().last().copied().unwrap().0,
            fs::metadata(&source).unwrap().len()
        );
        let _ = fs::remove_file(out);
    }
}
