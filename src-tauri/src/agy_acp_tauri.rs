use crate::agy_acp::{AgyInput, AgyRuntime, AgySettings};
use crate::claude_cli_mcp::{HostMcp, HostTools};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

struct Request {
    cancel: CancellationToken,
    started: bool,
    created: Instant,
}
pub struct AgyApp {
    runtime: Arc<AgyRuntime>,
    tools: Arc<HostTools>,
    requests: Mutex<HashMap<String, Request>>,
}
impl AgyApp {
    pub fn new(directory: PathBuf) -> Result<Self, String> {
        Ok(Self {
            runtime: AgyRuntime::new(directory)?,
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
            return Err("Invalid request identity".into());
        }
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| "Antigravity request state unavailable")?;
        requests.retain(|_, item| {
            item.started
                || !item.cancel.is_cancelled()
                || item.created.elapsed() < Duration::from_secs(120)
        });
        if requests.contains_key(id) {
            return Err("Antigravity request cancelled or duplicate".into());
        }
        let cancel = CancellationToken::new();
        requests.insert(
            id.into(),
            Request {
                cancel: cancel.clone(),
                started: true,
                created: Instant::now(),
            },
        );
        Ok(cancel)
    }
    fn cancel(&self, id: &str) {
        if id.is_empty() || id.len() > 120 {
            return;
        }
        if let Ok(mut requests) = self.requests.lock() {
            requests
                .entry(id.into())
                .or_insert_with(|| Request {
                    cancel: CancellationToken::new(),
                    started: false,
                    created: Instant::now(),
                })
                .cancel
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
            for item in requests.values() {
                item.cancel.cancel();
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

fn ensure_isolation_verified() -> Result<(), String> {
    Err("Antigravity 暂不可用：工具隔离尚未验证 / Antigravity is unavailable until tool isolation is verified".into())
}

#[tauri::command]
pub async fn agy_acp_start(
    window: tauri::Window,
    state: tauri::State<'_, Arc<AgyApp>>,
    request_id: String,
    input: AgyInput,
    host_tools: Vec<Value>,
) -> Result<(), String> {
    ensure_isolation_verified()?;
    let app = state.inner().clone();
    let cancel = app.reserve(&request_id)?;
    let event_id = request_id.clone();
    let emit = Arc::new(move |event: Value| {
        window
            .emit(
                "agy-acp-event",
                EventPayload {
                    request_id: event_id.clone(),
                    event,
                },
            )
            .map_err(|_| "Cannot deliver Antigravity event".to_owned())
    });
    let facade = if input.enable_tools && !host_tools.is_empty() {
        match HostMcp::start(
            host_tools.clone(),
            app.tools.clone(),
            cancel.clone(),
            emit.clone(),
        ) {
            Ok(value) => Some(value),
            Err(error) => {
                app.finish(&request_id);
                return Err(error);
            }
        }
    } else {
        None
    };
    let host_config = facade.as_ref().map(|facade| facade.config.clone());
    tauri::async_runtime::spawn(async move {
        let runtime = app.runtime.clone();
        let worker_emit = emit.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            runtime.run(input, host_tools, host_config, cancel, move |event| {
                worker_emit(event)
            })
        })
        .await;
        let error = match result {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(_) => Some("Antigravity driver failed".into()),
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
pub fn agy_acp_cancel(state: tauri::State<'_, Arc<AgyApp>>, request_id: String) {
    state.cancel(&request_id);
}
#[tauri::command]
pub fn agy_acp_tool_result(
    state: tauri::State<'_, Arc<AgyApp>>,
    run_id: String,
    call_id: String,
    content: String,
    is_error: bool,
) -> Result<(), String> {
    state.tools.complete(&run_id, &call_id, content, is_error)
}
#[tauri::command]
pub async fn agy_acp_models(state: tauri::State<'_, Arc<AgyApp>>) -> Result<Value, String> {
    ensure_isolation_verified()?;
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || runtime.models(CancellationToken::new()))
        .await
        .map_err(|_| "Cannot load Antigravity models")?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgyStatus {
    executable_path: String,
    cli_version: Option<String>,
    request_timeout_ms: u64,
    error: Option<String>,
}
fn status(runtime: &AgyRuntime) -> AgyStatus {
    let settings = runtime.settings();
    let executable = runtime.executable(&settings);
    let version = executable
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|path| runtime.version(path, &CancellationToken::new(), None));
    AgyStatus {
        executable_path: executable
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or(settings.executable_path),
        cli_version: version.as_ref().ok().cloned(),
        request_timeout_ms: settings.request_timeout_ms,
        error: version.err(),
    }
}
#[tauri::command]
pub async fn agy_acp_status(state: tauri::State<'_, Arc<AgyApp>>) -> Result<AgyStatus, String> {
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || status(&runtime))
        .await
        .map_err(|_| "Cannot inspect Antigravity".into())
}
#[tauri::command]
pub async fn agy_acp_configure(
    state: tauri::State<'_, Arc<AgyApp>>,
    executable_path: String,
) -> Result<AgyStatus, String> {
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.update_settings(|settings| AgySettings {
            executable_path: executable_path.trim().into(),
            ..settings
        })?;
        Ok(status(&runtime))
    })
    .await
    .map_err(|_| "Cannot save Antigravity settings")?
}
#[tauri::command]
pub async fn agy_acp_options(
    state: tauri::State<'_, Arc<AgyApp>>,
    request_timeout_ms: u64,
) -> Result<AgyStatus, String> {
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.update_settings(|settings| AgySettings {
            request_timeout_ms,
            ..settings
        })?;
        Ok(status(&runtime))
    })
    .await
    .map_err(|_| "Cannot save Antigravity settings")?
}
