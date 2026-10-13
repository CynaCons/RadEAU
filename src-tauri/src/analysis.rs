use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs::File,
    io::Read,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use radeau_catalog::Catalog;
use radeau_proto::{ethernet::EthernetFrame, gptp, sd, someip};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::{
    capture::CaptureState,
    classify::classify_frame,
    codes::*,
    endpoints::EndpointTable,
    frame::GenFrame,
    rows::{frame_row, protocol_label, seconds_to_ns},
};

const MAX_KEYS: usize = 10_000;
const MAX_SAMPLES: usize = 4_096;
/// Gap candidates kept per key (AN-001: bounded regardless of trace length).
const MAX_GAP_CANDIDATES: usize = 4_096;
const MAX_REPORT_GAPS: usize = 100;
const BURST_WINDOW_NS: u64 = 10_000_000;
const READ_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AnalysisFrom {
    Ring,
    File { path: String },
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sections {
    pub overview: bool,
    pub someip: bool,
    pub sd: bool,
    pub ptp: bool,
    pub bursts: bool,
}

impl Sections {
    fn resolved(&self) -> Self {
        if self.overview || self.someip || self.sd || self.ptp || self.bursts {
            self.clone()
        } else {
            Self {
                overview: true,
                someip: true,
                sd: true,
                ptp: true,
                bursts: true,
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisReport {
    pub source: AnalysisSource,
    pub generated_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overview: Option<OverviewReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub someip: Option<SomeipReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sd: Option<SdReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ptp: Option<PtpReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bursts: Option<BurstReport>,
    pub overflow: OverflowReport,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisSource {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverviewReport {
    pub frames: u64,
    pub bytes: u64,
    pub duration_ns: u64,
    pub first_ns: u64,
    pub last_ns: u64,
    pub protocols: Vec<ProtocolSummary>,
    pub endpoints: Vec<EndpointSummary>,
    pub conversations: Vec<ConversationSummary>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolSummary {
    pub protocol: String,
    pub frames: u64,
    pub bytes: u64,
    pub share: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EndpointSummary {
    pub endpoint: String,
    pub kind: String,
    pub frames_sent: u64,
    pub bytes_sent: u64,
    pub protocols: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub a: String,
    pub b: String,
    pub transport: String,
    pub frames: u64,
    pub bytes: u64,
    pub first_ns: u64,
    pub last_ns: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SomeipReport {
    pub services: Vec<SomeipServiceReport>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SomeipServiceReport {
    pub service: u16,
    pub method: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method_name: Option<String>,
    pub counts: SomeipCounts,
    pub senders: Vec<SomeipSenderReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency: Option<Stats>,
    pub unanswered: u64,
    pub errors: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SomeipCounts {
    pub request: u64,
    pub request_no_return: u64,
    pub notification: u64,
    pub response: u64,
    pub error: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SomeipSenderReport {
    pub sender: String,
    pub count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period: Option<Stats>,
    pub gaps: Vec<Gap>,
    pub gaps_total: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SdReport {
    pub instances: Vec<SdInstanceReport>,
    pub eventgroups: Vec<SdEventgroupReport>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SdInstanceReport {
    pub service: u16,
    pub instance: u16,
    pub sender: String,
    pub offers: u64,
    pub stop_offers: u64,
    pub first_ns: u64,
    pub last_ns: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period: Option<Stats>,
    pub last_ttl: u32,
    pub reboots: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SdEventgroupReport {
    pub service: u16,
    pub instance: u16,
    pub eventgroup: u32,
    pub subscribes: u64,
    pub acks: u64,
    pub nacks: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PtpReport {
    pub senders: Vec<PtpSenderReport>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PtpSenderReport {
    pub sender: String,
    pub sync: u64,
    pub follow_up: u64,
    pub pdelay_req: u64,
    pub pdelay_resp: u64,
    pub announce: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_period: Option<Stats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grandmaster: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BurstReport {
    pub window_ns: u64,
    pub max_frames: u64,
    pub top: Vec<BurstWindow>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BurstWindow {
    pub start_ns: u64,
    pub frames: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OverflowReport {
    pub keys_dropped: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub count: u64,
    pub mean_ns: f64,
    pub min_ns: u64,
    pub max_ns: u64,
    pub p50_ns: u64,
    pub p99_ns: u64,
    pub stddev_ns: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub at_ns: u64,
    pub gap_ns: u64,
}

/// Exact count/mean/min/max/stddev (Welford) plus a uniform reservoir of at
/// most `MAX_SAMPLES` values for the quantiles (AN-001) — sampled over the
/// whole trace, not just its beginning.
#[derive(Default)]
struct RunningStats {
    count: u64,
    mean: f64,
    m2: f64,
    min: u64,
    max: u64,
    samples: Vec<u64>,
    rng: u64,
}

impl RunningStats {
    fn push(&mut self, value: u64) {
        self.count += 1;
        let value_f = value as f64;
        let delta = value_f - self.mean;
        self.mean += delta / self.count as f64;
        self.m2 += delta * (value_f - self.mean);
        self.min = if self.count == 1 {
            value
        } else {
            self.min.min(value)
        };
        self.max = self.max.max(value);
        if self.samples.len() < MAX_SAMPLES {
            self.samples.push(value);
        } else {
            // Algorithm R with a deterministic xorshift: analysis is reproducible.
            if self.rng == 0 {
                self.rng = 0x9e37_79b9_7f4a_7c15;
            }
            self.rng ^= self.rng << 13;
            self.rng ^= self.rng >> 7;
            self.rng ^= self.rng << 17;
            let slot = self.rng % self.count;
            if let Ok(slot) = usize::try_from(slot) {
                if slot < MAX_SAMPLES {
                    self.samples[slot] = value;
                }
            }
        }
    }

    fn finish(&self) -> Option<Stats> {
        if self.count == 0 {
            return None;
        }
        let mut samples = self.samples.clone();
        samples.sort_unstable();
        let p50 = percentile(&samples, 0.50);
        let p99 = percentile(&samples, 0.99);
        Some(Stats {
            count: self.count,
            mean_ns: self.mean,
            min_ns: self.min,
            max_ns: self.max,
            p50_ns: p50,
            p99_ns: p99,
            stddev_ns: (self.m2 / self.count as f64).sqrt(),
        })
    }

    fn median(&self) -> Option<u64> {
        if self.samples.is_empty() {
            return None;
        }
        let mut samples = self.samples.clone();
        samples.sort_unstable();
        Some(percentile(&samples, 0.50))
    }
}

fn percentile(sorted: &[u64], q: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let pos = ((sorted.len() - 1) as f64 * q).ceil() as usize;
    sorted[pos.min(sorted.len() - 1)]
}

/// Inter-arrival statistics and gaps for one key (AN-003). A gap is an
/// interval above 3 x the median; since the median is only known at the end,
/// the pass keeps bounded *candidates* — intervals above 2 x the running mean
/// (every interval while fewer than 16 are seen) — and the finish filters them.
#[derive(Default)]
struct PeriodTracker {
    count: u64,
    last_ns: Option<u64>,
    stats: RunningStats,
    candidates: Vec<Gap>,
    candidates_dropped: u64,
}

impl PeriodTracker {
    fn observe(&mut self, t_ns: u64) {
        self.count += 1;
        if let Some(last) = self.last_ns {
            let gap = t_ns.saturating_sub(last);
            let candidate = self.stats.count < 16 || (gap as f64) > 2.0 * self.stats.mean;
            self.stats.push(gap);
            if candidate {
                if self.candidates.len() < MAX_GAP_CANDIDATES {
                    self.candidates.push(Gap {
                        at_ns: t_ns,
                        gap_ns: gap,
                    });
                } else {
                    self.candidates_dropped += 1;
                }
            }
        }
        self.last_ns = Some(t_ns);
    }

    /// (stats, listed gaps, total gaps). `total` also counts candidates that
    /// overflowed the bounded buffer (they were above twice the mean).
    fn finish(&self, cap: Option<usize>) -> (Option<Stats>, Vec<Gap>, u64) {
        let Some(median) = self.stats.median() else {
            return (self.stats.finish(), Vec::new(), 0);
        };
        let mut total = self.candidates_dropped;
        let mut gaps = Vec::new();
        for gap in &self.candidates {
            if gap.gap_ns > median.saturating_mul(3) {
                total += 1;
                if cap.is_none_or(|limit| gaps.len() < limit) {
                    gaps.push(gap.clone());
                }
            }
        }
        (self.stats.finish(), gaps, total)
    }
}

#[derive(Default)]
/// AN-002: protocols, endpoints, conversations.
struct OverviewAcc {
    frames: u64,
    bytes: u64,
    first_ns: Option<u64>,
    last_ns: u64,
    protocols: HashMap<String, CountBytes>,
    endpoints: HashMap<String, EndpointAcc>,
    conversations: HashMap<(String, String, String), ConversationAcc>,
}

#[derive(Default)]
struct CountBytes {
    frames: u64,
    bytes: u64,
}

#[derive(Default)]
struct EndpointAcc {
    kind: String,
    frames_sent: u64,
    bytes_sent: u64,
    protocols: BTreeMap<String, ()>,
}

#[derive(Default)]
struct ConversationAcc {
    frames: u64,
    bytes: u64,
    first_ns: u64,
    last_ns: u64,
}

#[derive(Default)]
struct SomeipAcc {
    services: HashMap<(u16, u16), SomeipServiceAcc>,
    requests: HashMap<RequestKey, u64>,
}

#[derive(Default)]
struct SomeipServiceAcc {
    counts: SomeipCounts,
    senders: HashMap<String, PeriodTracker>,
    latency: RunningStats,
    unanswered: u64,
    errors: u64,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct RequestKey {
    service: u16,
    method: u16,
    session: i32,
    a: String,
    b: String,
}

#[derive(Default)]
/// AN-004: SD instances (offers, period, TTL, reboots) and eventgroups.
struct SdAcc {
    instances: HashMap<(u16, u16, String), SdInstanceAcc>,
    eventgroups: HashMap<(u16, u16, u32), SdEventgroupAcc>,
}

#[derive(Default)]
struct SdInstanceAcc {
    offers: u64,
    stop_offers: u64,
    first_ns: u64,
    last_ns: u64,
    period: PeriodTracker,
    last_ttl: u32,
    reboots: u64,
    last_reboot: Option<bool>,
    last_session: Option<i32>,
}

#[derive(Default)]
struct SdEventgroupAcc {
    subscribes: u64,
    acks: u64,
    nacks: u64,
}

#[derive(Default)]
/// AN-005: gPTP message counts, Sync period, grandmaster per sender.
struct PtpAcc {
    senders: HashMap<String, PtpSenderAcc>,
}

#[derive(Default)]
struct PtpSenderAcc {
    sync: u64,
    follow_up: u64,
    pdelay_req: u64,
    pdelay_resp: u64,
    announce: u64,
    sync_period: PeriodTracker,
    grandmaster: Option<String>,
}

#[derive(Default)]
/// AN-006: densest 10 ms windows.
struct BurstAcc {
    window: VecDeque<u64>,
    top: Vec<BurstWindow>,
    max_frames: u64,
}

#[derive(Default)]
struct Analyzer {
    overview: OverviewAcc,
    someip: SomeipAcc,
    sd: SdAcc,
    ptp: PtpAcc,
    bursts: BurstAcc,
    keys_dropped: u64,
    sections: Sections,
    gap_cap: Option<usize>,
}

impl Analyzer {
    fn new(sections: Sections, gap_cap: Option<usize>) -> Self {
        Self {
            sections,
            gap_cap,
            ..Self::default()
        }
    }

    fn process(&mut self, frame: &GenFrame, wire: &[u8]) {
        let t_ns = seconds_to_ns(frame.t_s);
        if self.sections.overview {
            self.process_overview(frame, wire, t_ns);
        }
        if self.sections.someip && frame.proto == PROTO_SOMEIP {
            self.process_someip(frame, wire, t_ns);
        }
        if self.sections.sd && frame.proto == PROTO_SD {
            self.process_sd(frame, wire, t_ns);
        }
        if self.sections.ptp && frame.proto == PROTO_GPTP {
            self.process_ptp(frame, wire, t_ns);
        }
        if self.sections.bursts {
            self.process_burst(t_ns);
        }
    }

    fn process_overview(&mut self, frame: &GenFrame, wire: &[u8], t_ns: u64) {
        self.overview.frames += 1;
        self.overview.bytes += u64::from(frame.wire_len);
        self.overview.first_ns.get_or_insert(t_ns);
        self.overview.last_ns = t_ns;
        let protocol = frame_row(frame, None).protocol.to_string();
        if let Some(entry) = get_or_count_drop(
            &mut self.overview.protocols,
            protocol.clone(),
            &mut self.keys_dropped,
        ) {
            entry.frames += 1;
            entry.bytes += u64::from(frame.wire_len);
        }
        let endpoint = source_endpoint(frame);
        if let Some(entry) = get_or_count_drop(
            &mut self.overview.endpoints,
            endpoint.clone(),
            &mut self.keys_dropped,
        ) {
            entry.kind = if frame.src_ip != 0 { "ipv4" } else { "mac" }.into();
            entry.frames_sent += 1;
            entry.bytes_sent += u64::from(frame.wire_len);
            entry.protocols.insert(protocol, ());
        }
        let dst = destination_endpoint(frame, wire);
        if let Some(dst) = dst.filter(|dst| dst != &endpoint) {
            let (a, b) = ordered_pair(endpoint, dst);
            let transport = transport_label(frame).to_string();
            if let Some(entry) = get_or_count_drop(
                &mut self.overview.conversations,
                (a, b, transport),
                &mut self.keys_dropped,
            ) {
                if entry.frames == 0 {
                    entry.first_ns = t_ns;
                }
                entry.frames += 1;
                entry.bytes += u64::from(frame.wire_len);
                entry.last_ns = t_ns;
            }
        }
    }

    fn process_someip(&mut self, frame: &GenFrame, wire: &[u8], t_ns: u64) {
        let key = (frame.svc, frame.method);
        let sender = source_endpoint(frame);
        let Some(service) =
            get_or_count_drop(&mut self.someip.services, key, &mut self.keys_dropped)
        else {
            return;
        };
        match frame.msg_type {
            SOMEIP_TY_REQUEST => service.counts.request += 1,
            SOMEIP_TY_REQUEST_NO_RETURN => service.counts.request_no_return += 1,
            SOMEIP_TY_NOTIFICATION => service.counts.notification += 1,
            SOMEIP_TY_RESPONSE => service.counts.response += 1,
            SOMEIP_TY_ERROR => {
                service.counts.error += 1;
                service.errors += 1;
            }
            _ => {}
        }
        if frame.msg_type == SOMEIP_TY_NOTIFICATION {
            if let Some(period) =
                get_or_count_drop(&mut service.senders, sender.clone(), &mut self.keys_dropped)
            {
                period.observe(t_ns);
            }
        }
        if matches!(
            frame.msg_type,
            SOMEIP_TY_REQUEST | SOMEIP_TY_RESPONSE | SOMEIP_TY_ERROR
        ) {
            let a = source_endpoint(frame);
            let b = destination_endpoint(frame, wire).unwrap_or_default();
            let (left, right) = ordered_pair(a, b);
            let request = RequestKey {
                service: frame.svc,
                method: frame.method,
                session: frame.session,
                a: left,
                b: right,
            };
            if frame.msg_type == SOMEIP_TY_REQUEST {
                if self.someip.requests.contains_key(&request)
                    || self.someip.requests.len() < MAX_KEYS
                {
                    self.someip.requests.insert(request, t_ns);
                } else {
                    self.keys_dropped += 1;
                }
            } else if let Some(start_ns) = self.someip.requests.remove(&request) {
                service.latency.push(t_ns.saturating_sub(start_ns));
            }
        }
    }

    fn process_sd(&mut self, frame: &GenFrame, wire: &[u8], t_ns: u64) {
        let Some((header, payload)) = someip_payload(frame, wire) else {
            return;
        };
        let Ok(message) = sd::parse(payload) else {
            return;
        };
        let sender = source_endpoint(frame);
        let reboot = message.flags & 0x80 != 0;
        for entry in message.entries {
            match entry.entry_type {
                sd::ENTRY_OFFER_SERVICE => {
                    let key = (entry.service_id, entry.instance_id, sender.clone());
                    let Some(instance) =
                        get_or_count_drop(&mut self.sd.instances, key, &mut self.keys_dropped)
                    else {
                        continue;
                    };
                    if instance.offers + instance.stop_offers == 0 {
                        instance.first_ns = t_ns;
                    }
                    instance.last_ns = t_ns;
                    instance.last_ttl = entry.ttl;
                    if entry.ttl == 0 {
                        instance.stop_offers += 1;
                    } else {
                        instance.offers += 1;
                        instance.period.observe(t_ns);
                    }
                    if instance.last_reboot == Some(false) && reboot {
                        instance.reboots += 1;
                    }
                    if instance
                        .last_session
                        .is_some_and(|last| (header.session_id as i32) < last)
                    {
                        instance.reboots += 1;
                    }
                    instance.last_reboot = Some(reboot);
                    instance.last_session = Some(header.session_id as i32);
                }
                sd::ENTRY_SUBSCRIBE_EVENTGROUP | sd::ENTRY_SUBSCRIBE_EVENTGROUP_ACK => {
                    let key = (entry.service_id, entry.instance_id, entry.minor_version);
                    let Some(group) =
                        get_or_count_drop(&mut self.sd.eventgroups, key, &mut self.keys_dropped)
                    else {
                        continue;
                    };
                    if entry.entry_type == sd::ENTRY_SUBSCRIBE_EVENTGROUP {
                        group.subscribes += 1;
                    } else if entry.ttl == 0 {
                        group.nacks += 1;
                    } else {
                        group.acks += 1;
                    }
                }
                _ => {}
            }
        }
    }

    fn process_ptp(&mut self, frame: &GenFrame, wire: &[u8], t_ns: u64) {
        let sender = mac_string(frame.src_mac);
        let Some(entry) = get_or_count_drop(&mut self.ptp.senders, sender, &mut self.keys_dropped)
        else {
            return;
        };
        match frame.msg_type {
            GPTP_TY_SYNC => {
                entry.sync += 1;
                entry.sync_period.observe(t_ns);
            }
            GPTP_TY_FOLLOW_UP => entry.follow_up += 1,
            GPTP_TY_PDELAY_REQ => entry.pdelay_req += 1,
            GPTP_TY_PDELAY_RESP => entry.pdelay_resp += 1,
            GPTP_TY_ANNOUNCE => {
                entry.announce += 1;
                entry.grandmaster = grandmaster_identity(frame, wire);
            }
            _ => {}
        }
    }

    fn process_burst(&mut self, t_ns: u64) {
        self.bursts.window.push_back(t_ns);
        while self
            .bursts
            .window
            .front()
            .is_some_and(|first| t_ns.saturating_sub(*first) > BURST_WINDOW_NS)
        {
            self.bursts.window.pop_front();
        }
        let frames = self.bursts.window.len() as u64;
        self.bursts.max_frames = self.bursts.max_frames.max(frames);
        let start_ns = *self.bursts.window.front().unwrap_or(&t_ns);
        self.bursts.top.push(BurstWindow { start_ns, frames });
        self.bursts.top.sort_by(|a, b| {
            b.frames
                .cmp(&a.frames)
                .then_with(|| a.start_ns.cmp(&b.start_ns))
        });
        self.bursts.top.dedup_by_key(|w| w.start_ns);
        self.bursts.top.truncate(5);
    }

    fn finish(mut self, source: AnalysisSource, catalog: Option<&Catalog>) -> AnalysisReport {
        for request in self.someip.requests.values() {
            let _ = request;
        }
        for ((service, method), service_acc) in &mut self.someip.services {
            let unanswered = self
                .someip
                .requests
                .keys()
                .filter(|key| key.service == *service && key.method == *method)
                .count() as u64;
            service_acc.unanswered = unanswered;
        }
        AnalysisReport {
            source,
            generated_at_ms: generated_at_ms(),
            overview: self
                .sections
                .overview
                .then(|| finish_overview(self.overview)),
            someip: self
                .sections
                .someip
                .then(|| finish_someip(self.someip, catalog, self.gap_cap)),
            sd: self.sections.sd.then(|| finish_sd(self.sd)),
            ptp: self.sections.ptp.then(|| finish_ptp(self.ptp)),
            bursts: self.sections.bursts.then_some(BurstReport {
                window_ns: BURST_WINDOW_NS,
                max_frames: self.bursts.max_frames,
                top: self.bursts.top,
            }),
            overflow: OverflowReport {
                keys_dropped: self.keys_dropped,
            },
        }
    }
}

fn get_or_count_drop<'a, K, V>(
    map: &'a mut HashMap<K, V>,
    key: K,
    dropped: &mut u64,
) -> Option<&'a mut V>
where
    K: Eq + std::hash::Hash,
    V: Default,
{
    if map.contains_key(&key) || map.len() < MAX_KEYS {
        Some(map.entry(key).or_default())
    } else {
        *dropped += 1;
        None
    }
}

/// AN-001 / AN-009: one bounded pass over the ring or a file; periods are
/// measured on the frames' own timestamps, so a seeded fixture reproduces
/// the simulator schedules exactly.
pub fn analyze(
    capture: &CaptureState,
    from: &AnalysisFrom,
    sections: &Sections,
    catalog: Option<&Catalog>,
) -> Result<AnalysisReport, String> {
    analyze_inner(capture, from, sections, catalog, Some(MAX_REPORT_GAPS))
}

fn analyze_inner(
    capture: &CaptureState,
    from: &AnalysisFrom,
    sections: &Sections,
    catalog: Option<&Catalog>,
    gap_cap: Option<usize>,
) -> Result<AnalysisReport, String> {
    let sections = sections.resolved();
    let mut analyzer = Analyzer::new(sections, gap_cap);
    match from {
        AnalysisFrom::Ring => {
            // AN-001: snapshot the bounded ring once, then analyze off-lock.
            for retained in capture.frame_ring_snapshot()? {
                analyzer.process(&retained.frame, &retained.wire);
            }
            Ok(analyzer.finish(
                AnalysisSource {
                    kind: "ring".into(),
                    path: None,
                },
                catalog,
            ))
        }
        AnalysisFrom::File { path } => {
            // AN-001: stream pcaps through the shared reader and classifier.
            analyze_file(path, analyzer, catalog)
        }
    }
}

fn analyze_file(
    path: &str,
    mut analyzer: Analyzer,
    catalog: Option<&Catalog>,
) -> Result<AnalysisReport, String> {
    let mut input = File::open(Path::new(path)).map_err(|error| format!("open {path}: {error}"))?;
    let mut reader = radeau_pcap::PcapReader::new();
    let mut endpoints = EndpointTable::default();
    let mut scratch = [0u8; READ_CHUNK];
    let mut idx = 0u64;
    let mut first_ts = None;
    loop {
        match reader.next_record() {
            Ok(Some(record)) => {
                let first = *first_ts.get_or_insert(record.ts_ns);
                let t_s = record.ts_ns.saturating_sub(first) as f64 / 1_000_000_000.0;
                let frame = classify_frame(&record.wire, idx, t_s, record.dir, &mut endpoints);
                analyzer.process(&frame, &record.wire);
                idx += 1;
            }
            Ok(None) => {
                let count = input
                    .read(&mut scratch)
                    .map_err(|error| format!("read {path}: {error}"))?;
                if count == 0 {
                    reader.finish();
                } else {
                    reader.push(&scratch[..count]);
                }
            }
            Err(radeau_pcap::PcapError::Ended { cut }) => {
                if cut {
                    return Err("capture ended (truncated)".into());
                }
                return Ok(analyzer.finish(
                    AnalysisSource {
                        kind: "file".into(),
                        path: Some(path.to_string()),
                    },
                    catalog,
                ));
            }
            Err(error) => return Err(format!("{path}: {error}")),
        }
    }
}

fn finish_overview(acc: OverviewAcc) -> OverviewReport {
    let mut protocols = acc
        .protocols
        .into_iter()
        .map(|(protocol, counts)| ProtocolSummary {
            protocol,
            frames: counts.frames,
            bytes: counts.bytes,
            share: if acc.frames == 0 {
                0.0
            } else {
                counts.frames as f64 / acc.frames as f64
            },
        })
        .collect::<Vec<_>>();
    protocols.sort_by(|a, b| {
        b.frames
            .cmp(&a.frames)
            .then_with(|| a.protocol.cmp(&b.protocol))
    });
    let mut endpoints = acc
        .endpoints
        .into_iter()
        .map(|(endpoint, entry)| EndpointSummary {
            endpoint,
            kind: entry.kind,
            frames_sent: entry.frames_sent,
            bytes_sent: entry.bytes_sent,
            protocols: entry.protocols.into_keys().collect(),
        })
        .collect::<Vec<_>>();
    endpoints.sort_by(|a, b| {
        b.frames_sent
            .cmp(&a.frames_sent)
            .then_with(|| a.endpoint.cmp(&b.endpoint))
    });
    let mut conversations = acc
        .conversations
        .into_iter()
        .map(|((a, b, transport), entry)| ConversationSummary {
            a,
            b,
            transport,
            frames: entry.frames,
            bytes: entry.bytes,
            first_ns: entry.first_ns,
            last_ns: entry.last_ns,
        })
        .collect::<Vec<_>>();
    conversations.sort_by(|a, b| b.frames.cmp(&a.frames).then_with(|| a.a.cmp(&b.a)));
    OverviewReport {
        frames: acc.frames,
        bytes: acc.bytes,
        duration_ns: acc
            .first_ns
            .map_or(0, |first| acc.last_ns.saturating_sub(first)),
        first_ns: acc.first_ns.unwrap_or(0),
        last_ns: acc.last_ns,
        protocols,
        endpoints,
        conversations,
    }
}

fn finish_someip(
    acc: SomeipAcc,
    catalog: Option<&Catalog>,
    gap_cap: Option<usize>,
) -> SomeipReport {
    let mut services = acc
        .services
        .into_iter()
        .map(|((service, method), entry)| {
            let names = catalog_names(catalog, service, method);
            let mut senders = entry
                .senders
                .into_iter()
                .map(|(sender, period)| {
                    let (stats, gaps, gaps_total) = period.finish(gap_cap);
                    SomeipSenderReport {
                        sender,
                        count: period.count,
                        period: stats,
                        gaps,
                        gaps_total,
                    }
                })
                .collect::<Vec<_>>();
            senders.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.sender.cmp(&b.sender)));
            SomeipServiceReport {
                service,
                method,
                service_name: names.0,
                method_name: names.1,
                counts: entry.counts,
                senders,
                latency: entry.latency.finish(),
                unanswered: entry.unanswered,
                errors: entry.errors,
            }
        })
        .collect::<Vec<_>>();
    services.sort_by_key(|a| (a.service, a.method));
    SomeipReport { services }
}

fn finish_sd(acc: SdAcc) -> SdReport {
    let mut instances = acc
        .instances
        .into_iter()
        .map(|((service, instance, sender), entry)| SdInstanceReport {
            service,
            instance,
            sender,
            offers: entry.offers,
            stop_offers: entry.stop_offers,
            first_ns: entry.first_ns,
            last_ns: entry.last_ns,
            period: entry.period.stats.finish(),
            last_ttl: entry.last_ttl,
            reboots: entry.reboots,
        })
        .collect::<Vec<_>>();
    instances.sort_by(|a, b| {
        (a.service, a.instance, &a.sender).cmp(&(b.service, b.instance, &b.sender))
    });
    let mut eventgroups = acc
        .eventgroups
        .into_iter()
        .map(
            |((service, instance, eventgroup), entry)| SdEventgroupReport {
                service,
                instance,
                eventgroup,
                subscribes: entry.subscribes,
                acks: entry.acks,
                nacks: entry.nacks,
            },
        )
        .collect::<Vec<_>>();
    eventgroups.sort_by(|a, b| {
        (a.service, a.instance, a.eventgroup).cmp(&(b.service, b.instance, b.eventgroup))
    });
    SdReport {
        instances,
        eventgroups,
    }
}

fn finish_ptp(acc: PtpAcc) -> PtpReport {
    let mut senders = acc
        .senders
        .into_iter()
        .map(|(sender, entry)| PtpSenderReport {
            sender,
            sync: entry.sync,
            follow_up: entry.follow_up,
            pdelay_req: entry.pdelay_req,
            pdelay_resp: entry.pdelay_resp,
            announce: entry.announce,
            sync_period: entry.sync_period.stats.finish(),
            grandmaster: entry.grandmaster,
        })
        .collect::<Vec<_>>();
    senders.sort_by(|a, b| b.sync.cmp(&a.sync).then_with(|| a.sender.cmp(&b.sender)));
    PtpReport { senders }
}

fn catalog_names(
    catalog: Option<&Catalog>,
    service_id: u16,
    method_id: u16,
) -> (Option<String>, Option<String>) {
    let Some(service) = catalog.and_then(|catalog| {
        catalog
            .services
            .iter()
            .find(|service| service.service_id == service_id)
    }) else {
        return (None, None);
    };
    let method = service
        .methods
        .iter()
        .find(|method| method.method_id == method_id)
        .map(|method| method.name.clone())
        .or_else(|| {
            service
                .events
                .iter()
                .find(|event| event.event_id == method_id)
                .map(|event| event.name.clone())
        });
    (Some(service.name.clone()), method)
}

fn source_endpoint(frame: &GenFrame) -> String {
    if frame.src_ip != 0 {
        ipv4_string(frame.src_ip)
    } else {
        mac_string(frame.src_mac)
    }
}

fn destination_endpoint(frame: &GenFrame, wire: &[u8]) -> Option<String> {
    if frame.dst_ip != 0 {
        return Some(ipv4_string(frame.dst_ip));
    }
    EthernetFrame::parse(wire)
        .ok()
        .map(|eth| mac_string(mac_u64(eth.dst)))
}

fn transport_label(frame: &GenFrame) -> &'static str {
    match frame.proto {
        PROTO_SOMEIP | PROTO_SD | PROTO_UDP | PROTO_DHCP | PROTO_DNS | PROTO_NTP | PROTO_SSDP
        | PROTO_TFTP | PROTO_SNMP => "udp",
        PROTO_TCP | PROTO_HTTP | PROTO_TLS | PROTO_SSH | PROTO_DOIP => "tcp",
        PROTO_GPTP | PROTO_PTP => "ptp",
        _ => protocol_label(frame.proto),
    }
}

fn ordered_pair(a: String, b: String) -> (String, String) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

fn someip_payload<'a>(
    frame: &GenFrame,
    wire: &'a [u8],
) -> Option<(someip::SomeIpHeader, &'a [u8])> {
    let payload = wire.get(frame.payload_off as usize..)?;
    someip::parse(payload).ok()
}

fn grandmaster_identity(frame: &GenFrame, wire: &[u8]) -> Option<String> {
    let payload = wire.get(frame.payload_off as usize..)?;
    let _ = gptp::parse(payload).ok()?;
    let gm = payload.get(gptp::HEADER_LEN + 19..gptp::HEADER_LEN + 27)?;
    Some(
        gm.iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

fn ipv4_string(value: u32) -> String {
    let b = value.to_be_bytes();
    format!("{}.{}.{}.{}", b[0], b[1], b[2], b[3])
}

fn mac_string(value: u64) -> String {
    (0..6)
        .rev()
        .map(|n| format!("{:02x}", (value >> (n * 8)) & 0xff))
        .collect::<Vec<_>>()
        .join(":")
}

fn mac_u64(mac: [u8; 6]) -> u64 {
    mac.into_iter().fold(0, |v, b| (v << 8) | u64::from(b))
}

fn generated_at_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[tauri::command]
pub async fn trace_analyze(
    from: AnalysisFrom,
    sections: Option<Sections>,
    catalog: State<'_, crate::catalog::CatalogState>,
    app: AppHandle,
) -> Result<AnalysisReport, String> {
    let catalog = catalog.with_active(|active| active.cloned());
    let sections = sections.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let capture = app.state::<CaptureState>();
        analyze(&capture, &from, &sections, catalog.as_ref())
    })
    .await
    .map_err(|error| format!("analysis task failed: {error}"))?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceSummaryParams {
    #[serde(default)]
    pub from: Option<AnalysisFrom>,
    pub service: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimingReportParams {
    #[serde(default)]
    pub from: Option<AnalysisFrom>,
    pub service: u16,
    pub method: u16,
}

pub fn service_summary(
    capture: &CaptureState,
    params: ServiceSummaryParams,
    catalog: Option<&Catalog>,
) -> Result<SomeipReport, String> {
    let report = analyze(
        capture,
        &params.from.unwrap_or(AnalysisFrom::Ring),
        &Sections {
            someip: true,
            ..Sections::default()
        },
        catalog,
    )?;
    let mut someip = report.someip.unwrap_or(SomeipReport { services: vec![] });
    if let Some(service) = params.service {
        someip.services.retain(|entry| entry.service == service);
    }
    Ok(someip)
}

pub fn timing_report(
    capture: &CaptureState,
    params: TimingReportParams,
    catalog: Option<&Catalog>,
) -> Result<Option<SomeipServiceReport>, String> {
    let report = analyze_inner(
        capture,
        &params.from.unwrap_or(AnalysisFrom::Ring),
        &Sections {
            someip: true,
            ..Sections::default()
        },
        catalog,
        None,
    )?;
    Ok(report.someip.and_then(|someip| {
        someip
            .services
            .into_iter()
            .find(|entry| entry.service == params.service && entry.method == params.method)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use radeau_proto::{ethernet, ipv4::Ipv4Packet, udp::UdpDatagram};

    fn wire_someip(src: [u8; 4], dst: [u8; 4], h: someip::SomeIpHeader, payload: &[u8]) -> Vec<u8> {
        let mut message = Vec::new();
        someip::build(&h, payload, &mut message);
        let mut udp = Vec::new();
        UdpDatagram::build(src, dst, 30_490, 30_490, &message, &mut udp);
        let mut ip = Vec::new();
        Ipv4Packet::build(src, dst, 17, 1, 64, 0, &udp, &mut ip);
        let mut wire = Vec::new();
        EthernetFrame::build(
            [2, 2, 2, 2, 2, src[3]],
            [1; 6],
            ethernet::ETHERTYPE_IPV4,
            &ip,
            &mut wire,
        );
        wire
    }

    fn classified(wire: &[u8], idx: u64, t_ns: u64) -> GenFrame {
        let mut endpoints = EndpointTable::default();
        classify_frame(
            wire,
            idx,
            t_ns as f64 / 1_000_000_000.0,
            DIR_RX,
            &mut endpoints,
        )
    }

    fn analyze_wires(wires: Vec<(u64, Vec<u8>)>) -> AnalysisReport {
        let mut analyzer = Analyzer::new(Sections::default().resolved(), Some(MAX_REPORT_GAPS));
        for (idx, (t_ns, wire)) in wires.into_iter().enumerate() {
            let frame = classified(&wire, idx as u64, t_ns);
            analyzer.process(&frame, &wire);
        }
        analyzer.finish(
            AnalysisSource {
                kind: "ring".into(),
                path: None,
            },
            None,
        )
    }

    #[test]
    fn an_002_overview_exact_tables() {
        let h = someip::SomeIpHeader {
            service_id: 0x1101,
            method_id: 0x8001,
            length: 0,
            client_id: 1,
            session_id: 1,
            protocol_version: 1,
            interface_version: 1,
            message_type: someip::MSG_NOTIFICATION,
            return_code: 0,
        };
        let report = analyze_wires(vec![
            (0, wire_someip([10, 42, 0, 11], [10, 42, 0, 20], h, &[1])),
            (
                1_000,
                wire_someip([10, 42, 0, 20], [10, 42, 0, 11], h, &[2]),
            ),
        ]);
        let overview = report.overview.expect("AN-002 overview");
        assert_eq!(overview.frames, 2);
        assert_eq!(overview.protocols.iter().map(|p| p.frames).sum::<u64>(), 2);
        assert!(overview
            .endpoints
            .iter()
            .any(|e| e.endpoint == "10.42.0.11" && e.frames_sent == 1));
        assert_eq!(overview.conversations[0].frames, 2);
    }

    #[test]
    fn an_003_someip_period_gap_and_latency() {
        let notif = |session| someip::SomeIpHeader {
            service_id: 0x1101,
            method_id: 0x8001,
            length: 0,
            client_id: 1,
            session_id: session,
            protocol_version: 1,
            interface_version: 1,
            message_type: someip::MSG_NOTIFICATION,
            return_code: 0,
        };
        let req = someip::SomeIpHeader {
            message_type: someip::MSG_REQUEST,
            ..notif(9)
        };
        let resp = someip::SomeIpHeader {
            message_type: someip::MSG_RESPONSE,
            ..notif(9)
        };
        let report = analyze_wires(vec![
            (
                0,
                wire_someip([10, 42, 0, 11], [10, 42, 0, 20], notif(1), &[]),
            ),
            (
                10_000_000,
                wire_someip([10, 42, 0, 11], [10, 42, 0, 20], notif(2), &[]),
            ),
            (
                20_000_000,
                wire_someip([10, 42, 0, 11], [10, 42, 0, 20], notif(3), &[]),
            ),
            (
                70_000_000,
                wire_someip([10, 42, 0, 11], [10, 42, 0, 20], notif(4), &[]),
            ),
            (
                100_000_000,
                wire_someip([10, 42, 0, 20], [10, 42, 0, 11], req, &[]),
            ),
            (
                105_000_000,
                wire_someip([10, 42, 0, 11], [10, 42, 0, 20], resp, &[]),
            ),
        ]);
        let service = &report.someip.expect("AN-003 someip").services[0];
        assert_eq!(service.counts.notification, 4);
        assert_eq!(
            service.senders[0].period.as_ref().unwrap().max_ns,
            50_000_000
        );
        assert_eq!(service.senders[0].gaps[0].gap_ns, 50_000_000);
        assert_eq!(service.latency.as_ref().unwrap().mean_ns, 5_000_000.0);
    }

    #[test]
    fn an_004_sd_offer_reboot_and_eventgroup() {
        let sd_wire = |t, session, flags, ttl, entry_type| {
            let mut body = Vec::new();
            sd::build(
                &sd::SdMessage {
                    flags,
                    entries: vec![sd::SdEntry {
                        entry_type,
                        service_id: 0x1101,
                        instance_id: 1,
                        major_version: 1,
                        ttl,
                        minor_version: 7,
                    }],
                },
                &mut body,
            );
            let h = someip::SomeIpHeader {
                service_id: someip::SD_SERVICE_ID,
                method_id: someip::SD_METHOD_ID,
                length: 0,
                client_id: 1,
                session_id: session,
                protocol_version: 1,
                interface_version: 1,
                message_type: someip::MSG_NOTIFICATION,
                return_code: 0,
            };
            (
                t,
                wire_someip([10, 42, 0, 11], [224, 244, 224, 245], h, &body),
            )
        };
        let report = analyze_wires(vec![
            sd_wire(0, 10, 0, 3, sd::ENTRY_OFFER_SERVICE),
            sd_wire(1_000_000_000, 11, 0x80, 3, sd::ENTRY_OFFER_SERVICE),
            sd_wire(2_000_000_000, 12, 0, 0, sd::ENTRY_OFFER_SERVICE),
            sd_wire(3_000_000_000, 13, 0, 3, sd::ENTRY_SUBSCRIBE_EVENTGROUP_ACK),
        ]);
        let sd_report = report.sd.expect("AN-004 sd");
        assert_eq!(sd_report.instances[0].offers, 2);
        assert_eq!(sd_report.instances[0].stop_offers, 1);
        assert_eq!(sd_report.instances[0].reboots, 1);
        assert_eq!(sd_report.eventgroups[0].acks, 1);
    }

    #[test]
    fn an_005_gptp_sync_period_and_announce() {
        let mut wires = Vec::new();
        for (i, t) in [0, 125_000_000, 250_000_000].into_iter().enumerate() {
            let mut payload = Vec::new();
            gptp::build(
                &gptp::GptpMessage {
                    msg_type: gptp::MSG_SYNC,
                    domain: 0,
                    sequence_id: i as u16,
                    correction_ns: 0,
                    origin_timestamp_ns: Some(t as u128),
                },
                &mut payload,
            );
            let mut wire = Vec::new();
            EthernetFrame::build(
                gptp::GPTP_MULTICAST,
                [2, 3, 4, 5, 6, 7],
                gptp::ETHERTYPE_GPTP,
                &payload,
                &mut wire,
            );
            wires.push((t, wire));
        }
        let report = analyze_wires(wires);
        let ptp = report.ptp.expect("AN-005 ptp");
        assert_eq!(ptp.senders[0].sync, 3);
        assert_eq!(
            ptp.senders[0].sync_period.as_ref().unwrap().mean_ns,
            125_000_000.0
        );
    }

    #[test]
    fn an_006_burst_top_window() {
        let h = someip::SomeIpHeader {
            service_id: 0x1101,
            method_id: 0x8001,
            length: 0,
            client_id: 1,
            session_id: 1,
            protocol_version: 1,
            interface_version: 1,
            message_type: someip::MSG_NOTIFICATION,
            return_code: 0,
        };
        let wires = (0..6)
            .map(|i| {
                (
                    i * 1_000_000,
                    wire_someip([10, 42, 0, 11], [10, 42, 0, 20], h, &[]),
                )
            })
            .collect();
        let report = analyze_wires(wires);
        let bursts = report.bursts.expect("AN-006 bursts");
        assert_eq!(bursts.max_frames, 6);
        assert_eq!(bursts.top[0].frames, 6);
    }

    #[test]
    fn an_009_fixture_period_accuracy() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/pcap/sensor-fusion-5s.pcap"
        );
        let capture = CaptureState::default();
        let report = analyze(
            &capture,
            &AnalysisFrom::File { path: path.into() },
            &Sections::default(),
            None,
        )
        .expect("AN-009 fixture analysis");
        let someip = report.someip.expect("someip");
        for (service, expected_ms) in [
            (0x1101, 33.0),
            (0x1102, 50.0),
            (0x1103, 100.0),
            (0x1104, 10.0),
            (0x1201, 50.0),
        ] {
            let entry = someip
                .services
                .iter()
                .find(|entry| entry.service == service && entry.method == 0x8001)
                .unwrap_or_else(|| panic!("missing service 0x{service:04X}"));
            let mean_ms = entry.senders[0].period.as_ref().expect("period").mean_ns / 1_000_000.0;
            assert!(
                (mean_ms - expected_ms).abs() / expected_ms <= 0.01,
                "0x{service:04X}: {mean_ms}"
            );
        }
        let sd = report.sd.expect("sd");
        for instance in sd.instances {
            let Some(period) = instance.period else {
                continue;
            };
            let mean_ms = period.mean_ns / 1_000_000.0;
            assert!(
                (mean_ms - 1000.0).abs() / 1000.0 <= 0.01,
                "sd 0x{:04X}: {mean_ms}",
                instance.service
            );
        }
        let ptp = report.ptp.expect("ptp");
        let sync = ptp
            .senders
            .iter()
            .find_map(|sender| sender.sync_period.as_ref())
            .expect("sync");
        let mean_ms = sync.mean_ns / 1_000_000.0;
        assert!((mean_ms - 125.0).abs() / 125.0 <= 0.01, "sync: {mean_ms}");
    }

    // AN-001 / AN-003: memory stays bounded over a long trace, gaps late in the
    // trace are still found, and quantiles cover the whole trace.
    #[test]
    fn an_001_period_tracker_is_bounded_and_unbiased() {
        let mut tracker = PeriodTracker::default();
        let mut t = 0u64;
        for i in 0..200_000u64 {
            // 10 ms cadence; the second half runs at 20 ms; gaps near the end.
            t += if i < 100_000 { 10_000_000 } else { 20_000_000 };
            if i == 199_000 || i == 199_500 {
                t += 200_000_000;
            }
            tracker.observe(t);
        }
        assert!(tracker.candidates.len() <= MAX_GAP_CANDIDATES);
        assert!(tracker.stats.samples.len() <= MAX_SAMPLES);
        let (stats, gaps, total) = tracker.finish(None);
        let stats = stats.unwrap();
        // Half the intervals are 20 ms: the p99 must see the second half.
        assert_eq!(stats.p99_ns, 20_000_000);
        assert!(gaps.iter().any(|g| g.gap_ns == 220_000_000));
        assert_eq!(total, 2);
    }
}
