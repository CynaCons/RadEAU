// RadEAU native core — Tauri 2 shell.
// The core owns capture links, files, and network surfaces; the WebView owns
// all visualization. IPC is exactly commands (request/response) and events
// (push) — see PRD.md §3.1.
// Windowed subsystem unconditionally: launching the executable (even a debug
// build) must never pop a console window. Diagnostics flow through the
// automation/event surfaces and the E2E CDP harness instead of stdout.
#![windows_subsystem = "windows"]
use tauri::Manager;

// The dev frame generator is a runtime-gated development data source
// (PRD §3.8) — compiled in every profile, activated only by an explicit
// capture profile, and superseded as the default source by ecu-netsim (v0.4).
mod capture;
mod catalog;
mod codes;
mod devgen;
mod dissect;
mod simlink;

fn main() {
    // Touch the shared protocol crate so the workspace dependency graph is
    // exercised from the first build.
    let _ = radeau_proto::CRATE_NAME;

    tauri::Builder::default()
        .manage(capture::CaptureState::default())
        .manage(catalog::CatalogState::default())
        .setup(|app| {
            catalog::emit_initial(app.state::<catalog::CatalogState>().inner(), &app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture::capture_start,
            capture::capture_stop,
            capture::ack_frames,
            catalog::catalog_model,
            catalog::catalog_load,
            catalog::catalog_unload,
            dissect::frame_detail,
        ])
        .run(tauri::generate_context!())
        .expect("error while running RadEAU");
}
