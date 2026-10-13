use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::io::{self, BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

const PROTOCOL_VERSION: &str = "2025-06-18";
const SERVER_NAME: &str = "radeau-mcp";
const DEFAULT_PORT: u16 = 5555;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy)]
struct MethodSpec {
    name: &'static str,
    description: &'static str,
    schema: fn() -> Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolCallParams {
    name: String,
    #[serde(default)]
    arguments: Option<Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

/// AU-008: MCP over stdio (initialize, tools/list, tools/call, ping).
pub fn run_stdio() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    run(stdin.lock(), &mut stdout)
}

pub fn run<R, W>(reader: R, writer: &mut W) -> io::Result<()>
where
    R: BufRead,
    W: Write,
{
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_line(&line) {
            serde_json::to_writer(&mut *writer, &response)?;
            writer.write_all(b"\n")?;
            writer.flush()?;
        }
    }
    Ok(())
}

pub fn handle_line(line: &str) -> Option<Value> {
    let value = match serde_json::from_str::<Value>(line) {
        Ok(value) => value,
        Err(error) => {
            return Some(error_response(
                &Value::Null,
                -32700,
                format!("parse error: {error}"),
            ));
        }
    };
    handle_message(&value)
}

pub fn handle_message(value: &Value) -> Option<Value> {
    let id = value.get("id").cloned();
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return Some(error_response(
            &id.unwrap_or(Value::Null),
            -32600,
            "invalid request: missing method",
        ));
    };

    id.as_ref()?;
    let id = id.unwrap_or(Value::Null);
    match method {
        "initialize" => Some(success_response(&id, &initialize_result())),
        "notifications/initialized" => None,
        "ping" => Some(success_response(&id, &json!({}))),
        "tools/list" => Some(success_response(&id, &json!({ "tools": tools() }))),
        "tools/call" => Some(handle_tools_call(
            &id,
            value.get("params").cloned().unwrap_or_else(|| json!({})),
        )),
        _ => Some(error_response(
            &id,
            -32601,
            format!("unknown method: {method}"),
        )),
    }
}

fn handle_tools_call(id: &Value, params: Value) -> Value {
    let params = match serde_json::from_value::<ToolCallParams>(params) {
        Ok(params) => params,
        Err(error) => {
            return error_response(id, -32602, format!("invalid params: {error}"));
        }
    };
    if !METHODS.iter().any(|method| method.name == params.name) {
        return error_response(
            id,
            -32602,
            format!("invalid params: unknown tool '{}'", params.name),
        );
    }
    let port = automation_port();
    let arguments = params.arguments.unwrap_or_else(|| json!({}));
    let result = call_automation(&params.name, &arguments, port);
    success_response(id, &tool_result(result))
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION")
        }
    })
}

fn tools() -> Vec<Value> {
    METHODS
        .iter()
        .map(|method| {
            json!({
                "name": method.name,
                "description": method.description,
                "inputSchema": (method.schema)()
            })
        })
        .collect()
}

/// One automation connection held for the agent's whole session, so the app's
/// Agent chip stays up while an agent is attached (AU-009) and calls skip the
/// connect. A failure on a reused connection (the app restarted, the socket went
/// stale) reconnects once and retries; a failure on a fresh connection does not.
struct Connection {
    stream: TcpStream,
    reader: BufReader<TcpStream>,
    port: u16,
    next_id: u64,
}

static CONNECTION: std::sync::Mutex<Option<Connection>> = std::sync::Mutex::new(None);

fn call_automation(method: &str, params: &Value, port: u16) -> Result<Value, String> {
    let mut slot = CONNECTION
        .lock()
        .map_err(|_| "automation connection poisoned".to_string())?;
    if slot.as_ref().is_some_and(|c| c.port != port) {
        *slot = None;
    }
    let reused = slot.is_some();
    if slot.is_none() {
        *slot = Some(connect(port)?);
    }
    let first = call_on(slot.as_mut().expect("connection set above"), method, params);
    match first {
        Err(CallError::Transport(error)) => {
            *slot = None;
            if !reused {
                return Err(error);
            }
            let mut fresh = connect(port)?;
            let retried = call_on(&mut fresh, method, params);
            if !matches!(retried, Err(CallError::Transport(_))) {
                *slot = Some(fresh);
            }
            retried.map_err(CallError::into_message)
        }
        other => other.map_err(CallError::into_message),
    }
}

enum CallError {
    /// The connection failed; the request may not have been processed.
    Transport(String),
    /// The server answered with a JSON-RPC error.
    Rpc(String),
}

impl CallError {
    fn into_message(self) -> String {
        match self {
            Self::Transport(message) | Self::Rpc(message) => message,
        }
    }
}

fn connect(port: u16) -> Result<Connection, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|error| {
        if matches!(
            error.kind(),
            io::ErrorKind::ConnectionRefused | io::ErrorKind::TimedOut | io::ErrorKind::NotFound
        ) {
            not_running_message(port)
        } else {
            format!("failed to connect to RadEAU automation on port {port}: {error}")
        }
    })?;
    stream
        .set_read_timeout(Some(READ_TIMEOUT))
        .map_err(|error| format!("failed to set automation read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(CONNECT_TIMEOUT))
        .map_err(|error| format!("failed to set automation write timeout: {error}"))?;
    let reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|error| format!("failed to clone automation stream: {error}"))?,
    );
    let mut connection = Connection {
        stream,
        reader,
        port,
        next_id: 1,
    };
    if let Ok(token) = env::var("RADEAU_AUTOMATION_TOKEN") {
        if !token.is_empty() {
            call_on(&mut connection, "authenticate", &json!({ "token": token }))
                .map_err(CallError::into_message)?;
        }
    }
    Ok(connection)
}

fn call_on(connection: &mut Connection, method: &str, params: &Value) -> Result<Value, CallError> {
    let id = connection.next_id;
    connection.next_id += 1;
    let response = send_request(
        &mut connection.stream,
        &mut connection.reader,
        &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    )
    .map_err(CallError::Transport)?;
    if let Some(message) = rpc_error_message(&response) {
        return Err(CallError::Rpc(message));
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| CallError::Rpc("automation response missing result".to_string()))
}

fn send_request(
    stream: &mut TcpStream,
    reader: &mut BufReader<TcpStream>,
    request: &Value,
) -> Result<Value, String> {
    serde_json::to_writer(&mut *stream, &request)
        .map_err(|error| format!("failed to encode automation request: {error}"))?;
    stream
        .write_all(b"\n")
        .map_err(|error| format!("failed to write automation request: {error}"))?;
    stream
        .flush()
        .map_err(|error| format!("failed to flush automation request: {error}"))?;

    let mut line = String::new();
    let bytes = reader
        .read_line(&mut line)
        .map_err(|error| format!("failed to read automation response: {error}"))?;
    if bytes == 0 {
        return Err("automation server closed the connection".to_string());
    }
    serde_json::from_str(&line)
        .map_err(|error| format!("failed to decode automation response: {error}"))
}

fn rpc_error_message(response: &Value) -> Option<String> {
    response
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn tool_result(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({
            "content": [{
                "type": "text",
                "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
            }]
        }),
        Err(message) => json!({
            "content": [{
                "type": "text",
                "text": message
            }],
            "isError": true
        }),
    }
}

fn success_response(id: &Value, result: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn error_response(id: &Value, code: i32, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": JsonRpcError {
            code,
            message: message.into()
        }
    })
}

fn automation_port() -> u16 {
    env::var("RADEAU_AUTOMATION_PORT")
        .ok()
        .and_then(|port| port.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn not_running_message(port: u16) -> String {
    format!("RadEAU is not running — start the app (automation enabled, port {port})")
}

fn empty_object_schema() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false
    })
}

fn capture_start_schema() -> Value {
    json!({
        "type": "object",
        "required": ["source"],
        "properties": {
            "source": source_spec_schema()
        },
        "additionalProperties": false
    })
}

fn source_spec_schema() -> Value {
    json!({
        "oneOf": [
            {
                "type": "object",
                "required": ["kind", "addr"],
                "properties": {
                    "kind": { "const": "sim" },
                    "addr": { "type": "string" }
                },
                "additionalProperties": false
            },
            {
                "type": "object",
                "required": ["kind", "path", "pace"],
                "properties": {
                    "kind": { "const": "pcap" },
                    "path": { "type": "string" },
                    "pace": { "enum": ["realtime", "fast"] }
                },
                "additionalProperties": false
            },
            {
                "type": "object",
                "required": ["kind", "addr"],
                "properties": {
                    "kind": { "const": "pcapStream" },
                    "addr": { "type": "string" }
                },
                "additionalProperties": false
            },
            {
                "type": "object",
                "required": ["kind", "interfaceId"],
                "properties": {
                    "kind": { "const": "live" },
                    "interfaceId": { "type": "string" },
                    "filter": { "type": "string" }
                },
                "additionalProperties": false
            },
            {
                "type": "object",
                "required": ["kind", "profile"],
                "properties": {
                    "kind": { "const": "devgen" },
                    "profile": { "enum": ["idle", "normal", "stress", "burst"] }
                },
                "additionalProperties": false
            }
        ]
    })
}

fn export_jsonl_schema() -> Value {
    json!({
        "type": "object",
        "required": ["path", "from"],
        "properties": {
            "path": { "type": "string" },
            "from": {
                "oneOf": [
                    {
                        "type": "object",
                        "required": ["kind"],
                        "properties": { "kind": { "const": "ring" } },
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "required": ["kind", "path"],
                        "properties": {
                            "kind": { "const": "file" },
                            "path": { "type": "string" }
                        },
                        "additionalProperties": false
                    }
                ]
            }
        },
        "additionalProperties": false
    })
}

fn replay_open_schema() -> Value {
    object_schema(&[(
        "path",
        json!({ "type": "string", "description": "Absolute path of a .pcap or .pcapng file" }),
    )])
}

fn replay_seek_schema() -> Value {
    object_schema(&[(
        "tNs",
        json!({ "type": "integer", "minimum": 0, "description": "Nanoseconds from the file's first frame" }),
    )])
}

fn replay_set_speed_schema() -> Value {
    object_schema(&[(
        "speed",
        json!({
            "type": ["number", "null"],
            "enum": [0.1, 0.25, 0.5, 1, 2, 5, 10, null],
            "description": "Multiple of real time; null = as fast as possible"
        }),
    )])
}

fn trace_query_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "protocols": {
                "type": "array",
                "items": { "type": "string" }
            },
            "nameContains": { "type": "string" },
            "key": { "type": "string" },
            "dir": { "enum": ["rx", "tx", "unknown"] },
            "fromNs": { "type": "integer", "minimum": 0, "description": "Session-relative ns, inclusive" },
            "toNs": { "type": "integer", "minimum": 0, "description": "Session-relative ns, inclusive" },
            "afterIdx": { "type": "integer", "minimum": 0, "description": "Return frames after this idx (the previous page's nextIdx)" },
            "limit": { "type": "integer", "minimum": 1, "maximum": 500 }
        },
        "additionalProperties": false
    })
}

fn trace_frame_schema() -> Value {
    object_schema(&[(
        "idx",
        json!({ "type": "integer", "minimum": 0, "description": "Frame index from trace_query" }),
    )])
}

fn object_schema(required_properties: &[(&str, Value)]) -> Value {
    let properties = required_properties
        .iter()
        .map(|(name, schema)| ((*name).to_string(), schema.clone()))
        .collect::<serde_json::Map<String, Value>>();
    let required = required_properties
        .iter()
        .map(|(name, _)| Value::String((*name).to_string()))
        .collect::<Vec<_>>();
    json!({
        "type": "object",
        "required": required,
        "properties": properties,
        "additionalProperties": false
    })
}

const METHODS: &[MethodSpec] = &[
    MethodSpec {
        name: "capture_list_sources",
        description: "List what RadEAU can capture from: the source kinds this build supports and the live network interfaces (id, name, description, addresses). Call this before capture_start with kind \"live\" to get a valid interfaceId.",
        schema: empty_object_schema,
    },
    MethodSpec {
        name: "capture_start",
        description: "Start a capture session from one source; only one session runs at a time (stop the current one first). Kinds: \"sim\" (the ECU network simulator, addr \"127.0.0.1:5560\"), \"pcap\" (replay a .pcap/.pcapng file; pace \"realtime\" or \"fast\" — prefer replay_open + replay_play for transport control), \"pcapStream\" (pcap records over TCP, addr host:port), \"live\" (a NIC from capture_list_sources, optional BPF filter), \"devgen\" (synthetic traffic, development builds only). Frames then appear in the trace (trace_query) and in the UI.",
        schema: capture_start_schema,
    },
    MethodSpec {
        name: "capture_stop",
        description: "Stop the running capture or replay session. The trace and the frame ring stay inspectable afterwards; an active recording is closed.",
        schema: empty_object_schema,
    },
    MethodSpec {
        name: "capture_status",
        description: "Whether a session is running, its source, session info (epoch, timestamp source) and live counters (received, emitted, drops, malformed, per-class counts, recording counters).",
        schema: empty_object_schema,
    },
    MethodSpec {
        name: "recording_start",
        description: "Start recording frames to a pcapng file in the recordings directory. If a session is running the file opens now; otherwise it opens when the next session starts. Returns the recording state (path, frames, bytes, dropped).",
        schema: empty_object_schema,
    },
    MethodSpec {
        name: "recording_stop",
        description: "Stop recording: closes the current pcapng file (the session keeps running). Returns the recording state.",
        schema: empty_object_schema,
    },
    MethodSpec {
        name: "recording_status",
        description: "The current recording state: armed, active, file path, frames, bytes, dropped frames, rotation size, files written, last error.",
        schema: empty_object_schema,
    },
    MethodSpec {
        name: "recording_list",
        description: "List the recordings in the recordings directory, newest first: path, size in bytes, frame count, start time. Use a path with replay_open or export_jsonl.",
        schema: empty_object_schema,
    },
    MethodSpec {
        name: "export_jsonl",
        description: "Write frames as decoded JSONL (one JSON object per line: idx, tNs, direction, length, protocol, name, type, key, every protocol layer with its fields, payload hex, decoded signals when a catalog is loaded) to `path`, from the in-memory ring ({\"kind\":\"ring\"}) or from a recording file ({\"kind\":\"file\",\"path\":...}). Use it to analyse a whole trace offline with your own tools.",
        schema: export_jsonl_schema,
    },
    MethodSpec {
        name: "replay_open",
        description: "Open a .pcap/.pcapng file for replay: prepares a seek index and returns its metadata (frames, first/last timestamp, duration in ns, interfaces, section comment). It becomes the session source at 1x speed; call replay_play to start.",
        schema: replay_open_schema,
    },
    MethodSpec {
        name: "replay_play",
        description: "Play the opened replay: starts the replay session if none is running, otherwise resumes from a pause. Returns the replay position.",
        schema: empty_object_schema,
    },
    MethodSpec {
        name: "replay_pause",
        description: "Pause the replay; the position holds until replay_play, replay_step or replay_seek. Returns the replay position.",
        schema: empty_object_schema,
    },
    MethodSpec {
        name: "replay_step",
        description: "Advance exactly one frame while paused. Returns the replay position.",
        schema: empty_object_schema,
    },
    MethodSpec {
        name: "replay_seek",
        description: "Jump to a time in the replay: tNs is nanoseconds from the file's first frame (0 = start, replay_open's durationNs = end). The trace is cleared and continues from the first frame at or after the target; play/pause state is kept.",
        schema: replay_seek_schema,
    },
    MethodSpec {
        name: "replay_set_speed",
        description: "Set the replay speed: 0.1, 0.25, 0.5, 1, 2, 5 or 10 times real time, or null for as fast as possible (no frame is ever dropped). Returns the replay position.",
        schema: replay_set_speed_schema,
    },
    MethodSpec {
        name: "replay_status",
        description: "The opened replay's metadata and its current position (state playing/paused/ended, tNs, frame, frames, durationNs, speed).",
        schema: empty_object_schema,
    },
    MethodSpec {
        name: "trace_query",
        description: "Read frames from RadEAU's in-memory frame ring (the most recent ~65k frames of the current or last session) as compact rows {idx, tNs, dir, len, protocol, name, type, key, src, dst}. Filters combine with AND: protocols (e.g. [\"SOME/IP\",\"SD\",\"gPTP\",\"DoIP\",\"ARP\",\"DNS\"], case-insensitive), nameContains (case-insensitive substring of the name column, e.g. a service or signal name), key (exact row key), dir (rx|tx|unknown), fromNs/toNs (session-relative ns), afterIdx (page after this frame idx). Returns at most `limit` rows (default 100, max 500), `total` matching rows, `nextIdx` to pass as afterIdx for the next page, and the ring span. Use trace_frame on an idx for its full dissection.",
        schema: trace_query_schema,
    },
    MethodSpec {
        name: "trace_frame",
        description: "The full dissection of one frame by idx (from trace_query): every protocol layer (Ethernet, VLAN, IP, UDP/TCP, SOME/IP, SD, gPTP, DoIP/UDS, ...) with named fields and byte offsets, the frame bytes as hex, and decoded catalog signals. Fails with \"frame no longer buffered\" when the frame left the ring.",
        schema: trace_frame_schema,
    },
    MethodSpec {
        name: "trace_stats",
        description: "An overview of the trace: session state and source, live counters, the ring's span (first/last idx and time) and frame counts per protocol. A good first call to see what is on the bus before querying.",
        schema: empty_object_schema,
    },
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Read};
    use std::net::TcpListener;
    use std::sync::{Mutex, OnceLock};
    use std::thread;

    const SRS_AUTOMATION_METHODS: &[&str] = &[
        "capture_list_sources",
        "capture_start",
        "capture_stop",
        "capture_status",
        "recording_start",
        "recording_stop",
        "recording_status",
        "recording_list",
        "export_jsonl",
        "replay_open",
        "replay_play",
        "replay_pause",
        "replay_step",
        "replay_seek",
        "replay_set_speed",
        "replay_status",
        "trace_query",
        "trace_frame",
        "trace_stats",
    ];

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn fake_server(response: Value) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake automation server");
        let port = listener.local_addr().expect("local addr").port();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept automation client");
            let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
            let mut line = String::new();
            reader.read_line(&mut line).expect("read request");
            let request: Value = serde_json::from_str(&line).expect("request json");
            let id = request.get("id").cloned().unwrap_or(Value::Null);
            let mut response = response;
            response["id"] = id;
            serde_json::to_writer(&mut stream, &response).expect("write response");
            stream.write_all(b"\n").expect("write newline");
        });
        port
    }

    #[test]
    fn au_008_initialize_returns_mcp_capabilities() {
        let response = handle_line(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#)
            .expect("initialize response");
        assert_eq!(response["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(response["result"]["capabilities"], json!({ "tools": {} }));
        assert_eq!(response["result"]["serverInfo"]["name"], SERVER_NAME);
    }

    #[test]
    fn au_008_tools_list_contains_every_automation_method() {
        let response = handle_line(r#"{"jsonrpc":"2.0","id":"tools","method":"tools/list"}"#)
            .expect("tools response");
        let tools = response["result"]["tools"].as_array().expect("tools array");
        let tool_names = tools
            .iter()
            .map(|tool| tool["name"].as_str().expect("tool name"))
            .collect::<Vec<_>>();
        assert_eq!(tool_names, SRS_AUTOMATION_METHODS);
        for tool in tools {
            let description = tool["description"].as_str().expect("tool description");
            assert!(
                description.len() >= 60 && !description.contains("AU-"),
                "{} needs a substantive agent-facing description (no requirement IDs)",
                tool["name"]
            );
            assert_eq!(
                tool["inputSchema"]["type"], "object",
                "{} is missing an object inputSchema",
                tool["name"]
            );
        }
    }

    #[test]
    fn au_008_method_table_stays_in_sync_with_srs_catalog() {
        let method_names = METHODS.iter().map(|method| method.name).collect::<Vec<_>>();
        assert_eq!(method_names, SRS_AUTOMATION_METHODS);
    }

    #[test]
    fn au_008_tools_call_returns_pretty_json_text_content() {
        let _guard = env_lock().lock().expect("env lock");
        env::remove_var("RADEAU_AUTOMATION_TOKEN");
        let port = fake_server(json!({
            "jsonrpc": "2.0",
            "result": { "running": false, "stats": { "frames": 0 } }
        }));
        env::set_var("RADEAU_AUTOMATION_PORT", port.to_string());
        let response = handle_line(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"capture_status","arguments":{}}}"#,
        )
        .expect("tools/call response");
        assert!(response["result"]["isError"].is_null());
        assert_eq!(response["result"]["content"][0]["type"], "text");
        assert!(response["result"]["content"][0]["text"]
            .as_str()
            .expect("text")
            .contains("\"running\": false"));
        env::remove_var("RADEAU_AUTOMATION_PORT");
    }

    #[test]
    fn au_008_tools_call_maps_domain_error_to_tool_error() {
        let _guard = env_lock().lock().expect("env lock");
        env::remove_var("RADEAU_AUTOMATION_TOKEN");
        let port = fake_server(json!({
            "jsonrpc": "2.0",
            "error": { "code": -32000, "message": "frame no longer buffered" }
        }));
        env::set_var("RADEAU_AUTOMATION_PORT", port.to_string());
        let response = handle_line(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"trace_frame","arguments":{"idx":42}}}"#,
        )
        .expect("tools/call response");
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(
            response["result"]["content"][0]["text"],
            "frame no longer buffered"
        );
        env::remove_var("RADEAU_AUTOMATION_PORT");
    }

    #[test]
    fn au_008_tools_call_reports_not_running_when_connection_refused() {
        let _guard = env_lock().lock().expect("env lock");
        env::remove_var("RADEAU_AUTOMATION_TOKEN");
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve port");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        env::set_var("RADEAU_AUTOMATION_PORT", port.to_string());
        let response = handle_line(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"capture_status","arguments":{}}}"#,
        )
        .expect("tools/call response");
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(
            response["result"]["content"][0]["text"],
            not_running_message(port)
        );
        env::remove_var("RADEAU_AUTOMATION_PORT");
    }

    #[test]
    fn au_008_run_ignores_initialized_notification() {
        let input = br#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":1,"method":"ping"}
"#;
        let mut output = Vec::new();
        run(&input[..], &mut output).expect("run stdio");
        let mut text = String::new();
        output.as_slice().read_to_string(&mut text).expect("utf8");
        let lines = text.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains(r#""result":{}"#));
    }
}
