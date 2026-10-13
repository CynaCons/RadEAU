//! Automation JSON-RPC server (AU-001..004, AU-009).

mod methods;
mod server;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const EVENT_AUTOMATION_CLIENTS: &str = "automation:clients";
const EVENT_CAPTURE_STATE: &str = "capture:state";
const EVENT_REPLAY_OPENED: &str = "replay:opened";

#[derive(Debug, Clone)]
pub struct AutomationConfig {
    pub bind: IpAddr,
    pub port: u16,
    pub token: Option<String>,
    pub allowlist: Vec<IpAddr>,
}

impl Default for AutomationConfig {
    fn default() -> Self {
        let port = std::env::var("RADEAU_AUTOMATION_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(5555);
        let token = std::env::var("RADEAU_AUTOMATION_TOKEN")
            .ok()
            .filter(|value| !value.is_empty());
        Self {
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port,
            token,
            allowlist: Vec::new(),
        }
    }
}

#[derive(Default)]
pub struct AutomationState {
    clients: AtomicUsize,
    last_method: Mutex<Option<String>>,
    last_emit: Mutex<Option<Instant>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationClientsEvent {
    count: usize,
    last_method: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureStateEvent {
    running: bool,
    source: Option<crate::capture::SourceSpec>,
}

pub fn start(app: AppHandle) {
    let config = AutomationConfig::default();
    let effective = match validate_bind(&config) {
        Ok(()) => config,
        Err(error) => {
            crate::log::log(
                crate::log::Level::Error,
                "automation",
                "automation bind refused",
                serde_json::json!({ "error": error, "requestedBind": config.bind.to_string() }),
            );
            AutomationConfig {
                bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
                ..config
            }
        }
    };
    server::start(app, effective);
}

pub(crate) fn validate_bind(config: &AutomationConfig) -> Result<(), String> {
    if config.bind.is_loopback() {
        return Ok(());
    }
    if config.token.as_ref().is_none_or(|token| token.len() < 32) {
        return Err(
            "non-loopback automation bind requires a token of at least 32 characters".into(),
        );
    }
    if config.allowlist.is_empty() {
        return Err("non-loopback automation bind requires a non-empty client allowlist".into());
    }
    Ok(())
}

pub(crate) fn client_connected(app: &AppHandle) {
    let state = app.state::<AutomationState>();
    state.clients.fetch_add(1, Ordering::AcqRel);
    emit_clients(app, None, true);
}

pub(crate) fn client_disconnected(app: &AppHandle) {
    let state = app.state::<AutomationState>();
    state.clients.fetch_sub(1, Ordering::AcqRel);
    emit_clients(app, None, true);
}

pub(crate) fn record_call(
    app: &AppHandle,
    method: &str,
    client: SocketAddr,
    ok: bool,
    elapsed: Duration,
) {
    crate::log::log(
        if ok {
            crate::log::Level::Info
        } else {
            crate::log::Level::Error
        },
        "automation",
        "rpc call",
        serde_json::json!({
            "method": method,
            "client": client.to_string(),
            "ok": ok,
            "ms": elapsed.as_millis(),
        }),
    );
    emit_clients(app, Some(method), false);
}

pub(crate) fn emit_capture_state(
    app: &AppHandle,
    running: bool,
    source: Option<crate::capture::SourceSpec>,
) {
    let _ = app.emit(EVENT_CAPTURE_STATE, CaptureStateEvent { running, source });
}

pub(crate) fn emit_replay_opened(app: &AppHandle, info: &crate::replay::ReplayInfo) {
    let _ = app.emit(EVENT_REPLAY_OPENED, info);
}

fn emit_clients(app: &AppHandle, method: Option<&str>, force: bool) {
    let state = app.state::<AutomationState>();
    if let Some(method) = method {
        if let Ok(mut last) = state.last_method.lock() {
            *last = Some(method.to_string());
        }
    }
    if !force {
        let due = state
            .last_emit
            .lock()
            .map(|last| last.is_none_or(|instant| instant.elapsed() >= Duration::from_millis(250)))
            .unwrap_or(true);
        if !due {
            return;
        }
    }
    let count = state.clients.load(Ordering::Acquire);
    let last_method = state.last_method.lock().ok().and_then(|last| last.clone());
    let _ = app.emit(
        EVENT_AUTOMATION_CLIENTS,
        AutomationClientsEvent { count, last_method },
    );
    if let Ok(mut last_emit) = state.last_emit.lock() {
        *last_emit = Some(Instant::now());
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn au_002_non_loopback_bind_requires_token_and_allowlist() {
        let mut config = AutomationConfig {
            bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            port: 5555,
            token: None,
            allowlist: Vec::new(),
        };
        assert!(validate_bind(&config).unwrap_err().contains("token"));
        config.token = Some("x".repeat(32));
        assert!(validate_bind(&config).unwrap_err().contains("allowlist"));
        config.allowlist.push(IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert!(validate_bind(&config).is_ok());
    }
}
