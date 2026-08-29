#![allow(dead_code)]

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

const NPCAP_URL: &str = "https://npcap.com/#download";
const LIBPCAP_URL: &str = "https://www.tcpdump.org/";
const VXLAPI_URL: &str = "https://www.vector.com/int/en/download/xl-driver-library/";
const VECTOR_DRIVER_URL: &str = "https://vector.com/latest_driver";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyRow {
    pub id: &'static str,
    pub name: &'static str,
    pub enables: &'static str,
    pub status: &'static str,
    pub version: Option<String>,
    pub path: Option<String>,
    pub detail: Option<String>,
    pub download_url: &'static str,
}

#[derive(Clone, Debug)]
pub struct ReportInput {
    pub app_version: String,
    pub build_profile: &'static str,
    pub os: String,
    pub log_path: Option<String>,
    pub deps: Vec<DependencyRow>,
    pub last_session: Option<Value>,
    pub catalog: Option<Value>,
    pub recent_warnings: Vec<String>,
}

pub fn probe_all() -> Vec<DependencyRow> {
    vec![
        probe_npcap(),
        probe_libpcap(),
        probe_vxlapi(),
        probe_vector_driver(),
    ]
}

pub fn diagnostics_report(input: ReportInput) -> String {
    let mut out = String::from("RadEAU diagnostics report\n\n[Application]\n");
    key_value(&mut out, "Version", &input.app_version);
    key_value(&mut out, "Build profile", input.build_profile);
    key_value(&mut out, "OS", &input.os);
    key_value(
        &mut out,
        "Log path",
        input.log_path.as_deref().unwrap_or("not available"),
    );

    out.push_str("\n[Dependencies]\n");
    if input.deps.is_empty() {
        out.push_str("None\n");
    } else {
        for dependency in &input.deps {
            out.push_str(&format!("{} ({})\n", dependency.name, dependency.id));
            key_value(&mut out, "  Status", dependency.status);
            key_value(&mut out, "  Enables", dependency.enables);
            key_value(
                &mut out,
                "  Version",
                dependency.version.as_deref().unwrap_or("—"),
            );
            key_value(
                &mut out,
                "  Path",
                dependency.path.as_deref().unwrap_or("—"),
            );
            key_value(
                &mut out,
                "  Detail",
                dependency.detail.as_deref().unwrap_or("—"),
            );
            key_value(&mut out, "  Download", dependency.download_url);
        }
    }

    out.push_str("\n[Interfaces]\nNot available in this build\n");
    out.push_str("\n[Last session]\n");
    append_json_topic(
        &mut out,
        input.last_session.as_ref(),
        &["source", "linkState", "stats"],
    );
    out.push_str("\n[Catalog]\n");
    append_json_topic(
        &mut out,
        input.catalog.as_ref(),
        &["source", "services", "diagnostics"],
    );
    out.push_str("\n[Recent warnings and errors]\n");
    if input.recent_warnings.is_empty() {
        out.push_str("None\n");
    } else {
        for line in input.recent_warnings {
            out.push_str(&line);
            out.push('\n');
        }
    }
    out
}

fn key_value(out: &mut String, key: &str, value: &str) {
    out.push_str(&format!("{key:<16}: {value}\n"));
}

fn append_json_topic(out: &mut String, value: Option<&Value>, keys: &[&str]) {
    let Some(value) = value else {
        out.push_str("None\n");
        return;
    };
    for key in keys {
        let rendered = value
            .get(*key)
            .map(render_json)
            .unwrap_or_else(|| "—".into());
        key_value(out, &title(key), &rendered);
    }
}

fn render_json(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "—".into()),
    }
}

fn title(key: &str) -> String {
    let mut result = String::new();
    for (index, ch) in key.chars().enumerate() {
        if ch.is_uppercase() && index != 0 {
            result.push(' ');
        }
        if index == 0 {
            result.extend(ch.to_uppercase());
        } else {
            result.push(ch.to_ascii_lowercase());
        }
    }
    result
}

fn not_applicable(
    id: &'static str,
    name: &'static str,
    enables: &'static str,
    platform: &'static str,
    download_url: &'static str,
) -> DependencyRow {
    DependencyRow {
        id,
        name,
        enables,
        status: "not-applicable",
        version: None,
        path: None,
        detail: Some(platform.into()),
        download_url,
    }
}

#[cfg(windows)]
fn probe_npcap() -> DependencyRow {
    let path = system_root()
        .join("System32")
        .join("Npcap")
        .join("wpcap.dll");
    let registry = registry_key(r"SOFTWARE\Npcap");
    let installed = path.is_file() || registry.is_some();
    let admin_only = registry
        .as_ref()
        .and_then(|key| registry_dword(*key, "AdminOnly"))
        == Some(1);
    let registry_version = registry.as_ref().and_then(|key| registry_version(*key));
    if let Some(key) = registry {
        close_registry_key(key);
    }
    let version = file_version(&path)
        .or(registry_version)
        .or_else(|| radeau_livecap::library_version().ok());
    DependencyRow {
        id: "npcap",
        name: "Npcap",
        enables: "Live capture on a physical or virtual Ethernet adapter",
        status: if admin_only { "blocked" } else if installed { "installed" } else { "missing" },
        version,
        path: path.is_file().then(|| path.display().to_string()),
        detail: admin_only.then(|| "installed with 'Restrict Npcap driver's access to Administrators only' — reinstall without that option or run as administrator".into()),
        download_url: NPCAP_URL,
    }
}

#[cfg(not(windows))]
fn probe_npcap() -> DependencyRow {
    not_applicable(
        "npcap",
        "Npcap",
        "Live capture on a physical or virtual Ethernet adapter",
        "Windows only",
        NPCAP_URL,
    )
}

#[cfg(target_os = "linux")]
fn probe_libpcap() -> DependencyRow {
    const DIRS: &[&str] = &[
        "/usr/lib",
        "/usr/lib64",
        "/usr/lib/x86_64-linux-gnu",
        "/lib/x86_64-linux-gnu",
    ];
    const NAMES: &[&str] = &["libpcap.so.1", "libpcap.so.0.8"];
    let found = DIRS
        .iter()
        .flat_map(|dir| NAMES.iter().map(move |name| Path::new(dir).join(name)))
        .find(|path| path.is_file());
    DependencyRow {
        id: "libpcap", name: "libpcap", enables: "Live capture on a physical or virtual Ethernet adapter",
        status: if found.is_some() { "installed" } else { "missing" },
        version: radeau_livecap::library_version().ok(),
        path: found.map(|path| path.display().to_string()),
        detail: Some("Install the distro package (for example libpcap1 on Debian/Ubuntu or libpcap on Fedora).".into()),
        download_url: LIBPCAP_URL,
    }
}

#[cfg(not(target_os = "linux"))]
fn probe_libpcap() -> DependencyRow {
    not_applicable(
        "libpcap",
        "libpcap",
        "Live capture on a physical or virtual Ethernet adapter",
        "Linux only",
        LIBPCAP_URL,
    )
}

#[cfg(windows)]
fn probe_vxlapi() -> DependencyRow {
    let mut candidates = vec![system_root().join("System32").join("vxlapi64.dll")];
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("Vector XL Driver Library")
                .join("bin")
                .join("vxlapi64.dll"),
        );
    }
    if let Some(search_path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&search_path).map(|dir| dir.join("vxlapi64.dll")));
    }
    let found = candidates.into_iter().find(|path| path.is_file());
    let version = found.as_deref().and_then(file_version);
    DependencyRow {
        id: "vxlapi",
        name: "Vector XL Driver Library",
        enables: "Vector VN Ethernet interfaces",
        status: if found.is_some() {
            "installed"
        } else {
            "missing"
        },
        version,
        path: found.map(|path| path.display().to_string()),
        detail: None,
        download_url: VXLAPI_URL,
    }
}

#[cfg(not(windows))]
fn probe_vxlapi() -> DependencyRow {
    not_applicable(
        "vxlapi",
        "Vector XL Driver Library",
        "Vector VN Ethernet interfaces",
        "Windows only",
        VXLAPI_URL,
    )
}

#[cfg(windows)]
fn probe_vector_driver() -> DependencyRow {
    let found = [r"SOFTWARE\Vector", r"SOFTWARE\WOW6432Node\Vector"]
        .into_iter()
        .find_map(|path| registry_key(path).map(|key| (path, key)));
    let version = found.as_ref().and_then(|(_, key)| registry_version(*key));
    if let Some((_, key)) = found.as_ref() {
        close_registry_key(*key);
    }
    DependencyRow {
        id: "vector-driver",
        name: "Vector driver package",
        enables: "Vector VN Ethernet interfaces",
        status: if found.is_some() {
            "installed"
        } else {
            "missing"
        },
        version,
        path: found.map(|(path, _)| format!("HKLM\\{path}")),
        detail: None,
        download_url: VECTOR_DRIVER_URL,
    }
}

#[cfg(not(windows))]
fn probe_vector_driver() -> DependencyRow {
    not_applicable(
        "vector-driver",
        "Vector driver package",
        "Vector VN Ethernet interfaces",
        "Windows only",
        VECTOR_DRIVER_URL,
    )
}

#[cfg(windows)]
fn system_root() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

#[cfg(windows)]
type RegistryKey = windows_sys::Win32::System::Registry::HKEY;

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn registry_key(path: &str) -> Option<RegistryKey> {
    use windows_sys::Win32::System::Registry::{
        RegOpenKeyExW, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY,
    };
    let mut key = std::ptr::null_mut();
    let path = wide(path);
    // SAFETY: buffers are NUL-terminated and `key` is a valid out pointer.
    let result = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            path.as_ptr(),
            0,
            KEY_READ | KEY_WOW64_64KEY,
            &mut key,
        )
    };
    (result == 0).then_some(key)
}

#[cfg(windows)]
fn registry_dword(key: RegistryKey, name: &str) -> Option<u32> {
    use windows_sys::Win32::System::Registry::{RegQueryValueExW, REG_DWORD};
    let name = wide(name);
    let mut kind = 0;
    let mut value = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: key came from RegOpenKeyExW; all output buffers match their declared sizes.
    let result = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            (&mut value as *mut u32).cast(),
            &mut size,
        )
    };
    (result == 0 && kind == REG_DWORD && size == 4).then_some(value)
}

#[cfg(windows)]
fn registry_version(key: RegistryKey) -> Option<String> {
    ["Version", "DriverVersion", "ProductVersion", "version"]
        .into_iter()
        .find_map(|name| registry_string_open(key, name))
}

#[cfg(windows)]
fn close_registry_key(key: RegistryKey) {
    use windows_sys::Win32::System::Registry::RegCloseKey;
    // SAFETY: key came from RegOpenKeyExW and each caller closes it exactly once.
    unsafe { RegCloseKey(key) };
}

#[cfg(windows)]
fn registry_string_open(key: RegistryKey, name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegQueryValueExW, REG_EXPAND_SZ, REG_SZ};
    let name = wide(name);
    let mut kind = 0;
    let mut size = 0u32;
    // SAFETY: first call asks Windows for the required buffer length.
    if unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            std::ptr::null_mut(),
            &mut size,
        )
    } != 0
        || !matches!(kind, REG_SZ | REG_EXPAND_SZ)
        || size < 2
    {
        return None;
    }
    let mut bytes = vec![0u8; size as usize];
    // SAFETY: byte buffer has exactly the size reported by the first query.
    if unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            bytes.as_mut_ptr(),
            &mut size,
        )
    } != 0
    {
        return None;
    }
    let words =
        unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast::<u16>(), size as usize / 2) };
    let end = words
        .iter()
        .position(|word| *word == 0)
        .unwrap_or(words.len());
    let value = String::from_utf16_lossy(&words[..end]).trim().to_owned();
    (!value.is_empty()).then_some(value)
}

#[cfg(windows)]
fn file_version(path: &Path) -> Option<String> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
    };
    let path = wide(path.to_str()?);
    // SAFETY: path is a valid NUL-terminated UTF-16 string.
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), std::ptr::null_mut()) };
    if size == 0 {
        return None;
    }
    let mut data = vec![0u8; size as usize];
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 {
        return None;
    }
    let query = wide(r"\");
    let mut fixed: *mut std::ffi::c_void = std::ptr::null_mut();
    let mut fixed_len = 0u32;
    if unsafe {
        VerQueryValueW(
            data.as_ptr().cast(),
            query.as_ptr(),
            &mut fixed,
            &mut fixed_len,
        )
    } == 0
        || fixed_len < std::mem::size_of::<VS_FIXEDFILEINFO>() as u32
    {
        return None;
    }
    let fixed = unsafe { &*(fixed.cast::<VS_FIXEDFILEINFO>()) };
    Some(format!(
        "{}.{}.{}.{}",
        fixed.dwFileVersionMS >> 16,
        fixed.dwFileVersionMS & 0xffff,
        fixed.dwFileVersionLS >> 16,
        fixed.dwFileVersionLS & 0xffff
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_order_ids_and_urls_are_stable() {
        let rows = probe_all();
        assert_eq!(
            rows.iter().map(|row| row.id).collect::<Vec<_>>(),
            ["npcap", "libpcap", "vxlapi", "vector-driver"]
        );
        assert_eq!(
            rows.iter().map(|row| row.download_url).collect::<Vec<_>>(),
            [NPCAP_URL, LIBPCAP_URL, VXLAPI_URL, VECTOR_DRIVER_URL]
        );
    }

    #[test]
    fn statuses_use_the_documented_vocabulary() {
        const STATUSES: &[&str] = &[
            "installed",
            "missing",
            "incompatible",
            "blocked",
            "not-applicable",
        ];
        for row in probe_all() {
            assert!(
                STATUSES.contains(&row.status),
                "unexpected status for {}: {}",
                row.id,
                row.status
            );
        }
    }

    #[test]
    fn diagnostics_report_is_deterministic() {
        let report = diagnostics_report(ReportInput {
            app_version: "0.1.6".into(),
            build_profile: "debug",
            os: "TestOS".into(),
            log_path: Some("/tmp/radeau.log".into()),
            deps: vec![DependencyRow {
                id: "npcap",
                name: "Npcap",
                enables: "Live capture",
                status: "missing",
                version: None,
                path: None,
                detail: Some("not found".into()),
                download_url: NPCAP_URL,
            }],
            last_session: Some(
                serde_json::json!({"source":"sim", "linkState":"closed", "stats":{"received":2}}),
            ),
            catalog: Some(serde_json::json!({"source":"embedded", "services":3, "diagnostics":0})),
            recent_warnings: vec!["warning one".into()],
        });
        assert_eq!(report, "RadEAU diagnostics report\n\n[Application]\nVersion         : 0.1.6\nBuild profile   : debug\nOS              : TestOS\nLog path        : /tmp/radeau.log\n\n[Dependencies]\nNpcap (npcap)\n  Status        : missing\n  Enables       : Live capture\n  Version       : —\n  Path          : —\n  Detail        : not found\n  Download      : https://npcap.com/#download\n\n[Interfaces]\nNot available in this build\n\n[Last session]\nSource          : sim\nLink state      : closed\nStats           : {\"received\":2}\n\n[Catalog]\nSource          : embedded\nServices        : 3\nDiagnostics     : 0\n\n[Recent warnings and errors]\nwarning one\n");
    }
}
