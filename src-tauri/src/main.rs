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
mod channel;
mod classify;
mod codes;
mod deps;
#[cfg(debug_assertions)]
mod devgen;
mod diag;
mod dissect;
mod endpoints;
mod frame;
mod log;
mod recording;
mod simlink;

fn main() {
    // Touch the shared protocol crate so the workspace dependency graph is
    // exercised from the first build.
    let _ = radeau_proto::CRATE_NAME;

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(capture::CaptureState::default())
        .manage(catalog::CatalogState::default())
        .manage(recording::RecordingState::default())
        .setup(|app| {
            if let Ok(dir) = app.path().app_log_dir() {
                log::init(dir);
                diag::log_startup();
            }
            app.state::<recording::RecordingState>()
                .init_dir(&app.handle());
            catalog::emit_initial(app.state::<catalog::CatalogState>().inner(), &app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture::capture_start,
            capture::capture_stop,
            capture::capture_list_interfaces,
            capture::ack_frames,
            capture::export_ring,
            catalog::catalog_model,
            catalog::catalog_load,
            catalog::catalog_unload,
            catalog::catalog_import,
            catalog::catalog_reload,
            catalog::catalog_diagnostics,
            dissect::frame_detail,
            diag::dependency_probe,
            diag::diagnostics_report,
            diag::app_info,
            diag::log_path,
            diag::open_url,
            recording::recording_state,
            recording::recording_arm,
            recording::recording_dir_get,
            recording::recording_dir_set,
            recording::recording_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running RadEAU");
}
