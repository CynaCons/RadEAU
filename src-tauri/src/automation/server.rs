//! TCP JSON-RPC 2.0 transport for AU-001/AU-002/AU-009.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use super::{methods, AutomationConfig};

const MAX_CLIENTS: usize = 4;
const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
struct RpcRequest {
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: Option<String>,
    params: Option<Value>,
}

trait RpcHandler: Send + Sync {
    fn client_connected(&self);
    fn client_disconnected(&self);
    fn record_call(&self, method: &str, client: SocketAddr, ok: bool, elapsed: Duration);
    fn dispatch(&self, method: &str, params: Option<Value>) -> Result<Value, (i64, String)>;
}

struct AppRpcHandler {
    app: AppHandle,
}

impl RpcHandler for AppRpcHandler {
    fn client_connected(&self) {
        super::client_connected(&self.app);
    }

    fn client_disconnected(&self) {
        super::client_disconnected(&self.app);
    }

    fn record_call(&self, method: &str, client: SocketAddr, ok: bool, elapsed: Duration) {
        super::record_call(&self.app, method, client, ok, elapsed);
    }

    fn dispatch(&self, method: &str, params: Option<Value>) -> Result<Value, (i64, String)> {
        methods::dispatch(&self.app, method, params)
    }
}

pub fn start(app: AppHandle, config: AutomationConfig) {
    let addr = SocketAddr::new(config.bind, config.port);
    let listener = match TcpListener::bind(addr) {
        Ok(listener) => listener,
        Err(error) => {
            crate::log::log(
                crate::log::Level::Error,
                "automation",
                "automation listen failed",
                json!({ "addr": addr.to_string(), "error": error.to_string() }),
            );
            return;
        }
    };
    let handler = Arc::new(AppRpcHandler { app });
    start_listener(listener, handler, config);
}

fn start_listener(listener: TcpListener, handler: Arc<dyn RpcHandler>, config: AutomationConfig) {
    let clients = Arc::new(AtomicUsize::new(0));
    let _ = std::thread::Builder::new()
        .name("automation-listener".into())
        .spawn(move || accept_loop(listener, handler, clients, config));
}

fn accept_loop(
    listener: TcpListener,
    handler: Arc<dyn RpcHandler>,
    clients: Arc<AtomicUsize>,
    config: AutomationConfig,
) {
    for accepted in listener.incoming() {
        let Ok(mut stream) = accepted else {
            continue;
        };
        let peer = stream
            .peer_addr()
            .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 0)));
        if clients.load(Ordering::Acquire) >= MAX_CLIENTS {
            let _ = write_error(&mut stream, Value::Null, -32001, "too many clients");
            continue;
        }
        clients.fetch_add(1, Ordering::AcqRel);
        let thread_handler = Arc::clone(&handler);
        let thread_clients = Arc::clone(&clients);
        let thread_config = config.clone();
        let _ = std::thread::Builder::new()
            .name("automation-client".into())
            .spawn(move || {
                thread_handler.client_connected();
                serve_client(stream, peer, thread_handler.as_ref(), &thread_config);
                thread_handler.client_disconnected();
                thread_clients.fetch_sub(1, Ordering::AcqRel);
            });
    }
}

fn serve_client(
    stream: TcpStream,
    peer: SocketAddr,
    handler: &dyn RpcHandler,
    config: &AutomationConfig,
) {
    let mut writer = match stream.try_clone() {
        Ok(writer) => writer,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);
    let mut authenticated = config.token.is_none();
    let mut auth_failures = 0_u8;
    loop {
        let mut raw = Vec::new();
        match read_capped_line(&mut reader, &mut raw) {
            Ok(0) => return,
            Ok(_) => {}
            Err(message) => {
                let _ = write_error(&mut writer, Value::Null, -32600, &message);
                return;
            }
        }
        let request: RpcRequest = match serde_json::from_slice(&raw) {
            Ok(request) => request,
            Err(error) => {
                let _ = write_error(&mut writer, Value::Null, -32700, &error.to_string());
                continue;
            }
        };
        let Some(id) = request.id else {
            continue;
        };
        let Some(method) = request.method else {
            let _ = write_error(&mut writer, id, -32600, "method is required");
            continue;
        };
        if request.jsonrpc.as_deref() != Some("2.0") {
            let _ = write_error(&mut writer, id, -32600, "jsonrpc must be 2.0");
            continue;
        }
        if method == "authenticate" {
            let started = Instant::now();
            let ok = request
                .params
                .as_ref()
                .and_then(|params| params.get("token"))
                .and_then(Value::as_str)
                == config.token.as_deref();
            if ok {
                authenticated = true;
                let _ = write_result(&mut writer, id, json!({ "authenticated": true }));
            } else {
                auth_failures = auth_failures.saturating_add(1);
                let _ = write_error(&mut writer, id, -32002, "unauthenticated");
                handler.record_call("authenticate", peer, false, started.elapsed());
                if auth_failures >= 3 {
                    return;
                }
                continue;
            }
            handler.record_call("authenticate", peer, true, started.elapsed());
            continue;
        }
        if !authenticated {
            let _ = write_error(&mut writer, id, -32002, "unauthenticated");
            handler.record_call(&method, peer, false, Duration::ZERO);
            continue;
        }
        let started = Instant::now();
        let response = handler.dispatch(&method, request.params);
        let ok = response.is_ok();
        handler.record_call(&method, peer, ok, started.elapsed());
        match response {
            Ok(result) => {
                let _ = write_result(&mut writer, id, result);
            }
            Err((code, message)) => {
                let _ = write_error(&mut writer, id, code, &message);
            }
        }
    }
}

fn read_capped_line(reader: &mut BufReader<TcpStream>, out: &mut Vec<u8>) -> Result<usize, String> {
    let mut total = 0;
    loop {
        let mut part = Vec::new();
        let count = reader
            .read_until(b'\n', &mut part)
            .map_err(|error| format!("read request: {error}"))?;
        if count == 0 {
            return Ok(total);
        }
        total += count;
        if total > MAX_LINE_BYTES {
            return Err("request line exceeds 1 MiB".into());
        }
        let done = part.ends_with(b"\n");
        out.extend(part);
        if done {
            return Ok(total);
        }
    }
}

fn write_result(stream: &mut TcpStream, id: Value, result: Value) -> std::io::Result<()> {
    writeln!(
        stream,
        "{}",
        json!({ "jsonrpc": "2.0", "id": id, "result": result })
    )
}

fn write_error(stream: &mut TcpStream, id: Value, code: i64, message: &str) -> std::io::Result<()> {
    writeln!(
        stream,
        "{}",
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
    )
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::net::{IpAddr, Ipv4Addr, TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::{json, Value};

    use super::*;
    use crate::codes::{DIR_RX, PROTO_SOMEIP, SOMEIP_TY_REQUEST};
    use crate::frame::{GenFrame, SNAP_LEN};

    #[derive(Default)]
    struct TestHandler {
        capture: crate::capture::CaptureState,
        connected: AtomicUsize,
        calls: Mutex<Vec<(String, bool)>>,
    }

    impl TestHandler {
        fn with_frame() -> Self {
            let handler = Self::default();
            handler.capture.retain_frame_for_test(
                GenFrame {
                    idx: 7,
                    t_s: 0.001,
                    dir: DIR_RX,
                    src_ep: 0,
                    proto: PROTO_SOMEIP,
                    svc: 0x1234,
                    method: 0x5678,
                    msg_type: SOMEIP_TY_REQUEST,
                    session: -1,
                    wire_len: 64,
                    snap: [0; SNAP_LEN],
                    src_ip: u32::from_be_bytes([10, 0, 0, 1]),
                    dst_ip: u32::from_be_bytes([10, 0, 0, 2]),
                    src_mac: 1,
                    vlan: -1,
                    payload_off: 42,
                },
                vec![0; 64],
            );
            handler
        }
    }

    impl RpcHandler for TestHandler {
        fn client_connected(&self) {
            self.connected.fetch_add(1, Ordering::AcqRel);
        }

        fn client_disconnected(&self) {
            self.connected.fetch_sub(1, Ordering::AcqRel);
        }

        fn record_call(&self, method: &str, _client: SocketAddr, ok: bool, _elapsed: Duration) {
            self.calls.lock().unwrap().push((method.to_string(), ok));
        }

        fn dispatch(&self, method: &str, params: Option<Value>) -> Result<Value, (i64, String)> {
            match method {
                "capture_status" => serde_json::to_value(self.capture.automation_status())
                    .map_err(|e| (-32000, e.to_string())),
                "trace_query" => {
                    let query: crate::rows::TraceQuery =
                        serde_json::from_value(params.unwrap_or_else(|| json!({})))
                            .map_err(|e| (-32602, e.to_string()))?;
                    if query.limit.is_some_and(|limit| !(1..=500).contains(&limit)) {
                        return Err((-32602, "limit must be 1..=500".into()));
                    }
                    serde_json::to_value(crate::rows::trace_query(&self.capture, &query).map_err(
                        |e| {
                            if e.contains("limit") || e.contains("dir") {
                                (-32602, e)
                            } else {
                                (-32000, e)
                            }
                        },
                    )?)
                    .map_err(|e| (-32000, e.to_string()))
                }
                _ => Err((-32601, "unknown method".into())),
            }
        }
    }

    fn spawn(handler: Arc<TestHandler>) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        start_listener(
            listener,
            handler,
            AutomationConfig {
                bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
                port: addr.port(),
                token: None,
                allowlist: Vec::new(),
            },
        );
        addr
    }

    fn request(addr: SocketAddr, method: &str, params: Option<Value>) -> Value {
        let mut stream = TcpStream::connect(addr).unwrap();
        let line = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params.unwrap_or_else(|| json!({})),
        });
        writeln!(stream, "{line}").unwrap();
        let mut response = String::new();
        BufReader::new(stream).read_line(&mut response).unwrap();
        serde_json::from_str(&response).unwrap()
    }

    // AU-002: with a token configured, calls before `authenticate` are refused
    // and three wrong tokens close the connection.
    #[test]
    fn au_002_token_is_required_and_three_failures_disconnect() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        start_listener(
            listener,
            Arc::new(TestHandler::default()),
            AutomationConfig {
                bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
                port: addr.port(),
                token: Some("t".repeat(32)),
                allowlist: Vec::new(),
            },
        );
        let mut stream = TcpStream::connect(addr).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut send = |method: &str, params: Value| -> Option<Value> {
            writeln!(
                stream,
                "{}",
                json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
            )
            .ok()?;
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => None,
                Ok(_) => serde_json::from_str(&line).ok(),
            }
        };
        let refused = send("capture_status", json!({})).unwrap();
        assert_eq!(refused["error"]["code"], -32002);
        for _ in 0..3 {
            let wrong = send("authenticate", json!({"token": "nope"})).unwrap();
            assert_eq!(wrong["error"]["code"], -32002);
        }
        assert!(
            send("capture_status", json!({})).is_none(),
            "connection closed after 3 failures"
        );
    }

    #[test]
    fn au_001_tcp_client_calls_capture_status_and_logs_call() {
        let handler = Arc::new(TestHandler::default());
        let addr = spawn(Arc::clone(&handler));
        let response = request(addr, "capture_status", None);
        assert_eq!(response["result"]["running"], false);
        assert_eq!(
            handler.calls.lock().unwrap().as_slice(),
            &[("capture_status".into(), true)]
        );
    }

    #[test]
    fn au_001_unknown_method_returns_json_rpc_error() {
        let response = request(
            spawn(Arc::new(TestHandler::default())),
            "missing_method",
            None,
        );
        assert_eq!(response["error"]["code"], -32601);
    }

    #[test]
    fn au_001_invalid_params_return_json_rpc_error() {
        let response = request(
            spawn(Arc::new(TestHandler::default())),
            "trace_query",
            Some(json!({ "unknownField": true })),
        );
        assert_eq!(response["error"]["code"], -32602);
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unknownField"));
    }

    #[test]
    fn au_001_fifth_client_gets_too_many_clients_error() {
        let addr = spawn(Arc::new(TestHandler::default()));
        let _held = (0..MAX_CLIENTS)
            .map(|_| TcpStream::connect(addr).unwrap())
            .collect::<Vec<_>>();
        let mut fifth = TcpStream::connect(addr).unwrap();
        let mut response = String::new();
        BufReader::new(&mut fifth).read_line(&mut response).unwrap();
        let response: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["error"]["code"], -32001);
    }

    #[test]
    fn au_001_oversize_line_is_rejected() {
        let addr = spawn(Arc::new(TestHandler::default()));
        let mut stream = TcpStream::connect(addr).unwrap();
        stream.write_all(&vec![b' '; MAX_LINE_BYTES + 1]).unwrap();
        stream.write_all(b"\n").unwrap();
        let mut response = String::new();
        BufReader::new(stream).read_line(&mut response).unwrap();
        let response: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["error"]["code"], -32600);
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("1 MiB"));
    }

    #[test]
    fn au_005_trace_query_dispatches_to_rows() {
        let response = request(
            spawn(Arc::new(TestHandler::with_frame())),
            "trace_query",
            Some(json!({ "protocols": ["some/ip"], "limit": 1 })),
        );
        assert_eq!(response["result"]["total"], 1);
        assert_eq!(response["result"]["rows"][0]["idx"], 7);
        assert_eq!(response["result"]["rows"][0]["protocol"], "SOME/IP");
    }
}
