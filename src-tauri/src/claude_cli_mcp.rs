//! Short-lived, loopback-only MCP endpoint for one CLI request.
use crate::claude_cli::random_uuid;
use hyper::{
    body::HttpBody,
    service::{make_service_fn, service_fn},
    Body, Request, Response, Server, StatusCode,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

type Emit = Arc<dyn Fn(Value) -> Result<(), String> + Send + Sync>;
type ResultSender = oneshot::Sender<(String, bool)>;
type PendingMap = HashMap<(String, String), ResultSender>;

#[derive(Default)]
pub struct HostTools {
    pending: Mutex<PendingMap>,
}
impl HostTools {
    pub fn complete(
        &self,
        run_id: &str,
        call_id: &str,
        content: String,
        is_error: bool,
    ) -> Result<(), String> {
        if content.len() > 8 * 1024 * 1024 {
            return Err("Host tool result is too large".into());
        }
        let sender = self
            .pending
            .lock()
            .map_err(|_| "Host tool state unavailable")?
            .remove(&(run_id.into(), call_id.into()))
            .ok_or("Host tool call is no longer active")?;
        sender
            .send((content, is_error))
            .map_err(|_| "Host tool call is no longer active".into())
    }
    fn remove_run(&self, run_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|(id, _), _| id != run_id);
        }
    }
}

struct Run {
    id: String,
    secret: String,
    tools: Vec<Value>,
    names: HashSet<String>,
    cancel: CancellationToken,
    host: Arc<HostTools>,
    emit: Emit,
}

fn same_secret(actual: &str, expected: &str) -> bool {
    let a = actual.as_bytes();
    let b = expected.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b)
        .fold(0u8, |diff, (left, right)| diff | (left ^ right))
        == 0
}
fn reply(status: StatusCode, value: Option<Value>) -> Response<Body> {
    let mut response = Response::new(
        value
            .map(|body| Body::from(body.to_string()))
            .unwrap_or_else(Body::empty),
    );
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}
fn rpc_error(id: Value, code: i32, message: &str) -> Response<Body> {
    reply(
        StatusCode::OK,
        Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})),
    )
}

async fn handle(mut request: Request<Body>, run: Arc<Run>) -> Result<Response<Body>, Infallible> {
    if request.method() != hyper::Method::POST || request.uri().path() != "/mcp" {
        return Ok(reply(StatusCode::NOT_FOUND, None));
    }
    let auth = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !same_secret(auth, &format!("Bearer {}", run.secret)) {
        return Ok(reply(StatusCode::UNAUTHORIZED, None));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = request.body_mut().data().await {
        let Ok(chunk) = chunk else {
            return Ok(reply(StatusCode::BAD_REQUEST, None));
        };
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Ok(reply(StatusCode::PAYLOAD_TOO_LARGE, None));
        }
        bytes.extend_from_slice(&chunk);
    }
    let Ok(rpc) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(reply(StatusCode::BAD_REQUEST, None));
    };
    if rpc["jsonrpc"] != "2.0" || !rpc["method"].is_string() {
        return Ok(reply(StatusCode::BAD_REQUEST, None));
    }
    if rpc.get("id").is_none() {
        return Ok(reply(StatusCode::ACCEPTED, None));
    }
    let id = rpc["id"].clone();
    let result = match rpc["method"].as_str().unwrap_or("") {
        "initialize" => {
            json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"nextchat-tools","version":"1.0.0"}})
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools":run.tools}),
        "tools/call" => {
            let name = rpc["params"]["name"].as_str().unwrap_or("");
            if !run.names.contains(name) || run.cancel.is_cancelled() {
                return Ok(rpc_error(
                    id,
                    -32602,
                    "Tool is not enabled for this request",
                ));
            }
            let Ok(call_id) = random_uuid() else {
                return Ok(rpc_error(id, -32603, "Cannot create tool call"));
            };
            let (sender, receiver) = oneshot::channel();
            let key = (run.id.clone(), call_id.clone());
            if let Ok(mut pending) = run.host.pending.lock() {
                pending.insert(key.clone(), sender);
            } else {
                return Ok(rpc_error(id, -32603, "Host tool state unavailable"));
            }
            if (run.emit)(json!({"type":"host_tool_call","runId":run.id,"id":call_id,"name":name,"input":rpc["params"].get("arguments").cloned().unwrap_or_else(|| json!({}))})).is_err() {
                if let Ok(mut pending) = run.host.pending.lock() { pending.remove(&key); }
                return Ok(rpc_error(id, -32603, "Host tool executor unavailable"));
            }
            let completed = tokio::select! { _ = run.cancel.cancelled() => None, value = receiver => value.ok() };
            if let Ok(mut pending) = run.host.pending.lock() {
                pending.remove(&key);
            }
            match completed {
                Some((content, is_error)) => {
                    json!({"content":[{"type":"text","text":content}],"isError":is_error})
                }
                None => return Ok(rpc_error(id, -32602, "Host tool request cancelled")),
            }
        }
        _ => return Ok(rpc_error(id, -32601, "Method not found")),
    };
    Ok(reply(
        StatusCode::OK,
        Some(json!({"jsonrpc":"2.0","id":id,"result":result})),
    ))
}

pub struct HostMcp {
    pub config: Value,
    run: Arc<Run>,
    shutdown: CancellationToken,
}

impl HostMcp {
    pub fn start(
        tools: Vec<Value>,
        host: Arc<HostTools>,
        cancel: CancellationToken,
        emit: Emit,
    ) -> Result<Self, String> {
        if tools.len() > 1000 {
            return Err("Invalid host tools".into());
        }
        let mut names = HashSet::new();
        for tool in &tools {
            let name = tool["name"]
                .as_str()
                .ok_or("Invalid host tool definition")?;
            if name.is_empty()
                || name.len() > 64
                || !name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                || !tool["inputSchema"].is_object()
                || !names.insert(name.to_owned())
            {
                return Err("Invalid host tool definition".into());
            }
        }
        let mut random = [0u8; 32];
        getrandom::getrandom(&mut random).map_err(|_| "Cannot create host tool secret")?;
        let secret: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| "Cannot start host tool endpoint")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Cannot start host tool endpoint")?;
        let port = listener
            .local_addr()
            .map_err(|_| "Cannot inspect host tool endpoint")?
            .port();
        let run = Arc::new(Run {
            id: random_uuid()?,
            secret: secret.clone(),
            tools,
            names,
            cancel,
            host,
            emit,
        });
        let shutdown = CancellationToken::new();
        let handler = run.clone();
        let stop = shutdown.clone();
        let server = Server::from_tcp(listener)
            .map_err(|_| "Cannot start host tool endpoint")?
            .serve(make_service_fn(move |_| {
                let run = handler.clone();
                async move {
                    Ok::<_, Infallible>(service_fn(move |request| handle(request, run.clone())))
                }
            }));
        tauri::async_runtime::spawn(async move {
            let _ = server.with_graceful_shutdown(stop.cancelled()).await;
        });
        Ok(Self {
            config: json!({"type":"http","url":format!("http://127.0.0.1:{port}/mcp"),"headers":{"Authorization":format!("Bearer {secret}")}}),
            run,
            shutdown,
        })
    }
}
impl Drop for HostMcp {
    fn drop(&mut self) {
        self.shutdown.cancel();
        self.run.cancel.cancel();
        self.run.host.remove_run(&self.run.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn per_request_secret_limits_tools_and_errors_use_json_rpc() {
        let host = Arc::new(HostTools::default());
        let cancel = CancellationToken::new();
        let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
        let facade = HostMcp::start(
            vec![json!({"name":"enabled","inputSchema":{"type":"object"}})],
            host.clone(),
            cancel.clone(),
            Arc::new(move |event| {
                events
                    .send(event)
                    .map_err(|_| "event receiver closed".into())
            }),
        )
        .unwrap();
        let url = facade.config["url"].as_str().unwrap();
        let token = facade.config["headers"]["Authorization"].as_str().unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let rpc = |name: &str| json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":{"x":1}}});
        assert_eq!(
            client
                .post(url)
                .json(&rpc("enabled"))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        let denied = client
            .post(url)
            .header("authorization", token)
            .json(&rpc("disabled"))
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), 200);
        assert!(denied.json::<Value>().await.unwrap()["error"].is_object());
        let request = client
            .post(url)
            .header("authorization", token)
            .json(&rpc("enabled"))
            .send();
        let call = tokio::spawn(request);
        let event = received.recv().await.unwrap();
        assert_eq!(event["name"], "enabled");
        host.complete(
            event["runId"].as_str().unwrap(),
            event["id"].as_str().unwrap(),
            "result".into(),
            false,
        )
        .unwrap();
        let response = call.await.unwrap().unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.json::<Value>().await.unwrap()["result"]["content"][0]["text"],
            "result"
        );
        let request = client
            .post(url)
            .header("authorization", token)
            .json(&rpc("enabled"))
            .send();
        let call = tokio::spawn(request);
        received.recv().await.unwrap();
        cancel.cancel();
        let response = call.await.unwrap().unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.json::<Value>().await.unwrap()["error"].is_object());
    }
}
