use serde_json::{json, Value};
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::thread;

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
fn au_008_binary_answers_stdio_and_forwards_tool_call() {
    let port = fake_server(json!({
        "jsonrpc": "2.0",
        "result": { "running": false }
    }));
    let mut child = Command::new(env!("CARGO_BIN_EXE_radeau-mcp"))
        .env("RADEAU_AUTOMATION_PORT", port.to_string())
        .env_remove("RADEAU_AUTOMATION_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn radeau-mcp");
    {
        let stdin = child.stdin.as_mut().expect("stdin");
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{}}}}"#
        )
        .expect("write initialize");
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{{"name":"capture_status","arguments":{{}}}}}}"#
        )
        .expect("write tools/call");
    }
    drop(child.stdin.take());

    let stdout = child.stdout.take().expect("stdout");
    let lines = BufReader::new(stdout)
        .lines()
        .collect::<Result<Vec<_>, _>>()
        .expect("read stdout");
    let status = child.wait().expect("wait radeau-mcp");
    assert!(status.success());
    assert_eq!(lines.len(), 2);

    let initialize: Value = serde_json::from_str(&lines[0]).expect("initialize response");
    assert_eq!(initialize["result"]["protocolVersion"], json!("2025-06-18"));

    let call: Value = serde_json::from_str(&lines[1]).expect("tool response");
    assert_eq!(call["result"]["content"][0]["type"], "text");
    assert!(call["result"]["content"][0]["text"]
        .as_str()
        .expect("text")
        .contains("\"running\": false"));
}
