use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{capture::CaptureState, codes::*, frame::GenFrame};

#[derive(Debug, Default, Clone)]
pub struct EndpointNames {
    names: Vec<String>,
}

impl EndpointNames {
    fn get(&self, index: usize) -> Option<&str> {
        self.names.get(index).map(String::as_str)
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FrameRow {
    pub idx: u64,
    pub t_ns: u64,
    pub dir: &'static str,
    pub len: u32,
    pub protocol: &'static str,
    pub name: String,
    pub r#type: String,
    pub key: String,
    pub src: String,
    pub dst: String,
}

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceQuery {
    pub protocols: Option<Vec<String>>,
    pub name_contains: Option<String>,
    pub key: Option<String>,
    pub dir: Option<String>,
    pub from_ns: Option<u64>,
    pub to_ns: Option<u64>,
    pub after_idx: Option<u64>,
    pub limit: Option<u32>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TraceQueryResult {
    pub rows: Vec<FrameRow>,
    pub total: u64,
    pub next_idx: Option<u64>,
    pub ring: RingSpan,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RingSpan {
    pub first_idx: Option<u64>,
    pub last_idx: Option<u64>,
    pub frames: u64,
    pub first_t_ns: Option<u64>,
    pub last_t_ns: Option<u64>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RingStats {
    pub span: RingSpan,
    pub by_protocol: BTreeMap<String, u64>,
}

/// AU-005: one compact row per frame — the same naming the JSONL export uses.
pub fn frame_row(frame: &GenFrame, endpoints: Option<&EndpointNames>) -> FrameRow {
    let (name, type_name) = display_name_and_type(frame);
    FrameRow {
        idx: frame.idx,
        t_ns: seconds_to_ns(frame.t_s),
        dir: dir_label(frame.dir),
        len: frame.wire_len,
        protocol: protocol_label(frame.proto),
        name,
        r#type: type_name,
        key: frame_key(frame),
        src: endpoints
            .and_then(|names| names.get(frame.src_ep))
            .map(str::to_owned)
            .unwrap_or_else(|| source_key(frame)),
        dst: destination_key(frame),
    }
}

/// AU-005: filtered, paged rows straight from the core frame ring.
pub fn trace_query(state: &CaptureState, q: &TraceQuery) -> Result<TraceQueryResult, String> {
    let limit = q.limit.unwrap_or(100);
    if !(1..=500).contains(&limit) {
        return Err("limit must be 1..=500".into());
    }
    let frames = state.frame_ring_snapshot()?;
    let ring = ring_span(frames.iter().map(|retained| &retained.frame));
    let protocols = q.protocols.as_ref().map(|values| {
        values
            .iter()
            .map(|value| value.to_ascii_lowercase())
            .collect::<Vec<_>>()
    });
    let name_contains = q
        .name_contains
        .as_ref()
        .map(|value| value.to_ascii_lowercase());
    let dir = match q.dir.as_deref() {
        Some("rx" | "tx" | "unknown") | None => q.dir.as_deref(),
        Some(_) => return Err("dir must be rx, tx, or unknown".into()),
    };

    let mut rows = Vec::new();
    let mut total = 0u64;
    let mut next_idx = None;
    for retained in &frames {
        let row = frame_row(&retained.frame, None);
        if !matches_query(&row, q, protocols.as_deref(), name_contains.as_deref(), dir) {
            continue;
        }
        total += 1;
        if rows.len() < limit as usize {
            rows.push(row);
        } else if next_idx.is_none() {
            next_idx = rows.last().map(|row| row.idx);
        }
    }

    Ok(TraceQueryResult {
        rows,
        total,
        next_idx,
        ring,
    })
}

/// AU-007: ring span and per-protocol counts.
pub fn trace_stats_ring(state: &CaptureState) -> RingStats {
    let frames = state.frame_ring_snapshot().unwrap_or_default();
    let mut by_protocol = BTreeMap::new();
    for retained in &frames {
        *by_protocol
            .entry(protocol_label(retained.frame.proto).to_string())
            .or_insert(0) += 1;
    }
    RingStats {
        span: ring_span(frames.iter().map(|retained| &retained.frame)),
        by_protocol,
    }
}

fn matches_query(
    row: &FrameRow,
    q: &TraceQuery,
    protocols: Option<&[String]>,
    name_contains: Option<&str>,
    dir: Option<&str>,
) -> bool {
    if let Some(protocols) = protocols {
        let protocol = row.protocol.to_ascii_lowercase();
        if !protocols.iter().any(|value| value == &protocol) {
            return false;
        }
    }
    if let Some(needle) = name_contains {
        if !row.name.to_ascii_lowercase().contains(needle) {
            return false;
        }
    }
    if q.key.as_ref().is_some_and(|key| key != &row.key) {
        return false;
    }
    if dir.is_some_and(|dir| dir != row.dir) {
        return false;
    }
    if q.from_ns.is_some_and(|from| row.t_ns < from) {
        return false;
    }
    if q.to_ns.is_some_and(|to| row.t_ns > to) {
        return false;
    }
    if q.after_idx.is_some_and(|after| row.idx <= after) {
        return false;
    }
    true
}

fn ring_span<'a>(frames: impl Iterator<Item = &'a GenFrame>) -> RingSpan {
    let mut first_idx = None;
    let mut last_idx = None;
    let mut first_t_ns = None;
    let mut last_t_ns = None;
    let mut count = 0u64;
    for frame in frames {
        let t_ns = seconds_to_ns(frame.t_s);
        first_idx.get_or_insert(frame.idx);
        first_t_ns.get_or_insert(t_ns);
        last_idx = Some(frame.idx);
        last_t_ns = Some(t_ns);
        count += 1;
    }
    RingSpan {
        first_idx,
        last_idx,
        frames: count,
        first_t_ns,
        last_t_ns,
    }
}

pub(crate) fn seconds_to_ns(t_s: f64) -> u64 {
    if !t_s.is_finite() || t_s <= 0.0 {
        0
    } else {
        (t_s * 1_000_000_000.0).round().min(u64::MAX as f64) as u64
    }
}

pub(crate) fn dir_label(dir: u8) -> &'static str {
    match dir {
        DIR_RX => "rx",
        DIR_TX => "tx",
        _ => "unknown",
    }
}

pub(crate) fn protocol_label(proto: u8) -> &'static str {
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

fn destination_key(frame: &GenFrame) -> String {
    if frame.dst_ip == 0 {
        String::new()
    } else {
        ipv4(frame.dst_ip)
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
    use std::time::Instant;

    use super::*;

    fn frame(idx: u64, proto: u8, t_s: f64, dir: u8, name_seed: u16) -> GenFrame {
        GenFrame {
            idx,
            t_s,
            dir,
            src_ep: 0,
            proto,
            svc: name_seed,
            method: name_seed + 1,
            msg_type: if proto == PROTO_SOMEIP {
                SOMEIP_TY_REQUEST
            } else {
                0
            },
            session: -1,
            wire_len: 64,
            snap: [0; crate::frame::SNAP_LEN],
            src_ip: u32::from_be_bytes([10, 42, 0, (idx + 1) as u8]),
            dst_ip: u32::from_be_bytes([10, 42, 1, (idx + 1) as u8]),
            src_mac: idx + 1,
            vlan: -1,
            payload_off: 42,
        }
    }

    fn state_with_frames(frames: Vec<GenFrame>) -> CaptureState {
        let state = CaptureState::default();
        for frame in frames {
            state.retain_frame_for_test(frame, vec![0; 64]);
        }
        state
    }

    #[test]
    fn au_005_empty_ring_returns_empty_result() {
        let result = trace_query(&CaptureState::default(), &TraceQuery::default()).unwrap();
        assert!(result.rows.is_empty());
        assert_eq!(result.total, 0);
        assert_eq!(result.next_idx, None);
        assert_eq!(result.ring.frames, 0);
    }

    #[test]
    fn au_005_filters_are_and_combined_case_insensitively() {
        let state = state_with_frames(vec![
            frame(0, PROTO_SOMEIP, 0.001, DIR_RX, 0x1000),
            frame(1, PROTO_SOMEIP, 0.002, DIR_TX, 0x2000),
            frame(2, PROTO_TCP, 0.003, DIR_RX, 0x1000),
        ]);
        let key = frame_row(&frame(0, PROTO_SOMEIP, 0.001, DIR_RX, 0x1000), None).key;
        let result = trace_query(
            &state,
            &TraceQuery {
                protocols: Some(vec!["some/ip".into()]),
                name_contains: Some("0x1000".into()),
                key: Some(key),
                dir: Some("rx".into()),
                from_ns: Some(1_000_000),
                to_ns: Some(1_000_000),
                ..TraceQuery::default()
            },
        )
        .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.rows[0].idx, 0);
    }

    #[test]
    fn au_005_paging_visits_every_match_once_and_reports_total() {
        let state = state_with_frames(
            (0..7)
                .map(|idx| frame(idx, PROTO_UDP, idx as f64, DIR_RX, 10))
                .collect(),
        );
        let mut seen = Vec::new();
        let mut after_idx = None;
        loop {
            let result = trace_query(
                &state,
                &TraceQuery {
                    protocols: Some(vec!["udp".into()]),
                    after_idx,
                    limit: Some(3),
                    ..TraceQuery::default()
                },
            )
            .unwrap();
            assert_eq!(result.total, 7 - after_idx.map_or(0, |idx| idx + 1));
            seen.extend(result.rows.iter().map(|row| row.idx));
            after_idx = result.next_idx;
            if after_idx.is_none() {
                break;
            }
        }
        assert_eq!(seen, vec![0, 1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn au_005_evicted_frames_are_absent() {
        let state = CaptureState::default();
        for idx in 0..65_538 {
            state
                .retain_frame_for_test(frame(idx, PROTO_TCP, idx as f64, DIR_RX, 100), vec![0; 64]);
        }
        let result = trace_query(&state, &TraceQuery::default()).unwrap();
        assert_eq!(result.ring.frames, 65_536);
        assert_eq!(result.ring.first_idx, Some(2));
        assert!(!result.rows.iter().any(|row| row.idx < 2));
    }

    #[test]
    fn au_007_ring_stats_counts_by_protocol() {
        let state = state_with_frames(vec![
            frame(0, PROTO_TCP, 0.0, DIR_RX, 10),
            frame(1, PROTO_TCP, 0.5, DIR_RX, 10),
            frame(2, PROTO_UDP, 1.0, DIR_TX, 10),
        ]);
        let stats = trace_stats_ring(&state);
        assert_eq!(stats.span.frames, 3);
        assert_eq!(stats.by_protocol["TCP"], 2);
        assert_eq!(stats.by_protocol["UDP"], 1);
    }

    #[test]
    fn au_005_rejects_invalid_limit() {
        let err = trace_query(
            &CaptureState::default(),
            &TraceQuery {
                limit: Some(501),
                ..TraceQuery::default()
            },
        )
        .unwrap_err();
        assert_eq!(err, "limit must be 1..=500");
    }

    #[test]
    #[ignore]
    fn au_005_full_ring_query_is_under_50_ms_in_release() {
        let state = state_with_frames(
            (0..65_536)
                .map(|idx| frame(idx, PROTO_SOMEIP, idx as f64 / 1_000_000.0, DIR_RX, 0x1000))
                .collect(),
        );
        let start = Instant::now();
        let result = trace_query(
            &state,
            &TraceQuery {
                protocols: Some(vec!["some/ip".into()]),
                limit: Some(500),
                ..TraceQuery::default()
            },
        )
        .unwrap();
        assert_eq!(result.total, 65_536);
        assert!(start.elapsed().as_millis() < 50);
    }
}
