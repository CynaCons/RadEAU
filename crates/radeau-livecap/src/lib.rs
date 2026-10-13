//! Safe, runtime-loaded Npcap/libpcap access.

mod ffi;

use std::fmt;

pub const DEFAULT_FILTER: &str = "udp or ether proto 0x88f7 or arp or vlan";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkType {
    Ethernet,
    NullLoopback,
    Other(i32),
}

impl From<i32> for LinkType {
    fn from(value: i32) -> Self {
        match value {
            1 => Self::Ethernet,
            0 => Self::NullLoopback,
            other => Self::Other(other),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub addresses: Vec<String>,
    pub up: bool,
    pub loopback: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Packet {
    pub ts_ns: u64,
    pub caplen_truncated: bool,
    pub data: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub recv: u64,
    pub drop: u64,
    pub ifdrop: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenError {
    message: String,
    remedy: String,
}

impl OpenError {
    fn new(message: impl Into<String>, status: Option<i32>) -> Self {
        let message = message.into();
        let remedy = remedy_for(&message, status).to_owned();
        Self { message, remedy }
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn remedy(&self) -> &str {
        &self.remedy
    }
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.remedy)
    }
}

impl std::error::Error for OpenError {}

#[cfg(windows)]
const NOT_INSTALLED: &str = "Npcap is not installed — install it from https://npcap.com/#download (leave 'Restrict Npcap driver's access to Administrators only' unchecked)";
#[cfg(not(windows))]
const NOT_INSTALLED: &str =
    "libpcap is not installed — install the libpcap package for this Linux distribution";
const NPCAP_RESTRICTED: &str = "Npcap is restricted to administrators — reinstall Npcap without that option or run RadEAU as administrator";
#[cfg(target_os = "linux")]
const LINUX_CAPS: &str = "run: sudo setcap cap_net_raw,cap_net_admin+eip <path to radeau>";
const NOT_FOUND: &str = "interface not found — refresh the interface list";
const BUSY: &str = "device is in use by another capture";

fn remedy_for(message: &str, status: Option<i32>) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("loader failed")
        || lower.contains("not installed")
        || lower.contains("could not load")
        || lower.contains("cannot open shared object")
        || lower.contains("specified module could not be found")
    {
        return NOT_INSTALLED;
    }
    if lower.contains("no such device")
        || lower.contains("system cannot find the device")
        || lower.contains("device not found")
        || lower.contains("filename, directory name, or volume label syntax is incorrect")
    {
        return NOT_FOUND;
    }
    if lower.contains("busy") || lower.contains("in use by another") {
        return BUSY;
    }
    #[cfg(windows)]
    if lower.contains("restricted access")
        || lower.contains("access is denied")
        || lower.contains("access denied")
        || lower.contains("administrator")
    {
        return NPCAP_RESTRICTED;
    }
    #[cfg(target_os = "linux")]
    if status == Some(ffi::PCAP_ERROR_PERM_DENIED)
        || lower.contains("operation not permitted")
        || lower.contains("permission denied")
    {
        return LINUX_CAPS;
    }
    let _ = status;
    "live capture could not be opened — check the interface and capture-driver diagnostics"
}

/// Maps a runtime libpcap diagnostic to the same actionable text used while
/// opening a device.
pub fn capture_error_remedy(message: &str) -> String {
    remedy_for(message, None).to_owned()
}

pub fn library_version() -> Result<String, String> {
    ffi::library_version()
}

pub fn list_devices() -> Result<Vec<Device>, String> {
    ffi::list_devices()
}

pub struct LiveCapture {
    raw: ffi::RawCapture,
    pub precision_ns: bool,
    pub link_type: LinkType,
    pub warnings: Vec<String>,
}

impl LiveCapture {
    pub fn open(id: &str, filter: Option<&str>) -> Result<Self, OpenError> {
        let (raw, precision_ns, datalink, warnings) = ffi::RawCapture::open(id, filter)
            .map_err(|(message, status)| OpenError::new(message, status))?;
        Ok(Self {
            raw,
            precision_ns,
            link_type: datalink.into(),
            warnings,
        })
    }

    pub fn datalink(&self) -> i32 {
        self.raw.datalink()
    }

    pub fn next_packet(&mut self) -> Result<Option<Packet>, String> {
        self.raw.next(self.precision_ns)
    }

    pub fn stats(&mut self) -> Result<Stats, String> {
        self.raw.stats()
    }
}

/// Converts a DLT_NULL record to the Ethernet II shape consumed downstream.
/// Records too short to contain the loopback family header remain malformed.
pub fn null_loopback_to_ethernet(data: Vec<u8>) -> Vec<u8> {
    let Some(family_bytes) = data.get(..4).and_then(|bytes| bytes.try_into().ok()) else {
        return data;
    };
    let ether_type = match u32::from_ne_bytes(family_bytes) {
        2 => 0x0800_u16,
        23 | 24 | 28 | 30 => 0x86dd_u16,
        _ => 0xffff_u16,
    };
    let mut ethernet = Vec::with_capacity(14 + data.len() - 4);
    ethernet.extend_from_slice(&[0; 6]);
    ethernet.extend_from_slice(&[0x02, 0, 0, 0, 0, 1]);
    ethernet.extend_from_slice(&ether_type.to_be_bytes());
    ethernet.extend_from_slice(&data[4..]);
    ethernet
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_remedies_are_specific() {
        assert_eq!(remedy_for("loader failed: missing", None), NOT_INSTALLED);
        assert_eq!(remedy_for("No such device exists", None), NOT_FOUND);
        assert_eq!(remedy_for("device busy", None), BUSY);
        #[cfg(windows)]
        assert_eq!(remedy_for("Restricted access", None), NPCAP_RESTRICTED);
        #[cfg(target_os = "linux")]
        assert_eq!(
            remedy_for("Operation not permitted", Some(ffi::PCAP_ERROR_PERM_DENIED)),
            LINUX_CAPS
        );
    }

    #[test]
    fn null_loopback_ipv4_becomes_ethernet() {
        let mut raw = 2_u32.to_ne_bytes().to_vec();
        raw.extend_from_slice(&[0x45, 0, 0, 20]);
        let frame = null_loopback_to_ethernet(raw);
        assert_eq!(&frame[..6], &[0; 6]);
        assert_eq!(&frame[6..12], &[0x02, 0, 0, 0, 0, 1]);
        assert_eq!(&frame[12..14], &[0x08, 0x00]);
        assert_eq!(&frame[14..], &[0x45, 0, 0, 20]);
    }

    #[test]
    fn null_loopback_ipv6_families_become_ethernet() {
        for family in [23_u32, 24, 28, 30] {
            let mut raw = family.to_ne_bytes().to_vec();
            raw.extend_from_slice(&[0x60, 0, 0, 0]);
            let frame = null_loopback_to_ethernet(raw);
            assert_eq!(&frame[12..14], &[0x86, 0xdd], "family {family}");
            assert_eq!(&frame[14..], &[0x60, 0, 0, 0]);
        }
    }

    #[test]
    fn unknown_null_loopback_family_becomes_other_ether_type() {
        let mut raw = 999_u32.to_ne_bytes().to_vec();
        raw.extend_from_slice(&[1, 2, 3]);
        let frame = null_loopback_to_ethernet(raw);
        assert_eq!(&frame[12..14], &[0xff, 0xff]);
        assert_eq!(&frame[14..], &[1, 2, 3]);
    }

    #[test]
    fn short_null_loopback_record_stays_malformed_sized() {
        for raw in [vec![], vec![2], vec![2, 0], vec![2, 0, 0]] {
            assert_eq!(null_loopback_to_ethernet(raw.clone()), raw);
        }
    }

    #[test]
    fn enumeration_never_panics() {
        match list_devices() {
            Ok(_) => {}
            Err(error) => assert_eq!(remedy_for(&error, None), NOT_INSTALLED),
        }
    }

    #[test]
    fn bogus_device_has_refresh_remedy_when_library_is_present() {
        if library_version().is_err() {
            eprintln!("capture library absent; bogus-device test skipped");
            return;
        }
        let error = match LiveCapture::open("radeau-device-that-does-not-exist", None) {
            Ok(_) => panic!("bogus capture device unexpectedly opened"),
            Err(error) => error,
        };
        assert_eq!(error.remedy(), NOT_FOUND, "raw error: {}", error.message());
    }

    #[test]
    #[ignore = "requires an installed capture library and loopback adapter"]
    fn live_loopback_udp_smoke() {
        use std::net::UdpSocket;
        use std::time::{Duration, Instant};

        let devices = match list_devices() {
            Ok(devices) => devices,
            Err(error) => {
                eprintln!("capture library absent; loopback smoke skipped: {error}");
                return;
            }
        };
        for device in &devices {
            eprintln!(
                "device id={:?} description={:?} loopback={}",
                device.id, device.description, device.loopback
            );
        }
        let Some(loopback) = devices.iter().find(|device| device.loopback) else {
            eprintln!("loopback device absent; loopback smoke skipped");
            return;
        };
        let mut capture =
            LiveCapture::open(&loopback.id, Some(DEFAULT_FILTER)).unwrap_or_else(|error| {
                panic!(
                    "could not open loopback: {}; raw: {}",
                    error,
                    error.message()
                )
            });
        eprintln!(
            "loopback datalink={} link_type={:?}",
            capture.datalink(),
            capture.link_type
        );
        assert_eq!(capture.link_type, LinkType::NullLoopback);
        let socket = UdpSocket::bind("127.0.0.1:0").expect("bind UDP sender");
        socket
            .send_to(b"RadEAU live capture smoke", "127.0.0.1:30490")
            .expect("send UDP datagram");

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match capture.next_packet() {
                Ok(Some(packet)) => {
                    let frame = null_loopback_to_ethernet(packet.data);
                    assert!(
                        frame.len() >= 34,
                        "captured frame too short: {}",
                        frame.len()
                    );
                    assert_eq!(&frame[12..14], &[0x08, 0x00]);
                    assert_eq!(&frame[26..30], &[127, 0, 0, 1]);
                    return;
                }
                Ok(None) => {}
                Err(error) => panic!("loopback read failed: {error}"),
            }
        }
        panic!("no loopback packet received within 2 seconds");
    }
}
