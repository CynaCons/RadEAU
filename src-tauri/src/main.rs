// RadEAU native core — Tauri 2 shell.
// The core owns capture links, files, and network surfaces; the WebView owns
// all visualization. IPC is exactly commands (request/response) and events
// (push) — see PRD.md §3.1.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Touch the shared protocol crate so the workspace dependency graph is
    // exercised from the first build.
    let _ = radeau_proto::CRATE_NAME;

    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running RadEAU");
}
