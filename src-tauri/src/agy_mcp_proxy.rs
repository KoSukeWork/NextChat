//! Stdio MCP adapter used only by an agy child. The facade and its secret are
//! supplied in the child's environment, never on the command line.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::time::Duration;

pub fn run() -> Result<(), String> {
    let address = std::env::var("NEXTCHAT_MCP_URL").map_err(|_| "Missing MCP endpoint")?;
    let token = std::env::var("NEXTCHAT_MCP_TOKEN").map_err(|_| "Missing MCP token")?;
    let ready = std::env::var_os("NEXTCHAT_MCP_READY").map(std::path::PathBuf::from);
    let stdin = io::stdin();
    let stdout = io::stdout();
    forward(
        stdin.lock(),
        stdout.lock(),
        &address,
        &token,
        ready.as_deref(),
    )
}

fn forward(
    input: impl BufRead,
    mut stdout: impl Write,
    address: &str,
    token: &str,
    ready: Option<&std::path::Path>,
) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&address).map_err(|_| "Invalid MCP endpoint")?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || token.len() < 16
    {
        return Err("Invalid MCP endpoint".into());
    }
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "Cannot create MCP client")?;
    for line in input.lines() {
        let line = line.map_err(|_| "Cannot read MCP request")?;
        if line.len() > 8 * 1024 * 1024 {
            return Err("MCP request too large".into());
        }
        let request: Value = serde_json::from_str(&line).map_err(|_| "Invalid MCP request")?;
        if request["jsonrpc"] != "2.0" || !request["method"].is_string() {
            return Err("Invalid MCP request".into());
        }
        let Some(id) = request.get("id").cloned() else {
            let _ = client
                .post(parsed.clone())
                .bearer_auth(&token)
                .body(line)
                .send();
            continue;
        };
        let mut result = if request["method"] == "server/discover" {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})
        } else {
            match client.post(parsed.clone()).bearer_auth(&token).header("content-type", "application/json").body(line).send().and_then(|r| r.error_for_status()).and_then(|r| r.text()) {
                Ok(text) if text.len() <= 8 * 1024 * 1024 => serde_json::from_str(&text).unwrap_or_else(|_| json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":"Invalid host tool response"}})),
                _ => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":"Host tool endpoint failed"}}),
            }
        };
        if request["method"] == "tools/list" {
            if let Some(tools) = result["result"]["tools"].as_array_mut() {
                for tool in tools {
                    if !tool["_meta"].is_object() {
                        tool["_meta"] = json!({});
                    }
                    tool["_meta"]["antigravity/alwaysLoad"] = Value::Bool(true);
                }
                if let Some(path) = ready {
                    let _ = std::fs::write(path, "ready");
                }
            }
        }
        writeln!(stdout, "{result}").map_err(|_| "Cannot write MCP response")?;
        stdout.flush().map_err(|_| "Cannot write MCP response")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};
    use std::net::TcpListener;
    #[test]
    fn stdio_proxy_forwards_tool_list_and_marks_ready() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/mcp", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 2048];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let size = stream.read(&mut chunk).unwrap();
                assert_ne!(size, 0);
                request.extend_from_slice(&chunk[..size]);
            }
            let headers = String::from_utf8_lossy(&request).to_ascii_lowercase();
            assert!(headers.contains("authorization: bearer test-secret-token"));
            let body = r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"probe","inputSchema":{"type":"object"}}]}}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let temp = tempfile::tempdir().unwrap();
        let ready = temp.path().join("ready");
        let input = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n";
        let mut output = Vec::new();
        forward(
            Cursor::new(input),
            &mut output,
            &address,
            "test-secret-token",
            Some(&ready),
        )
        .unwrap();
        worker.join().unwrap();
        let lines: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines[0]["error"]["code"], -32601);
        assert_eq!(
            lines[1]["result"]["tools"][0]["_meta"]["antigravity/alwaysLoad"],
            true
        );
        assert!(ready.is_file());
    }
}
