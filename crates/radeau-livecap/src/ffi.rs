//! The only unsafe module in this crate (CP-010, CP-012).
//!
//! Layout assumptions follow the public pcap ABI. `pcap_if_t`, `pcap_addr_t`,
//! `pcap_pkthdr`, `bpf_program`, and the first three fields of `pcap_stat` are
//! C-layout structures. Winsock `timeval` uses two 32-bit fields; 64-bit Linux
//! uses two 64-bit fields. Npcap extends `pcap_stat`, so stats are received into
//! a zeroed 64-byte, u32-aligned buffer before its common prefix is read.

use std::ffi::{c_char, c_int, c_uchar, c_uint, c_void, CStr, CString};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::ptr;
use std::sync::OnceLock;

use libloading::Library;

use crate::{Device, Packet, Stats, DEFAULT_FILTER};

#[cfg(target_os = "linux")]
pub const PCAP_ERROR_PERM_DENIED: i32 = -8;
const PCAP_IF_LOOPBACK: u32 = 1;
const PCAP_IF_UP: u32 = 2;
const PCAP_TSTAMP_PRECISION_NANO: c_int = 1;
const PCAP_ERRBUF_SIZE: usize = 256;
const PCAP_NETMASK_UNKNOWN: u32 = 0xffff_ffff;

#[repr(C)]
struct PcapIf {
    next: *mut PcapIf,
    name: *mut c_char,
    description: *mut c_char,
    addresses: *mut PcapAddr,
    flags: u32,
}

#[repr(C)]
struct PcapAddr {
    next: *mut PcapAddr,
    addr: *mut SockAddr,
    netmask: *mut SockAddr,
    broadaddr: *mut SockAddr,
    dstaddr: *mut SockAddr,
}

#[repr(C)]
struct SockAddr {
    family: u16,
    data: [u8; 14],
}

#[cfg(windows)]
#[repr(C)]
struct TimeVal {
    tv_sec: i32,
    tv_usec: i32,
}

#[cfg(not(windows))]
#[repr(C)]
struct TimeVal {
    tv_sec: i64,
    tv_usec: i64,
}

#[repr(C)]
struct PcapPkthdr {
    ts: TimeVal,
    caplen: u32,
    len: u32,
}

#[repr(C)]
struct BpfProgram {
    bf_len: u32,
    bf_insns: *mut c_void,
}

#[repr(C)]
struct PcapStat {
    ps_recv: u32,
    ps_drop: u32,
    ps_ifdrop: u32,
}

enum Pcap {}

type LibVersion = unsafe extern "C" fn() -> *const c_char;
type FindAllDevs = unsafe extern "C" fn(*mut *mut PcapIf, *mut c_char) -> c_int;
type FreeAllDevs = unsafe extern "C" fn(*mut PcapIf);
type Create = unsafe extern "C" fn(*const c_char, *mut c_char) -> *mut Pcap;
type SetInt = unsafe extern "C" fn(*mut Pcap, c_int) -> c_int;
type Activate = unsafe extern "C" fn(*mut Pcap) -> c_int;
type Datalink = unsafe extern "C" fn(*mut Pcap) -> c_int;
type NextEx = unsafe extern "C" fn(*mut Pcap, *mut *const PcapPkthdr, *mut *const c_uchar) -> c_int;
type GetStats = unsafe extern "C" fn(*mut Pcap, *mut PcapStat) -> c_int;
type Compile =
    unsafe extern "C" fn(*mut Pcap, *mut BpfProgram, *const c_char, c_int, c_uint) -> c_int;
type SetFilter = unsafe extern "C" fn(*mut Pcap, *mut BpfProgram) -> c_int;
type FreeCode = unsafe extern "C" fn(*mut BpfProgram);
type GetErr = unsafe extern "C" fn(*mut Pcap) -> *mut c_char;
type StatusToStr = unsafe extern "C" fn(c_int) -> *const c_char;
type Close = unsafe extern "C" fn(*mut Pcap);

struct Api {
    _library: Library,
    lib_version: LibVersion,
    find_all_devs: FindAllDevs,
    free_all_devs: FreeAllDevs,
    create: Create,
    set_snaplen: SetInt,
    set_promisc: SetInt,
    set_timeout: SetInt,
    set_immediate_mode: SetInt,
    set_tstamp_precision: SetInt,
    activate: Activate,
    datalink: Datalink,
    next_ex: NextEx,
    stats: GetStats,
    compile: Compile,
    setfilter: SetFilter,
    freecode: FreeCode,
    geterr: GetErr,
    statustostr: StatusToStr,
    close: Close,
}

static API: OnceLock<Result<Api, String>> = OnceLock::new();

fn api() -> Result<&'static Api, String> {
    API.get_or_init(load_api).as_ref().map_err(Clone::clone)
}

fn load_api() -> Result<Api, String> {
    // CP-010: resolve every libpcap/Npcap symbol at runtime; no link-time SDK dependency.
    let mut errors = Vec::new();
    for candidate in library_candidates() {
        // SAFETY: loading a named pcap library is the purpose of this module;
        // every required symbol is resolved before the handle is published.
        let library = match unsafe { Library::new(&candidate) } {
            Ok(library) => library,
            Err(error) => {
                errors.push(format!("{}: {error}", candidate.to_string_lossy()));
                continue;
            }
        };
        // SAFETY: each signature is the documented libpcap ABI, and copied
        // function pointers remain valid because `Api` owns the library.
        unsafe {
            macro_rules! symbol {
                ($name:literal, $ty:ty) => {
                    *library
                        .get::<$ty>(concat!($name, "\0").as_bytes())
                        .map_err(|error| format!("loader failed: {}: {error}", $name))?
                };
            }
            let api = Api {
                lib_version: symbol!("pcap_lib_version", LibVersion),
                find_all_devs: symbol!("pcap_findalldevs", FindAllDevs),
                free_all_devs: symbol!("pcap_freealldevs", FreeAllDevs),
                create: symbol!("pcap_create", Create),
                set_snaplen: symbol!("pcap_set_snaplen", SetInt),
                set_promisc: symbol!("pcap_set_promisc", SetInt),
                set_timeout: symbol!("pcap_set_timeout", SetInt),
                set_immediate_mode: symbol!("pcap_set_immediate_mode", SetInt),
                set_tstamp_precision: symbol!("pcap_set_tstamp_precision", SetInt),
                activate: symbol!("pcap_activate", Activate),
                datalink: symbol!("pcap_datalink", Datalink),
                next_ex: symbol!("pcap_next_ex", NextEx),
                stats: symbol!("pcap_stats", GetStats),
                compile: symbol!("pcap_compile", Compile),
                setfilter: symbol!("pcap_setfilter", SetFilter),
                freecode: symbol!("pcap_freecode", FreeCode),
                geterr: symbol!("pcap_geterr", GetErr),
                statustostr: symbol!("pcap_statustostr", StatusToStr),
                close: symbol!("pcap_close", Close),
                _library: library,
            };
            return Ok(api);
        }
    }
    Err(format!("loader failed: {}", errors.join("; ")))
}

#[cfg(windows)]
fn library_candidates() -> Vec<std::ffi::OsString> {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    vec![
        std::path::PathBuf::from(root)
            .join("System32")
            .join("Npcap")
            .join("wpcap.dll")
            .into_os_string(),
        "wpcap.dll".into(),
    ]
}

#[cfg(target_os = "linux")]
fn library_candidates() -> Vec<std::ffi::OsString> {
    ["libpcap.so.1", "libpcap.so.0.8", "libpcap.so"]
        .into_iter()
        .map(Into::into)
        .collect()
}

#[cfg(not(any(windows, target_os = "linux")))]
fn library_candidates() -> Vec<std::ffi::OsString> {
    Vec::new()
}

fn text(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    // SAFETY: libpcap returns NUL-terminated strings valid for the documented
    // lifetime; callers copy them immediately.
    unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
}

fn errbuf_text(buffer: &[c_char; PCAP_ERRBUF_SIZE]) -> String {
    text(buffer.as_ptr())
}

pub fn library_version() -> Result<String, String> {
    let api = api()?;
    // SAFETY: the resolved no-argument function returns a static C string.
    Ok(text(unsafe { (api.lib_version)() }))
}

pub fn list_devices() -> Result<Vec<Device>, String> {
    let api = api()?;
    let mut head = ptr::null_mut();
    let mut error = [0 as c_char; PCAP_ERRBUF_SIZE];
    // SAFETY: both out-pointers are valid, and the returned list is freed once.
    let status = unsafe { (api.find_all_devs)(&mut head, error.as_mut_ptr()) };
    if status != 0 {
        return Err(errbuf_text(&error));
    }
    struct DeviceList<'a> {
        api: &'a Api,
        head: *mut PcapIf,
    }
    impl Drop for DeviceList<'_> {
        fn drop(&mut self) {
            // SAFETY: `head` came from pcap_findalldevs and is freed once.
            unsafe { (self.api.free_all_devs)(self.head) };
        }
    }
    let list = DeviceList { api, head };
    let mut devices = Vec::new();
    let mut cursor = list.head;
    while !cursor.is_null() {
        // SAFETY: nodes and strings remain valid until the list guard drops.
        let item = unsafe { &*cursor };
        let id = text(item.name);
        if !id.is_empty() {
            let description = (!item.description.is_null())
                .then(|| text(item.description))
                .filter(|value| !value.is_empty());
            let mut addresses = Vec::new();
            let mut address = item.addresses;
            while !address.is_null() {
                // SAFETY: address nodes share the owning device-list lifetime.
                let current = unsafe { &*address };
                if let Some(rendered) = render_sockaddr(current.addr) {
                    if !addresses.contains(&rendered) {
                        addresses.push(rendered);
                    }
                }
                address = current.next;
            }
            devices.push(Device {
                name: id.clone(),
                id,
                description,
                addresses,
                up: item.flags & PCAP_IF_UP != 0,
                loopback: item.flags & PCAP_IF_LOOPBACK != 0,
            });
        }
        cursor = item.next;
    }
    Ok(devices)
}

fn render_sockaddr(address: *mut SockAddr) -> Option<String> {
    if address.is_null() {
        return None;
    }
    // SAFETY: the pointer belongs to the live pcap device list. IPv4 and IPv6
    // address byte offsets are identical in Winsock and Linux sockaddr types.
    unsafe {
        let bytes = address.cast::<u8>();
        let family = (*address).family as i32;
        if family == 2 {
            let octets = std::slice::from_raw_parts(bytes.add(4), 4);
            return Some(Ipv4Addr::new(octets[0], octets[1], octets[2], octets[3]).to_string());
        }
        #[cfg(windows)]
        const AF_INET6_VALUE: i32 = 23;
        #[cfg(not(windows))]
        const AF_INET6_VALUE: i32 = 10;
        if family == AF_INET6_VALUE {
            let octets: [u8; 16] = std::slice::from_raw_parts(bytes.add(8), 16)
                .try_into()
                .ok()?;
            return Some(Ipv6Addr::from(octets).to_string());
        }
    }
    None
}

pub struct RawCapture {
    api: &'static Api,
    handle: *mut Pcap,
}

type OpenResult = Result<(RawCapture, bool, i32, Vec<String>), (String, Option<i32>)>;

// A pcap handle is owned by exactly one reader thread and never accessed
// concurrently. Moving that ownership to the capture thread is safe.
unsafe impl Send for RawCapture {}

impl RawCapture {
    pub fn open(id: &str, filter: Option<&str>) -> OpenResult {
        // CP-012: snaplen 65535, promiscuous, immediate mode, 100 ms timeout, ns when available.
        let api = api().map_err(|error| (error, None))?;
        let id = CString::new(id).map_err(|_| ("interface id contains NUL".into(), None))?;
        let mut error = [0 as c_char; PCAP_ERRBUF_SIZE];
        // SAFETY: the id and error buffer are valid C pointers for the call.
        let handle = unsafe { (api.create)(id.as_ptr(), error.as_mut_ptr()) };
        if handle.is_null() {
            return Err((errbuf_text(&error), None));
        }
        let mut capture = Self { api, handle };
        capture.configure(api.set_snaplen, 65_535, "set snaplen")?;
        capture.configure(api.set_promisc, 1, "set promiscuous mode")?;
        capture.configure(api.set_timeout, 100, "set read timeout")?;
        capture.configure(api.set_immediate_mode, 1, "set immediate mode")?;
        // SAFETY: handle is open and not activated yet.
        let precision_ns =
            unsafe { (api.set_tstamp_precision)(capture.handle, PCAP_TSTAMP_PRECISION_NANO) == 0 };
        // SAFETY: activation is called exactly once after all pre-activation settings.
        let activation = unsafe { (api.activate)(capture.handle) };
        if activation < 0 {
            return Err((capture.status_error(activation), Some(activation)));
        }
        let mut warnings = Vec::new();
        if activation > 0 {
            warnings.push(capture.status_error(activation));
        }
        let datalink = capture.datalink();
        if let Some(filter) = filter {
            if let Err(error) = capture.apply_filter(filter) {
                // Npcap's BSD-loopback data link rejects the `vlan` primitive.
                // Preserve the default's useful loopback traffic selection
                // instead of making the built-in loopback adapter unusable.
                if filter == DEFAULT_FILTER
                    && error.0.to_ascii_lowercase().contains("no vlan support")
                {
                    capture.apply_filter("udp")?;
                    warnings.push(format!(
                        "default capture filter reduced to 'udp' for this data link: {}",
                        error.0
                    ));
                } else {
                    return Err(error);
                }
            }
        }
        Ok((capture, precision_ns, datalink, warnings))
    }

    pub fn datalink(&self) -> i32 {
        // SAFETY: pcap_datalink is valid on an activated live handle.
        unsafe { (self.api.datalink)(self.handle) }
    }

    fn configure(
        &mut self,
        function: SetInt,
        value: c_int,
        operation: &str,
    ) -> Result<(), (String, Option<i32>)> {
        // SAFETY: used only before activation with a live owned handle.
        let status = unsafe { function(self.handle, value) };
        if status != 0 {
            Err((
                format!("{operation}: {}", self.status_error(status)),
                Some(status),
            ))
        } else {
            Ok(())
        }
    }

    fn apply_filter(&mut self, filter: &str) -> Result<(), (String, Option<i32>)> {
        let filter =
            CString::new(filter).map_err(|_| ("capture filter contains NUL".into(), None))?;
        let mut program = BpfProgram {
            bf_len: 0,
            bf_insns: ptr::null_mut(),
        };
        // SAFETY: handle is activated; program is a valid out object and filter
        // remains alive through compilation.
        let status = unsafe {
            (self.api.compile)(
                self.handle,
                &mut program,
                filter.as_ptr(),
                1,
                PCAP_NETMASK_UNKNOWN,
            )
        };
        if status != 0 {
            return Err((
                format!("compile capture filter: {}", self.error()),
                Some(status),
            ));
        }
        struct ProgramGuard<'a> {
            api: &'a Api,
            program: *mut BpfProgram,
        }
        impl Drop for ProgramGuard<'_> {
            fn drop(&mut self) {
                // SAFETY: pcap_compile initialized this program and it is freed once.
                unsafe { (self.api.freecode)(self.program) };
            }
        }
        let guard = ProgramGuard {
            api: self.api,
            program: &mut program,
        };
        // SAFETY: handle and compiled program are valid for this call.
        let status = unsafe { (self.api.setfilter)(self.handle, guard.program) };
        if status != 0 {
            Err((
                format!("set capture filter: {}", self.error()),
                Some(status),
            ))
        } else {
            Ok(())
        }
    }

    pub fn next(&mut self, precision_ns: bool) -> Result<Option<Packet>, String> {
        let mut header = ptr::null();
        let mut data = ptr::null();
        // SAFETY: pcap_next_ex initializes both pointers; copied packet data is
        // consumed before the next libpcap operation.
        let status = unsafe { (self.api.next_ex)(self.handle, &mut header, &mut data) };
        match status {
            1 => {
                if header.is_null() || data.is_null() {
                    return Err("pcap returned a packet with null data".into());
                }
                // SAFETY: status 1 guarantees a valid header and caplen bytes.
                let header = unsafe { &*header };
                let bytes = unsafe { std::slice::from_raw_parts(data, header.caplen as usize) };
                let seconds = u64::try_from(header.ts.tv_sec).unwrap_or(0);
                let fraction = u64::try_from(header.ts.tv_usec).unwrap_or(0);
                Ok(Some(Packet {
                    ts_ns: seconds
                        .saturating_mul(1_000_000_000)
                        .saturating_add(if precision_ns {
                            fraction
                        } else {
                            fraction.saturating_mul(1_000)
                        }),
                    caplen_truncated: header.caplen < header.len,
                    data: bytes.to_vec(),
                }))
            }
            0 | -2 => Ok(None),
            -1 => Err(self.error()),
            other => Err(self.status_error(other)),
        }
    }

    pub fn stats(&mut self) -> Result<Stats, String> {
        let mut buffer = [0u32; 16];
        // SAFETY: the buffer is 64 bytes, zeroed, and aligned for the common
        // pcap_stat prefix as well as Npcap's extended structure.
        let status =
            unsafe { (self.api.stats)(self.handle, buffer.as_mut_ptr().cast::<PcapStat>()) };
        if status != 0 {
            return Err(self.error());
        }
        Ok(Stats {
            recv: buffer[0] as u64,
            drop: buffer[1] as u64,
            ifdrop: buffer[2] as u64,
        })
    }

    fn error(&self) -> String {
        // SAFETY: handle is live and pcap_geterr returns an owned-handle string.
        text(unsafe { (self.api.geterr)(self.handle) })
    }

    fn status_error(&self, status: c_int) -> String {
        // SAFETY: status-to-string accepts every pcap status integer.
        let status_text = text(unsafe { (self.api.statustostr)(status) });
        let detail = self.error();
        match (status_text.is_empty(), detail.is_empty()) {
            (false, false) if !status_text.eq_ignore_ascii_case(&detail) => {
                format!("{status_text}: {detail}")
            }
            (false, _) => status_text,
            (_, false) => detail,
            _ => format!("pcap status {status}"),
        }
    }
}

impl Drop for RawCapture {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            // SAFETY: this object exclusively owns the handle and closes it once.
            unsafe { (self.api.close)(self.handle) };
            self.handle = ptr::null_mut();
        }
    }
}
