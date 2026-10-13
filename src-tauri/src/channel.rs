//! Static-dispatch capture channels (CP-001). Network and file parsing live here;
//! classification, retention, batching, and statistics stay in `capture`.

#[cfg(debug_assertions)]
use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Read};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

#[cfg(debug_assertions)]
use crate::devgen::{DevGen, RateProfile};
use crate::simlink::{read_handshake_line, validate_handshake_line, MonitorRecord, RecordDeframer};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_millis(100);
const BACKOFF_START: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(tag = "kind")]
pub enum SourceSpec {
    // CP-001: stable tagged-union selection ids for every backend.
    #[serde(rename = "devgen")]
    Devgen { profile: String },
    #[serde(rename = "sim")]
    Sim { addr: String },
    #[serde(rename = "pcap")]
    Pcap { path: String, pace: String },
    #[serde(rename = "pcapStream")]
    PcapStream { addr: String },
    #[serde(rename = "live")]
    Live {
        #[serde(rename = "interfaceId")]
        interface_id: String,
        filter: Option<String>,
    },
    #[serde(rename = "stub")]
    Stub,
}

#[derive(Debug)]
pub enum ChannelRead {
    Frame { ts_ns: u64, dir: u8, wire: Vec<u8> },
    Gap { dropped: u32, span_ns: u64 },
    ReplaySeek { seek: crate::replay::ReplaySeek },
    Idle,
    Ended { detail: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelStatus {
    Connecting,
    Up,
    Reconnecting,
    Down(String),
    Ended,
}

#[derive(Debug, Clone, Copy)]
pub struct Capabilities {
    pub direction: bool,
    pub timestamp_source: &'static str,
    pub transmit: bool,
}

// Source states own their bounded buffers so capture setup remains allocation-free.
#[allow(clippy::large_enum_variant)]
pub enum Source {
    // CP-001: variants keep read-path dispatch static, without trait objects.
    #[cfg(debug_assertions)]
    Devgen(DevgenSource),
    Sim(SimSource),
    Pcap(PcapSource),
    PcapStream(PcapStreamSource),
    Live(LiveSource),
}

impl Source {
    #[allow(dead_code)]
    pub fn open(spec: &SourceSpec) -> Result<Self, String> {
        Self::open_with_replay(spec, None)
    }

    pub fn open_with_replay(
        spec: &SourceSpec,
        replay: Option<(
            Arc<crate::replay::ReplayIndex>,
            Arc<crate::replay::ReplayControl>,
        )>,
    ) -> Result<Self, String> {
        match spec {
            SourceSpec::Devgen { profile } => {
                #[cfg(debug_assertions)]
                {
                    let profile = RateProfile::parse(profile)
                        .ok_or_else(|| format!("unknown profile '{profile}'"))?;
                    Ok(Self::Devgen(DevgenSource::new(profile)))
                }
                #[cfg(not(debug_assertions))]
                {
                    let _ = profile;
                    Err("dev generator is not available in release builds".into())
                }
            }
            SourceSpec::Sim { addr } if addr.trim().is_empty() => {
                Err("sim addr must not be empty".into())
            }
            SourceSpec::Sim { addr } => Ok(Self::Sim(SimSource::new(addr.clone()))),
            SourceSpec::Pcap { path, pace } => {
                Ok(Self::Pcap(PcapSource::open(path, pace, replay)?))
            }
            SourceSpec::PcapStream { addr } if addr.trim().is_empty() => {
                Err("pcap stream addr must not be empty".into())
            }
            SourceSpec::PcapStream { addr } => {
                Ok(Self::PcapStream(PcapStreamSource::connect(addr)?))
            }
            SourceSpec::Live { interface_id, .. } if interface_id.trim().is_empty() => {
                Err("live interfaceId must not be empty".into())
            }
            SourceSpec::Live {
                interface_id,
                filter,
            } => Ok(Self::Live(LiveSource::open(
                interface_id,
                filter.as_deref(),
            )?)),
            SourceSpec::Stub => Err("no link available".into()),
        }
    }

    pub fn read(&mut self, timeout: Duration) -> ChannelRead {
        match self {
            #[cfg(debug_assertions)]
            Self::Devgen(source) => source.read(timeout),
            Self::Sim(source) => source.read(timeout),
            Self::Pcap(source) => source.read(timeout),
            Self::PcapStream(source) => source.read(timeout),
            Self::Live(source) => source.read(timeout),
        }
    }

    pub fn status(&self) -> ChannelStatus {
        match self {
            #[cfg(debug_assertions)]
            Self::Devgen(_) => ChannelStatus::Up,
            Self::Sim(source) => source.status.clone(),
            Self::Pcap(source) => source.status.clone(),
            Self::PcapStream(source) => source.status.clone(),
            Self::Live(source) => source.status.clone(),
        }
    }

    pub fn capabilities(&self) -> Capabilities {
        match self {
            #[cfg(debug_assertions)]
            Self::Devgen(_) => Capabilities {
                direction: true,
                timestamp_source: "host",
                transmit: false,
            },
            Self::Sim(_) => Capabilities {
                direction: true,
                timestamp_source: "switch",
                transmit: false,
            },
            Self::Pcap(_) | Self::PcapStream(_) => Capabilities {
                // CP-009: pcap and pcapStream carry file timestamps and, for pcapng, direction.
                direction: true,
                timestamp_source: "file",
                transmit: false,
            },
            Self::Live(_) => Capabilities {
                direction: false,
                timestamp_source: "host",
                transmit: false,
            },
        }
    }

    pub fn source_kind(&self) -> &'static str {
        match self {
            #[cfg(debug_assertions)]
            Self::Devgen(_) => "devgen",
            Self::Sim(_) => "sim",
            Self::Pcap(_) => "pcap",
            Self::PcapStream(_) => "pcapStream",
            Self::Live(_) => "live",
        }
    }

    pub fn scenario(&self) -> Option<String> {
        match self {
            Self::Sim(source) => source.scenario.clone(),
            _ => None,
        }
    }

    pub fn endpoint_hints(&self) -> Vec<(u32, String)> {
        match self {
            Self::Sim(source) => source.hints.clone(),
            #[cfg(debug_assertions)]
            Self::Devgen(_) => (0..5)
                .map(|n| {
                    let ip = crate::devgen::endpoint_ip(n);
                    (
                        u32::from_be_bytes(ip),
                        format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3]),
                    )
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    pub fn session_epoch_ns(&self) -> Option<u64> {
        match self {
            #[cfg(debug_assertions)]
            Self::Devgen(source) => Some(source.epoch_ns),
            Self::Sim(source) => Some(source.epoch_ns),
            Self::Pcap(source) => source.first_ts,
            Self::PcapStream(source) => source.first_ts,
            Self::Live(source) => Some(source.epoch_ns),
        }
    }

    pub fn metadata_ready(&self) -> bool {
        match self {
            Self::Sim(source) => source.scenario.is_some(),
            Self::Pcap(source) => source.first_ts.is_some() || source.finished,
            Self::PcapStream(source) => source.first_ts.is_some() || source.ended,
            _ => true,
        }
    }

    pub fn fast_replay(&self) -> bool {
        matches!(self, Self::Pcap(PcapSource { fast: true, .. }))
    }

    pub fn replay_control(&self) -> Option<Arc<crate::replay::ReplayControl>> {
        match self {
            Self::Pcap(source) => Some(Arc::clone(&source.control)),
            _ => None,
        }
    }

    pub fn kernel_drops(&mut self) -> Option<u64> {
        match self {
            Self::Live(source) => source.kernel_drops(),
            _ => None,
        }
    }
}

fn now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(u64::MAX as u128) as u64
}

fn resolve(addr: &str) -> Result<SocketAddr, String> {
    addr.to_socket_addrs()
        .map_err(|e| format!("resolve {addr}: {e}"))?
        .next()
        .ok_or_else(|| format!("no addresses for {addr}"))
}
fn connect(addr: &str) -> Result<TcpStream, String> {
    TcpStream::connect_timeout(&resolve(addr)?, CONNECT_TIMEOUT)
        .map_err(|e| format!("connect {addr}: {e}"))
}
fn configure(stream: &TcpStream) -> Result<(), String> {
    stream
        .set_read_timeout(Some(READ_TIMEOUT))
        .map_err(|e| format!("set_read_timeout: {e}"))?;
    stream
        .set_nodelay(true)
        .map_err(|e| format!("set_nodelay: {e}"))
}

#[cfg(debug_assertions)]
pub struct DevgenSource {
    generator: DevGen,
    profile: RateProfile,
    started: Instant,
    last: Instant,
    carry: f64,
    pending: VecDeque<(crate::frame::GenFrame, Vec<u8>)>,
    epoch_ns: u64,
}
#[cfg(debug_assertions)]
impl DevgenSource {
    fn new(profile: RateProfile) -> Self {
        let now = Instant::now();
        Self {
            generator: DevGen::new(0x5eed_2026_0001),
            profile,
            started: now,
            last: now,
            carry: 0.0,
            pending: VecDeque::new(),
            epoch_ns: now_ns(),
        }
    }
    fn read(&mut self, timeout: Duration) -> ChannelRead {
        if let Some((frame, wire)) = self.pending.pop_front() {
            return ChannelRead::Frame {
                ts_ns: self.epoch_ns.saturating_add((frame.t_s * 1e9) as u64),
                dir: frame.dir,
                wire,
            };
        }
        std::thread::sleep(timeout.min(Duration::from_millis(2)));
        let now = Instant::now();
        let rate = self.profile.rate_at(self.started.elapsed().as_secs_f64());
        self.carry += rate * now.duration_since(self.last).as_secs_f64();
        self.last = now;
        let count = self.carry.floor() as usize;
        self.carry -= count as f64;
        if count == 0 {
            return ChannelRead::Idle;
        }
        let mut generated = Vec::with_capacity(count);
        self.generator
            .gen_frames_with_wire(count, rate, &mut generated);
        self.pending.extend(generated);
        self.read(Duration::ZERO)
    }
}

pub struct SimSource {
    addr: String,
    stream: Option<TcpStream>,
    deframer: RecordDeframer,
    scratch: [u8; 8192],
    first_switch: Option<u64>,
    epoch_ns: u64,
    scenario: Option<String>,
    hints: Vec<(u32, String)>,
    backoff: Duration,
    next_connect: Instant,
    status: ChannelStatus,
}
impl SimSource {
    fn new(addr: String) -> Self {
        Self {
            addr,
            stream: None,
            deframer: RecordDeframer::new(),
            scratch: [0; 8192],
            first_switch: None,
            epoch_ns: now_ns(),
            scenario: None,
            hints: Vec::new(),
            backoff: BACKOFF_START,
            next_connect: Instant::now(),
            status: ChannelStatus::Connecting,
        }
    }
    fn establish(&mut self) -> Result<(), String> {
        self.status = ChannelStatus::Connecting;
        let mut stream = connect(&self.addr)?;
        configure(&stream)?;
        let mut leftover = Vec::new();
        let line = read_handshake_line(&mut stream, &mut leftover, &mut self.scratch)
            .map_err(|e| format!("handshake read: {e}"))?;
        let handshake = validate_handshake_line(&line)?;
        self.scenario = Some(handshake.scenario);
        let mut ports = handshake.ports;
        ports.sort_by_key(|port| port.id);
        self.hints = ports
            .into_iter()
            .filter_map(|port| {
                port.ip
                    .parse::<std::net::Ipv4Addr>()
                    .ok()
                    .map(|ip| (u32::from(ip), port.name))
            })
            .collect();
        self.deframer = RecordDeframer::new();
        self.deframer.push(&leftover);
        self.stream = Some(stream);
        self.backoff = BACKOFF_START;
        self.status = ChannelStatus::Up;
        Ok(())
    }
    fn fail(&mut self, detail: String) {
        self.stream = None;
        self.status = ChannelStatus::Down(detail);
        self.next_connect = Instant::now() + self.backoff;
        self.backoff = (self.backoff * 2).min(BACKOFF_MAX);
    }
    fn read(&mut self, _timeout: Duration) -> ChannelRead {
        loop {
            match self.deframer.next_record() {
                Ok(Some(MonitorRecord::Gap {
                    dropped_count,
                    span_ns,
                    ..
                })) => {
                    return ChannelRead::Gap {
                        dropped: dropped_count,
                        span_ns,
                    }
                }
                Ok(Some(MonitorRecord::Frame {
                    switch_time_ns,
                    direction,
                    frame,
                    ..
                })) => {
                    let first = *self.first_switch.get_or_insert(switch_time_ns);
                    return ChannelRead::Frame {
                        ts_ns: self
                            .epoch_ns
                            .saturating_add(switch_time_ns.saturating_sub(first)),
                        dir: crate::classify::sim_direction(direction),
                        wire: frame,
                    };
                }
                Ok(None) => {}
                Err(error) => {
                    self.fail(error);
                    return ChannelRead::Idle;
                }
            }
            if self.stream.is_none() {
                if Instant::now() < self.next_connect {
                    self.status = ChannelStatus::Reconnecting;
                    return ChannelRead::Idle;
                }
                if let Err(error) = self.establish() {
                    self.fail(error);
                    return ChannelRead::Idle;
                }
            }
            match self
                .stream
                .as_mut()
                .expect("established stream")
                .read(&mut self.scratch)
            {
                Ok(0) => {
                    self.fail("peer closed".into());
                    return ChannelRead::Idle;
                }
                Ok(count) => self.deframer.push(&self.scratch[..count]),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return ChannelRead::Idle
                }
                Err(error) => {
                    self.fail(format!("read: {error}"));
                    return ChannelRead::Idle;
                }
            }
        }
    }
}

pub struct PcapSource {
    path: String,
    file: File,
    reader: radeau_pcap::PcapReader,
    pending: Option<radeau_pcap::Record>,
    index: Arc<crate::replay::ReplayIndex>,
    control: Arc<crate::replay::ReplayControl>,
    first_ts: Option<u64>,
    previous_ts: Option<u64>,
    fast: bool,
    frames: u64,
    collapsed_gaps: u64,
    cut: bool,
    finished: bool,
    status: ChannelStatus,
}
impl PcapSource {
    fn open(
        path: &str,
        pace: &str,
        replay: Option<(
            Arc<crate::replay::ReplayIndex>,
            Arc<crate::replay::ReplayControl>,
        )>,
    ) -> Result<Self, String> {
        // CP-002 and CP-004: file replay uses the shared pcap parser and selected pacing mode.
        if !matches!(pace, "realtime" | "fast") {
            return Err(format!("unknown pcap pace '{pace}'"));
        }
        let (index, control) = match replay {
            Some(replay) => replay,
            None => {
                let (_, index) = crate::replay::prepare(path, None)?;
                let index = Arc::new(index);
                let speed = match pace {
                    "realtime" => Some(1.0),
                    "fast" => None,
                    _ => unreachable!(),
                };
                let control = crate::replay::ReplayControl::new(index.info.clone(), speed);
                (index, control)
            }
        };
        let file = File::open(Path::new(path)).map_err(|e| format!("open {path}: {e}"))?;
        let mut source = Self {
            path: path.to_string(),
            file,
            reader: radeau_pcap::PcapReader::new(),
            pending: None,
            index,
            control,
            first_ts: None,
            previous_ts: None,
            fast: pace == "fast",
            frames: 0,
            collapsed_gaps: 0,
            cut: false,
            finished: false,
            status: ChannelStatus::Up,
        };
        source.fill()?;
        Ok(source)
    }
    fn fill(&mut self) -> Result<(), String> {
        let mut bytes = [0; 64 * 1024];
        loop {
            match self.reader.next_record() {
                Ok(Some(record)) => {
                    self.first_ts.get_or_insert(record.ts_ns);
                    self.pending = Some(record);
                    return Ok(());
                }
                Ok(None) => match self.file.read(&mut bytes) {
                    Ok(0) => self.reader.finish(),
                    Ok(count) => self.reader.push(&bytes[..count]),
                    Err(error) => return Err(format!("read pcap: {error}")),
                },
                Err(radeau_pcap::PcapError::Ended { cut }) => {
                    self.cut |= cut;
                    self.finished = true;
                    self.status = ChannelStatus::Ended;
                    return Ok(());
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    fn end_detail(&self) -> String {
        let mut detail = format!("end of file · {} frames", self.frames);
        if self.collapsed_gaps > 0 {
            detail.push_str(&format!(" · {} gaps collapsed", self.collapsed_gaps));
        }
        if self.cut {
            detail.push_str(" · truncated tail");
        }
        detail
    }
    fn read(&mut self, _timeout: Duration) -> ChannelRead {
        if let Some(target) = self.control.take_seek() {
            let (frame, landed_ts) = match self.seek_to(target) {
                Ok(landed) => landed,
                Err(detail) => {
                    self.status = ChannelStatus::Ended;
                    return ChannelRead::Ended { detail };
                }
            };
            self.control.observe_frame(landed_ts, frame);
            return ChannelRead::ReplaySeek {
                seek: crate::replay::ReplaySeek {
                    t_ns: landed_ts.saturating_sub(self.index.info.first_ts_ns),
                    frame,
                },
            };
        }
        if self.control.is_paused_without_step() {
            return ChannelRead::Idle;
        }
        let stepping = self.control.take_step();
        if self.pending.is_none() && !self.finished {
            if let Err(detail) = self.fill() {
                self.status = ChannelStatus::Ended;
                return ChannelRead::Ended { detail };
            }
        }
        let Some(record) = self.pending.take() else {
            self.control.mark_ended();
            return ChannelRead::Ended {
                detail: self.end_detail(),
            };
        };
        if let Some(sleep) = self
            .control
            .sleep_until_due(record.ts_ns.saturating_sub(self.index.info.first_ts_ns))
        {
            std::thread::sleep(sleep);
            // CP-021: a pause (or seek) that arrived during the sleep wins —
            // the frame stays pending instead of being emitted after pause.
            if sleep == crate::replay::SLEEP_CAP
                || (!stepping && self.control.is_paused_without_step())
                || self.control.has_pending_seek()
            {
                self.pending = Some(record);
                return ChannelRead::Idle;
            }
        } else if !self.fast && self.control.speed().is_some() {
            if let Some(previous) = self.previous_ts {
                let raw_gap = record.ts_ns.saturating_sub(previous);
                if raw_gap > 5_000_000_000 {
                    self.collapsed_gaps += 1;
                }
            }
        }
        self.previous_ts = Some(record.ts_ns);
        self.frames += 1;
        self.control.observe_frame(record.ts_ns, self.frames - 1);
        if stepping {
            self.control.finish_step();
        }
        ChannelRead::Frame {
            ts_ns: record.ts_ns,
            dir: record.dir,
            wire: record.wire,
        }
    }

    /// CP-022: repositions through the seek index; returns the landing frame
    /// number and its absolute timestamp (the file end when past the last frame).
    fn seek_to(&mut self, target_t_ns: u64) -> Result<(u64, u64), String> {
        let seek = crate::replay::open_at(&self.path, &self.index, target_t_ns)?;
        let landed_ts = seek
            .pending
            .as_ref()
            .map_or(self.index.info.last_ts_ns, |record| record.ts_ns);
        self.file = seek.file;
        self.reader = seek.reader;
        self.pending = seek.pending;
        self.frames = seek.frame;
        self.previous_ts = seek.previous_ts;
        self.finished = self.pending.is_none();
        self.status = if self.finished {
            ChannelStatus::Ended
        } else {
            ChannelStatus::Up
        };
        Ok((seek.frame, landed_ts))
    }
}

pub struct PcapStreamSource {
    stream: TcpStream,
    reader: radeau_pcap::PcapReader,
    scratch: [u8; 64 * 1024],
    first_ts: Option<u64>,
    frames: u64,
    input_finished: bool,
    ended: bool,
    status: ChannelStatus,
}
impl PcapStreamSource {
    fn connect(addr: &str) -> Result<Self, String> {
        // CP-003: TCP pcap/pcapng streams feed the same incremental parser.
        let stream = connect(addr)?;
        configure(&stream)?;
        Ok(Self {
            stream,
            reader: radeau_pcap::PcapReader::new(),
            scratch: [0; 64 * 1024],
            first_ts: None,
            frames: 0,
            input_finished: false,
            ended: false,
            status: ChannelStatus::Up,
        })
    }
    fn read(&mut self, _timeout: Duration) -> ChannelRead {
        loop {
            match self.reader.next_record() {
                Ok(Some(record)) => {
                    self.first_ts.get_or_insert(record.ts_ns);
                    self.frames += 1;
                    return ChannelRead::Frame {
                        ts_ns: record.ts_ns,
                        dir: record.dir,
                        wire: record.wire,
                    };
                }
                Ok(None) => {}
                Err(radeau_pcap::PcapError::Ended { cut }) => {
                    self.ended = true;
                    self.status = ChannelStatus::Ended;
                    return ChannelRead::Ended {
                        detail: format!(
                            "end of file · {} frames{}",
                            self.frames,
                            if cut { " · truncated tail" } else { "" }
                        ),
                    };
                }
                Err(error) => {
                    self.ended = true;
                    self.status = ChannelStatus::Ended;
                    return ChannelRead::Ended {
                        detail: error.to_string(),
                    };
                }
            }
            match self.stream.read(&mut self.scratch) {
                Ok(0) if !self.input_finished => {
                    self.reader.finish();
                    self.input_finished = true;
                }
                Ok(0) => {
                    self.ended = true;
                    self.status = ChannelStatus::Ended;
                    return ChannelRead::Ended {
                        detail: format!("end of file · {} frames", self.frames),
                    };
                }
                Ok(count) => self.reader.push(&self.scratch[..count]),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return ChannelRead::Idle
                }
                Err(error) => {
                    self.ended = true;
                    self.status = ChannelStatus::Ended;
                    return ChannelRead::Ended {
                        detail: format!("read: {error}"),
                    };
                }
            }
        }
    }
}

pub struct LiveSource {
    capture: radeau_livecap::LiveCapture,
    link_type: radeau_livecap::LinkType,
    epoch_ns: u64,
    status: ChannelStatus,
    failed: bool,
}

impl LiveSource {
    fn open(interface_id: &str, filter: Option<&str>) -> Result<Self, String> {
        // CP-010, CP-012 and CP-013: runtime-loaded live capture with configured pcap handle.
        let filter = filter.unwrap_or(radeau_livecap::DEFAULT_FILTER);
        let capture = radeau_livecap::LiveCapture::open(interface_id, Some(filter))
            .map_err(|error| error.to_string())?;
        let link_type = capture.link_type;
        if let radeau_livecap::LinkType::Other(value) = link_type {
            return Err(format!("unsupported data link {value} on this interface"));
        }
        crate::log::log(
            crate::log::Level::Info,
            "link",
            "live capture opened",
            serde_json::json!({
                "interfaceId": interface_id,
                "filter": filter,
                "linkType": capture.datalink(),
                "timestampPrecision": if capture.precision_ns { "ns" } else { "us" },
                "warnings": capture.warnings,
            }),
        );
        Ok(Self {
            capture,
            link_type,
            epoch_ns: now_ns(),
            status: ChannelStatus::Up,
            failed: false,
        })
    }

    fn fail(&mut self, error: String) {
        let remedy = radeau_livecap::capture_error_remedy(&error);
        crate::log::log(
            crate::log::Level::Error,
            "link",
            "live capture failed",
            serde_json::json!({ "error": error, "remedy": remedy }),
        );
        self.status = ChannelStatus::Down(remedy);
        self.failed = true;
    }

    fn read(&mut self, _timeout: Duration) -> ChannelRead {
        if self.failed {
            return ChannelRead::Idle;
        }
        match self.capture.next_packet() {
            Ok(Some(packet)) => {
                let wire = match self.link_type {
                    radeau_livecap::LinkType::Ethernet => packet.data,
                    radeau_livecap::LinkType::NullLoopback => {
                        radeau_livecap::null_loopback_to_ethernet(packet.data)
                    }
                    radeau_livecap::LinkType::Other(_) => unreachable!(
                        "unsupported live-capture data links are rejected while opening"
                    ),
                };
                ChannelRead::Frame {
                    ts_ns: packet.ts_ns,
                    dir: crate::codes::DIR_RX,
                    wire,
                }
            }
            Ok(None) => ChannelRead::Idle,
            Err(error) => {
                self.fail(error);
                ChannelRead::Idle
            }
        }
    }

    fn kernel_drops(&mut self) -> Option<u64> {
        if self.failed {
            return None;
        }
        match self.capture.stats() {
            Ok(stats) => Some(stats.drop),
            Err(error) => {
                self.fail(error);
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simlink::{encode_frame_record, encode_gap_record};
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    fn pcap_bytes(count: usize) -> Vec<u8> {
        let mut writer = radeau_pcap::PcapWriter::new(Vec::new()).unwrap();
        for index in 0..count {
            let mut wire = vec![0u8; 60];
            wire[0..6].copy_from_slice(&[0x02, 0x00, 0x00, 0x00, 0x00, index as u8]);
            wire[6..12].copy_from_slice(&[0x02, 0x00, 0x00, 0x00, 0x01, index as u8]);
            wire[12..14].copy_from_slice(&0x0800u16.to_be_bytes());
            writer
                .write_record(1_700_000_000_000_000_000 + index as u64 * 1_000_000, &wire)
                .unwrap();
        }
        writer.into_inner()
    }

    fn temp_pcap(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "radeau-{name}-{}-{}.pcap",
            std::process::id(),
            now_ns()
        ));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn ethernet(seed: u8) -> Vec<u8> {
        let mut wire = vec![0u8; 60];
        wire[0..6].copy_from_slice(&[0x02, 0x00, 0x00, 0x00, 0x00, seed]);
        wire[6..12].copy_from_slice(&[0x02, 0x00, 0x00, 0x00, 0x01, seed]);
        wire[12..14].copy_from_slice(&0x0800u16.to_be_bytes());
        wire
    }

    fn sim_handshake() -> &'static str {
        r#"{"link":"ecu-netsim-monitor","version":1,"scenario":"sensor-fusion","ports":[{"id":2,"name":"radar","ip":"10.42.0.12"},{"id":1,"name":"camera","ip":"10.42.0.11"},{"id":9,"name":"bad","ip":"not-an-ip"}]}"#
    }

    fn serve_once(payload: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(&payload).unwrap();
        });
        addr
    }

    fn read_until_non_idle(source: &mut Source) -> ChannelRead {
        for _ in 0..100 {
            let read = source.read(Duration::from_millis(1));
            if !matches!(read, ChannelRead::Idle) {
                return read;
            }
        }
        panic!("source stayed idle");
    }

    fn source_open_err(spec: SourceSpec) -> String {
        match Source::open(&spec) {
            Ok(_) => panic!("source unexpectedly opened"),
            Err(error) => error,
        }
    }

    #[test]
    fn source_open_rejects_invalid_specs() {
        assert_eq!(
            source_open_err(SourceSpec::Sim { addr: " ".into() }),
            "sim addr must not be empty"
        );
        assert_eq!(
            source_open_err(SourceSpec::PcapStream { addr: "".into() }),
            "pcap stream addr must not be empty"
        );
        assert_eq!(
            source_open_err(SourceSpec::Live {
                interface_id: "\t".into(),
                filter: None,
            }),
            "live interfaceId must not be empty"
        );
        assert_eq!(source_open_err(SourceSpec::Stub), "no link available");
        assert!(source_open_err(SourceSpec::Pcap {
            path: "missing.pcap".into(),
            pace: "warp".into(),
        })
        .contains("unknown pcap pace"));
    }

    #[test]
    fn devgen_profiles_open_read_and_report_metadata() {
        // PF-002/PF-003: every development profile opens through Source and reports host metadata.
        for profile in ["idle", "normal", "stress", "burst"] {
            let mut source = Source::open(&SourceSpec::Devgen {
                profile: profile.into(),
            })
            .unwrap();
            assert_eq!(source.source_kind(), "devgen");
            assert_eq!(source.status(), ChannelStatus::Up);
            let caps = source.capabilities();
            assert!(caps.direction);
            assert_eq!(caps.timestamp_source, "host");
            assert!(!caps.transmit);
            assert!(source.metadata_ready());
            assert!(source.session_epoch_ns().is_some());
            assert_eq!(source.endpoint_hints().len(), 5);
            let mut produced = false;
            for _ in 0..100 {
                match source.read(Duration::from_millis(1)) {
                    ChannelRead::Frame { wire, .. } => {
                        assert!(wire.len() >= 60);
                        produced = true;
                        break;
                    }
                    ChannelRead::Idle => continue,
                    other => panic!("unexpected devgen read: {other:?}"),
                }
            }
            assert!(produced, "{profile} should produce at least one frame");
        }
        assert!(source_open_err(SourceSpec::Devgen {
            profile: "unknown".into(),
        })
        .contains("unknown profile"));
    }

    #[test]
    fn cp_003_tcp_stream_uses_parser_until_eof() {
        // CP-003: a TCP pcap stream is parsed by the same incremental reader until EOF.
        let bytes = pcap_bytes(3);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            for chunk in bytes.chunks(11) {
                stream.write_all(chunk).unwrap();
            }
        });

        let mut source = PcapStreamSource::connect(&addr.to_string()).unwrap();
        let mut frames = Vec::new();
        loop {
            match source.read(Duration::from_millis(1)) {
                ChannelRead::Frame { ts_ns, dir, wire } => frames.push((ts_ns, dir, wire)),
                ChannelRead::Idle => continue,
                ChannelRead::Ended { detail } => {
                    assert_eq!(detail, "end of file · 3 frames");
                    break;
                }
                ChannelRead::ReplaySeek { .. } => panic!("unexpected replay seek event"),
                ChannelRead::Gap { .. } => panic!("pcap stream must not synthesize gaps"),
            }
        }
        server.join().unwrap();

        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0].0, 1_700_000_000_000_000_000);
        assert_eq!(frames[1].0, 1_700_000_000_001_000_000);
        assert_eq!(frames[2].0, 1_700_000_000_002_000_000);
        assert!(frames
            .iter()
            .all(|(_, dir, wire)| *dir == crate::codes::DIR_UNKNOWN && wire.len() == 60));
        assert_eq!(source.status, ChannelStatus::Ended);
    }

    #[test]
    fn cp_003_stream_source_connects_through_source_and_reports_failures() {
        assert!(source_open_err(SourceSpec::PcapStream {
            addr: "127.0.0.1:9".into(),
        })
        .contains("connect 127.0.0.1:9"));

        let bytes = pcap_bytes(1);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(&bytes).unwrap();
        });
        let mut source = Source::open(&SourceSpec::PcapStream {
            addr: addr.to_string(),
        })
        .unwrap();
        assert_eq!(source.source_kind(), "pcapStream");
        assert_eq!(source.status(), ChannelStatus::Up);
        assert!(source.capabilities().direction);
        assert!(!source.metadata_ready());
        assert!(matches!(
            read_until_non_idle(&mut source),
            ChannelRead::Frame { .. }
        ));
        assert!(source.metadata_ready());
        server.join().unwrap();
    }

    #[test]
    fn cp_004_fast_file_replay_reads_every_fixture_record() {
        // CP-004: fast file replay delivers every record without source-side drops.
        const RECORDS: usize = 4_096;
        let path = temp_pcap("cp004-fast", &pcap_bytes(RECORDS));
        let mut source = PcapSource::open(path.to_str().unwrap(), "fast", None).unwrap();
        let mut count = 0usize;
        loop {
            match source.read(Duration::ZERO) {
                ChannelRead::Frame { .. } => count += 1,
                ChannelRead::Ended { detail } => {
                    assert_eq!(detail, format!("end of file · {RECORDS} frames"));
                    break;
                }
                ChannelRead::Idle => continue,
                ChannelRead::ReplaySeek { .. } => panic!("unexpected replay seek event"),
                ChannelRead::Gap { .. } => panic!("pcap file replay must not synthesize gaps"),
            }
        }
        let _ = std::fs::remove_file(path);
        assert_eq!(count, RECORDS);
        assert_eq!(source.frames, RECORDS as u64);
        assert_eq!(source.status, ChannelStatus::Ended);
    }

    #[test]
    fn cp_004_realtime_file_replay_reads_and_reports_status() {
        // CP-004: paced file replay uses file timestamps and ends with a frame count.
        let path = temp_pcap("cp004-realtime", &pcap_bytes(2));
        let mut source = Source::open(&SourceSpec::Pcap {
            path: path.display().to_string(),
            pace: "realtime".into(),
        })
        .unwrap();
        assert_eq!(source.source_kind(), "pcap");
        assert!(!source.fast_replay());
        assert!(source.metadata_ready());
        assert!(source.session_epoch_ns().is_some());
        assert_eq!(source.status(), ChannelStatus::Up);
        assert_eq!(source.capabilities().timestamp_source, "file");
        assert!(matches!(
            source.read(Duration::ZERO),
            ChannelRead::Frame {
                ts_ns: 1_700_000_000_000_000_000,
                dir: crate::codes::DIR_UNKNOWN,
                ..
            }
        ));
        assert!(matches!(
            source.read(Duration::ZERO),
            ChannelRead::Frame { .. }
        ));
        assert!(matches!(
            source.read(Duration::ZERO),
            ChannelRead::Ended { detail } if detail == "end of file · 2 frames"
        ));
        assert_eq!(source.status(), ChannelStatus::Ended);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cp_022_seek_skips_earlier_frames_before_emitting() {
        let path = temp_pcap("cp022-seek", &pcap_bytes(5));
        let mut source = PcapSource::open(path.to_str().unwrap(), "fast", None).unwrap();

        source.control.seek(2_500_000);
        match source.read(Duration::ZERO) {
            ChannelRead::ReplaySeek { seek } => {
                assert_eq!(seek.frame, 3);
                assert_eq!(seek.t_ns, 3_000_000);
            }
            other => panic!("expected replay seek, got {other:?}"),
        }
        assert_eq!(source.frames, 3);

        match source.read(Duration::ZERO) {
            ChannelRead::Frame { ts_ns, .. } => {
                assert_eq!(ts_ns, 1_700_000_000_003_000_000);
            }
            other => panic!("expected landing frame, got {other:?}"),
        }
        assert_eq!(source.frames, 4);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn simlink_handshake_success_frames_gaps_and_metadata() {
        // CP-001: simulator source handshakes, sorts endpoint hints, and deframes records.
        let mut payload = Vec::new();
        payload.extend_from_slice(sim_handshake().as_bytes());
        payload.push(b'\n');
        encode_frame_record(10_000, 1, 1, &ethernet(1), &mut payload);
        encode_gap_record(11_000, 3, 250, &mut payload);
        let addr = serve_once(payload);
        let mut source = Source::open(&SourceSpec::Sim { addr }).unwrap();
        assert_eq!(source.source_kind(), "sim");
        assert!(!source.metadata_ready());

        match read_until_non_idle(&mut source) {
            ChannelRead::Frame { ts_ns, dir, wire } => {
                assert_eq!(ts_ns, source.session_epoch_ns().unwrap());
                assert_eq!(dir, crate::codes::DIR_RX);
                assert_eq!(wire.len(), 60);
            }
            other => panic!("expected sim frame, got {other:?}"),
        }
        assert!(matches!(
            source.status(),
            ChannelStatus::Up | ChannelStatus::Down(_)
        ));
        assert_eq!(source.scenario().as_deref(), Some("sensor-fusion"));
        assert_eq!(
            source.endpoint_hints(),
            vec![
                (
                    u32::from(std::net::Ipv4Addr::new(10, 42, 0, 11)),
                    "camera".into()
                ),
                (
                    u32::from(std::net::Ipv4Addr::new(10, 42, 0, 12)),
                    "radar".into()
                ),
            ]
        );
        assert!(source.metadata_ready());

        match source.read(Duration::ZERO) {
            ChannelRead::Gap { dropped, span_ns } => {
                assert_eq!((dropped, span_ns), (3, 250));
            }
            other => panic!("expected sim gap, got {other:?}"),
        }
    }

    #[test]
    fn simlink_handshake_rejections_surface_as_down_status() {
        for (name, bytes, needle) in [
            ("json", b"not-json\n".to_vec(), "handshake JSON"),
            (
                "link",
                br#"{"link":"wrong","version":1,"scenario":"x","ports":[]}"#.to_vec(),
                "handshake link",
            ),
            (
                "version",
                br#"{"link":"ecu-netsim-monitor","version":2,"scenario":"x","ports":[]}"#.to_vec(),
                "handshake version",
            ),
            ("eof", b"".to_vec(), "EOF before handshake newline"),
            (
                "long",
                vec![b'a'; 64 * 1024 + 1],
                "handshake line exceeds 64 KiB",
            ),
        ] {
            let mut payload = bytes;
            if !matches!(name, "json" | "eof" | "long") {
                payload.push(b'\n');
            }
            let addr = serve_once(payload);
            let mut source = Source::open(&SourceSpec::Sim { addr }).unwrap();
            assert!(matches!(
                source.read(Duration::from_millis(1)),
                ChannelRead::Idle
            ));
            match source.status() {
                ChannelStatus::Down(detail) => assert!(
                    detail.contains(needle),
                    "{name} detail {detail:?} did not contain {needle:?}"
                ),
                other => panic!("{name} expected down, got {other:?}"),
            }
        }
    }

    #[test]
    fn live_source_open_failure_returns_operator_diagnostic() {
        // CP-010/CP-012: live open errors are mapped to actionable diagnostics.
        let err = Source::open(&SourceSpec::Live {
            interface_id: "radeau-device-that-does-not-exist".into(),
            filter: None,
        })
        .err()
        .expect("live source should not open a bogus device");
        assert!(
            err.contains("Npcap is not installed")
                || err.contains("interface not found")
                || err.contains("live capture could not be opened")
                || err.contains("libpcap is not installed"),
            "unexpected live diagnostic: {err}"
        );
    }

    #[test]
    fn cp_004_realtime_pacing_sleep_is_capped_at_50_ms() {
        // CP-004: realtime replay sleeps in chunks capped at 50 ms.
        let anchor = Instant::now();
        assert_eq!(
            crate::replay::schedule_sleep(anchor, 0, 250_000_000, 1.0, anchor,),
            Some(Duration::from_millis(50))
        );
        assert!(crate::replay::schedule_sleep(anchor, 0, 0, 1.0, anchor).is_none());
    }
}
