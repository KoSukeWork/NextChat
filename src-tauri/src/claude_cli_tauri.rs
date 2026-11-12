use crate::claude_cli::{CliInput, CliRuntime, CliSettings};
use crate::claude_cli_mcp::{HostMcp, HostTools};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

struct RequestSlot {
    token: CancellationToken,
    created: Instant,
    started: bool,
}
pub struct CliApp {
    runtime: Arc<CliRuntime>,
    tools: Arc<HostTools>,
    requests: Mutex<HashMap<String, RequestSlot>>,
}
impl CliApp {
    pub fn new(directory: PathBuf) -> Result<Self, String> {
        Ok(Self {
            runtime: CliRuntime::new(directory)?,
            tools: Arc::new(HostTools::default()),
            requests: Mutex::new(HashMap::new()),
        })
    }
    fn reserve(&self, id: &str) -> Result<CancellationToken, String> {
        if id.is_empty()
            || id.len() > 120
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err("Invalid CLI request identity".into());
        }
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| "CLI request state unavailable")?;
        requests.retain(|_, slot| {
            slot.started
                || !slot.token.is_cancelled()
                || slot.created.elapsed() < Duration::from_secs(120)
        });
        if let Some(slot) = requests.get(id) {
            return Err(if slot.token.is_cancelled() {
                "Claude Code request cancelled"
            } else {
                "Duplicate CLI request identity"
            }
            .into());
        }
        let token = CancellationToken::new();
        requests.insert(
            id.into(),
            RequestSlot {
                token: token.clone(),
                created: Instant::now(),
                started: true,
            },
        );
        Ok(token)
    }
    fn cancel(&self, id: &str) {
        if id.is_empty() || id.len() > 120 {
            return;
        }
        if let Ok(mut requests) = self.requests.lock() {
            requests
                .entry(id.into())
                .or_insert_with(|| RequestSlot {
                    token: CancellationToken::new(),
                    created: Instant::now(),
                    started: false,
                })
                .token
                .cancel();
        }
    }
    fn finish(&self, id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(id);
        }
    }
    pub fn shutdown(&self) {
        if let Ok(requests) = self.requests.lock() {
            for slot in requests.values() {
                slot.token.cancel();
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventPayload {
    request_id: String,
    event: Value,
}

#[tauri::command]
pub async fn claude_cli_start(
    window: tauri::Window,
    state: tauri::State<'_, Arc<CliApp>>,
    request_id: String,
    input: CliInput,
    host_tools: Vec<Value>,
) -> Result<(), String> {
    let app = state.inner().clone();
    let cancel = app.reserve(&request_id)?;
    let event_window = window.clone();
    let event_id = request_id.clone();
    let emit = Arc::new(move |event: Value| {
        event_window
            .emit(
                "claude-cli-event",
                EventPayload {
                    request_id: event_id.clone(),
                    event,
                },
            )
            .map_err(|_| "Cannot deliver CLI event".to_owned())
    });
    let facade = if input.enable_tools && !host_tools.is_empty() {
        match HostMcp::start(
            host_tools.clone(),
            app.tools.clone(),
            cancel.clone(),
            emit.clone(),
        ) {
            Ok(facade) => Some(facade),
            Err(error) => {
                app.finish(&request_id);
                return Err(error);
            }
        }
    } else {
        None
    };
    let host_config = facade.as_ref().map(|facade| facade.config.clone());
    let definitions = if facade.is_some() {
        Some(Value::Array(host_tools))
    } else {
        None
    };
    tauri::async_runtime::spawn(async move {
        let worker = app.runtime.clone();
        let worker_emit = emit.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            worker.run(input, definitions, host_config, cancel, |event| {
                worker_emit(event)
            })
        })
        .await;
        let error = match result {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(_) => Some("CLI driver failed".into()),
        };
        if let Some(error) = error {
            let _ = emit(json!({"type":"error","message":error}));
        }
        let _ = emit(json!({"type":"stream_end"}));
        drop(facade);
        app.finish(&request_id);
    });
    Ok(())
}

#[tauri::command]
pub fn claude_cli_cancel(state: tauri::State<'_, Arc<CliApp>>, request_id: String) {
    state.cancel(&request_id);
}

#[tauri::command]
pub fn claude_cli_tool_result(
    state: tauri::State<'_, Arc<CliApp>>,
    run_id: String,
    call_id: String,
    content: String,
    is_error: bool,
) -> Result<(), String> {
    state.tools.complete(&run_id, &call_id, content, is_error)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    executable_path: String,
    cli_version: Option<String>,
    allowed_tools: String,
    request_timeout_ms: u64,
    error: Option<String>,
}
fn status(runtime: &CliRuntime) -> CliStatus {
    let settings = runtime.settings();
    let executable = runtime.executable(&settings);
    let version = executable
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|path| runtime.cli_version(path, &CancellationToken::new(), None));
    CliStatus {
        executable_path: executable
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or(settings.cli_path),
        cli_version: version.as_ref().ok().cloned(),
        allowed_tools: settings.allowed_tools,
        request_timeout_ms: settings.request_timeout_ms,
        error: version.err(),
    }
}

#[tauri::command]
pub async fn claude_cli_status(state: tauri::State<'_, Arc<CliApp>>) -> Result<CliStatus, String> {
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || status(&runtime))
        .await
        .map_err(|_| "Cannot inspect Claude Code".into())
}
#[tauri::command]
pub async fn claude_cli_configure(
    state: tauri::State<'_, Arc<CliApp>>,
    executable_path: String,
) -> Result<CliStatus, String> {
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.update_settings(|settings| CliSettings {
            cli_path: executable_path.trim().into(),
            ..settings
        })?;
        Ok(status(&runtime))
    })
    .await
    .map_err(|_| "Cannot save Claude Code settings")?
}
#[tauri::command]
pub async fn claude_cli_options(
    state: tauri::State<'_, Arc<CliApp>>,
    allowed_tools: String,
    request_timeout_ms: u64,
) -> Result<CliStatus, String> {
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.update_settings(|settings| CliSettings {
            allowed_tools: allowed_tools
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>()
                .join(","),
            request_timeout_ms,
            ..settings
        })?;
        Ok(status(&runtime))
    })
    .await
    .map_err(|_| "Cannot save Claude Code settings")?
}
