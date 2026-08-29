//! Diagnostics commands (SRS_capture.md §5, CP-008): dependency probes, the
//! plain-text report, the log path, and opening vendor download pages.

use tauri::State;

use crate::catalog::CatalogState;
use crate::deps::{self, DependencyRow, ReportInput};
use crate::log;

#[cfg(debug_assertions)]
const BUILD_PROFILE: &str = "debug";
#[cfg(not(debug_assertions))]
const BUILD_PROFILE: &str = "release";

fn os_string() -> String {
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

#[tauri::command]
pub fn dependency_probe() -> Vec<DependencyRow> {
    let rows = deps::probe_all();
    log::log(
        log::Level::Info,
        "deps",
        "dependency probe",
        serde_json::json!({
            "rows": rows.iter().map(|r| format!("{}={}", r.id, r.status)).collect::<Vec<_>>()
        }),
    );
    rows
}

#[tauri::command]
pub fn diagnostics_report(catalog: State<CatalogState>) -> String {
    let catalog_value = serde_json::to_value(crate::catalog::catalog_model(catalog))
        .ok()
        .map(|v| {
            serde_json::json!({
                "source": v.get("source").cloned().unwrap_or(serde_json::Value::Null),
                "loaded": v.get("loaded").cloned().unwrap_or(serde_json::Value::Null),
                "services": v.get("services").and_then(|s| s.as_array()).map(|a| a.len()),
            })
        });
    deps::diagnostics_report(ReportInput {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        build_profile: BUILD_PROFILE,
        os: os_string(),
        log_path: log::path().map(|p| p.display().to_string()),
        deps: deps::probe_all(),
        last_session: None,
        catalog: catalog_value,
        recent_warnings: log::recent_warnings(20),
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: &'static str,
    build_profile: &'static str,
    os: String,
    /// The dev frame generator exists only in debug builds.
    devgen_available: bool,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        build_profile: BUILD_PROFILE,
        os: os_string(),
        devgen_available: cfg!(debug_assertions),
    }
}

#[tauri::command]
pub fn log_path() -> Option<String> {
    log::path().map(|p| p.display().to_string())
}

/// Opens an official vendor page in the system browser. Only http(s) URLs
/// are accepted so the command can never launch a local program.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs can be opened".into());
    }
    open::that_detached(&url).map_err(|e| e.to_string())
}

pub fn log_startup() {
    log::log_startup(env!("CARGO_PKG_VERSION"), &os_string());
}
