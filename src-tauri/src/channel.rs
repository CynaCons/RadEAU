//! Static-dispatch capture channels. Network and file parsing live here;
//! classification, retention, batching, and statistics stay in `capture`.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Read};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
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

pub enum Source {
    #[cfg(debug_assertions)]
    Devgen(DevgenSource),
    Sim(SimSource),
    Pcap(PcapSource),
    PcapStream(PcapStreamSource),
    Live(LiveSource),
}

impl Source {
    pub fn open(spec: &SourceSpec) -> Result<Self, String> {
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
            SourceSpec::Pcap { path, pace } => Ok(Self::Pcap(PcapSource::open(path, pace)?)),
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
    file: File,
    reader: radeau_pcap::PcapReader,
    pending: Option<radeau_pcap::Record>,
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
    fn open(path: &str, pace: &str) -> Result<Self, String> {
        if !matches!(pace, "realtime" | "fast") {
            return Err(format!("unknown pcap pace '{pace}'"));
        }
        let file = File::open(Path::new(path)).map_err(|e| format!("open {path}: {e}"))?;
        let mut source = Self {
            file,
            reader: radeau_pcap::PcapReader::new(),
            pending: None,
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
            match self.reader.next() {
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
        if self.pending.is_none() && !self.finished {
            if let Err(detail) = self.fill() {
                self.status = ChannelStatus::Ended;
                return ChannelRead::Ended { detail };
            }
        }
        let Some(record) = self.pending.take() else {
            return ChannelRead::Ended {
                detail: self.end_detail(),
            };
        };
        if !self.fast {
            if let Some(previous) = self.previous_ts {
                let raw_gap = record.ts_ns.saturating_sub(previous);
                let delay = raw_gap.min(5_000_000_000);
                if raw_gap > 5_000_000_000 {
                    self.collapsed_gaps += 1;
                }
                let started = Instant::now();
                let target = Duration::from_nanos(delay);
                while started.elapsed() < target {
                    std::thread::sleep(
                        Duration::from_millis(50).min(target.saturating_sub(started.elapsed())),
                    );
                }
            }
        }
        self.previous_ts = Some(record.ts_ns);
        self.frames += 1;
        ChannelRead::Frame {
            ts_ns: record.ts_ns,
            dir: record.dir,
            wire: record.wire,
        }
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
            match self.reader.next() {
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
        match self.capture.next() {
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
