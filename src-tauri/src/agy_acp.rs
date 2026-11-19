//! Antigravity ACP driver. All executable choices and process arguments are
//! owned by the host; a request can provide only conversation data.
use crate::claude_cli::{
    digest, exact_executable, file_identity, hide_window, history_hash, Message,
};
use crate::claude_cli_events::redact;
use crate::claude_cli_sessions::SessionStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgySettings {
    #[serde(default)]
    pub executable_path: String,
    #[serde(default)]
    pub request_timeout_ms: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgyInput {
    pub session_id: String,
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub enable_tools: bool,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

pub struct AgyRuntime {
    directory: PathBuf,
    sessions: Arc<SessionStore>,
    settings_lock: Mutex<()>,
    version: Mutex<HashMap<PathBuf, (String, String)>>,
    models: Mutex<Option<(String, Instant, Value)>>,
}

impl AgyRuntime {
    pub fn new(directory: PathBuf) -> Result<Arc<Self>, String> {
        fs::create_dir_all(&directory).map_err(|_| "Cannot prepare Antigravity data")?;
        Ok(Arc::new(Self {
            sessions: SessionStore::new(&directory.join("agy-sessions"))?,
            directory,
            settings_lock: Mutex::new(()),
            version: Mutex::new(HashMap::new()),
            models: Mutex::new(None),
        }))
    }
    pub fn settings(&self) -> AgySettings {
        fs::read(self.directory.join("agy-settings.json"))
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default()
    }
    pub fn update_settings(
        &self,
        update: impl FnOnce(AgySettings) -> AgySettings,
    ) -> Result<(), String> {
        let _lock = self
            .settings_lock
            .lock()
            .map_err(|_| "Antigravity settings unavailable")?;
        let settings = update(self.settings());
        if settings.request_timeout_ms > 86_400_000 {
            return Err("Invalid Antigravity timeout".into());
        }
        if !settings.executable_path.is_empty() {
            exact_executable(&settings.executable_path)
                .map_err(|_| "Select an installed agy.exe using an absolute path")?;
        }
        let mut file = tempfile::NamedTempFile::new_in(&self.directory)
            .map_err(|_| "Cannot save Antigravity settings")?;
        serde_json::to_writer(&mut file, &settings)
            .map_err(|_| "Cannot save Antigravity settings")?;
        file.persist(self.directory.join("agy-settings.json"))
            .map_err(|_| "Cannot save Antigravity settings")?;
        Ok(())
    }
    pub fn executable(&self, settings: &AgySettings) -> Result<PathBuf, String> {
        if !settings.executable_path.is_empty() {
            return exact_executable(&settings.executable_path)
                .map_err(|_| "Select an installed agy.exe using an absolute path".into());
        }
        let mut candidates = Vec::new();
        if let Some(base) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(base).join("agy").join("bin").join("agy.exe"));
        }
        if let Some(paths) = std::env::var_os("PATH") {
            candidates.extend(std::env::split_paths(&paths).map(|path| path.join("agy.exe")));
        }
        candidates
            .into_iter()
            .find(|path| path.is_file())
            .map(|path| path.components().collect())
            .ok_or_else(|| "Antigravity was not found; select agy.exe".into())
    }
    pub fn version(
        &self,
        path: &Path,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<String, String> {
        let identity = file_identity(path)?;
        if let Some((key, value)) = self
            .version
            .lock()
            .map_err(|_| "Antigravity version unavailable")?
            .get(path)
        {
            if key == &identity {
                return Ok(value.clone());
            }
        }
        let mut cmd = Command::new(path);
        hide_window(&mut cmd);
        let mut child = cmd
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Cannot start Antigravity")?;
        #[cfg(windows)]
        let job = crate::process_job::Job::attach(&child).map_err(|_| {
            let _ = child.kill();
            "Cannot protect Antigravity process"
        })?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Cannot read Antigravity version")?;
        let reader = thread::spawn(move || {
            let mut text = String::new();
            let _ = stdout.take(10000).read_to_string(&mut text);
            text
        });
        let start = Instant::now();
        let status = loop {
            if cancel.is_cancelled()
                || deadline.map_or(false, |end| Instant::now() >= end)
                || start.elapsed() >= Duration::from_secs(10)
            {
                #[cfg(windows)]
                drop(job);
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("Antigravity version check cancelled or timed out".into());
            }
            if let Some(status) = child
                .try_wait()
                .map_err(|_| "Cannot inspect Antigravity version")?
            {
                break status;
            }
            thread::sleep(Duration::from_millis(20));
        };
        let text = reader.join().unwrap_or_default();
        let version = text
            .lines()
            .map(str::trim)
            .find(|line| {
                let parts: Vec<_> = line.split('.').collect();
                parts.len() == 3
                    && parts
                        .iter()
                        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
            })
            .ok_or("Antigravity did not report a version")?;
        if !status.success() {
            return Err("Antigravity did not report a version".into());
        }
        self.version
            .lock()
            .map_err(|_| "Antigravity version unavailable")?
            .insert(path.to_path_buf(), (identity, version.into()));
        Ok(version.into())
    }
    pub fn models(&self, cancel: CancellationToken) -> Result<Value, String> {
        let path = self.executable(&self.settings())?;
        let ver = self.version(
            &path,
            &cancel,
            Some(Instant::now() + Duration::from_secs(30)),
        )?;
        let identity = format!("{}:{}", file_identity(&path)?, ver);
        if let Some((key, time, result)) = self
            .models
            .lock()
            .map_err(|_| "Model cache unavailable")?
            .as_ref()
        {
            if key == &identity && time.elapsed() < Duration::from_secs(60) {
                return Ok(result.clone());
            }
        }
        let root = tempfile::Builder::new()
            .prefix("agy-models-")
            .tempdir_in(&self.directory)
            .map_err(|_| "Cannot prepare Antigravity")?;
        let mut acp = Acp::start(
            &path,
            root.path(),
            cancel,
            Some(Instant::now() + Duration::from_secs(30)),
            HashSet::new(),
            Box::new(|_| Ok(())),
        )?;
        acp.initialize()?;
        let session = acp.rpc(
            "session/new",
            json!({"cwd":acp.work,"mcpServers":[]}),
            Some(Duration::from_secs(30)),
        )?;
        let id = session["sessionId"]
            .as_str()
            .ok_or("Antigravity did not create a session")?
            .to_owned();
        acp.session_id = id.clone();
        let entries = session["models"]["availableModels"]
            .as_array()
            .ok_or("Antigravity did not return models")?;
        let models = Value::Array(
            entries
                .iter()
                .filter_map(|entry| {
                    let id = entry["modelId"].as_str()?;
                    Some(json!({"id":id,"display_name":entry["name"].as_str().unwrap_or(id)}))
                })
                .collect(),
        );
        let _ = acp.rpc(
            "session/close",
            json!({"sessionId":id}),
            Some(Duration::from_secs(2)),
        );
        *self.models.lock().map_err(|_| "Model cache unavailable")? =
            Some((identity, Instant::now(), models.clone()));
        Ok(models)
    }
    pub fn run(
        &self,
        input: AgyInput,
        host_tools: Vec<Value>,
        host_config: Option<Value>,
        cancel: CancellationToken,
        emit: impl Fn(Value) -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        validate(&input)?;
        let settings = self.settings();
        let deadline = if settings.request_timeout_ms == 0 {
            None
        } else {
            Instant::now().checked_add(Duration::from_millis(settings.request_timeout_ms))
        };
        let path = self.executable(&settings)?;
        let version = self.version(&path, &cancel, deadline)?;
        let systems = input
            .messages
            .iter()
            .filter(|m| m.role == "system")
            .map(|m| text_content(&m.content))
            .collect::<Result<Vec<_>, _>>()?
            .join("\n\n");
        let mut messages: Vec<Message> = input
            .messages
            .iter()
            .filter(|m| m.role != "system")
            .cloned()
            .collect();
        let scope = digest(&json!([
            version,
            input.model,
            input.reasoning_effort,
            systems,
            input.enable_tools,
            host_tools
        ]));
        let key = digest(&json!(input.session_id));
        let mut lease = self.sessions.begin(
            &key,
            &scope,
            &history_hash(&messages[..messages.len() - 1]),
            crate::claude_cli::random_uuid()?,
        )?;
        let request_dir = tempfile::Builder::new()
            .prefix("request-")
            .tempdir_in(lease.path())
            .map_err(|_| "Cannot prepare Antigravity request")?;
        let ready_path = request_dir.path().join("mcp-ready");
        let names: HashSet<String> = host_tools
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
            .collect();
        let mut acp = Acp::start(&path, lease.path(), cancel, deadline, names, Box::new(emit))?;
        if let Some(secret) = host_config
            .as_ref()
            .and_then(|value| value["headers"]["Authorization"].as_str())
            .and_then(|value| value.strip_prefix("Bearer "))
        {
            acp.secrets.push(secret.to_owned());
        }
        let init = acp.initialize()?;
        if !systems.is_empty()
            && init["agentCapabilities"]["_meta"]["antigravity"]["systemPrompt"]["append"] != true
        {
            return Err("Antigravity cannot append the system prompt".into());
        }
        let mcp = if input.enable_tools {
            mcp_config(host_config, &ready_path)?
        } else {
            vec![]
        };
        let has_mcp = !mcp.is_empty();
        let mut params = json!({"cwd":acp.work,"mcpServers":mcp});
        if !systems.is_empty() {
            params["_meta"] = json!({"antigravity":{"systemPrompt":{"append":systems}}});
        }
        let mut resume = false;
        let mut session = Value::Null;
        if lease.resume {
            params["sessionId"] = json!(lease.id());
            match acp.rpc(
                "session/resume",
                params.clone(),
                Some(Duration::from_secs(30)),
            ) {
                Ok(value) if value.is_object() => {
                    session = value;
                    resume = true;
                }
                Ok(_) => return Err("Antigravity returned an invalid resume response".into()),
                Err(error) if error.resume_unavailable() => {}
                Err(error) => return Err(error.into()),
            }
            params.as_object_mut().unwrap().remove("sessionId");
        }
        if !resume {
            session = acp.rpc("session/new", params, Some(Duration::from_secs(30)))?;
        }
        let id = if resume {
            lease.id().to_owned()
        } else {
            session["sessionId"]
                .as_str()
                .ok_or("Antigravity did not create a session")?
                .to_owned()
        };
        acp.session_id = id.clone();
        set_model(
            &mut acp,
            &session,
            &input.model,
            input.reasoning_effort.as_deref(),
        )?;
        if has_mcp {
            let start = Instant::now();
            while !ready_path.is_file() && start.elapsed() < Duration::from_secs(5) {
                if acp.cancel.is_cancelled()
                    || acp.deadline.map_or(false, |end| Instant::now() >= end)
                {
                    return Err("Antigravity request cancelled or timed out".into());
                }
                thread::sleep(Duration::from_millis(50));
            }
            if !ready_path.is_file() {
                return Err("Antigravity did not initialize the NextChat tool server".into());
            }
        }
        let prompt = prompt_blocks(&messages, resume)?;
        let result = acp.rpc(
            "session/prompt",
            json!({"sessionId":id,"prompt":prompt}),
            None,
        )?;
        if result["stopReason"] == "cancelled" {
            return Err("Antigravity request cancelled".into());
        }
        messages.push(Message {
            role: "assistant".into(),
            content: json!(std::mem::take(&mut acp.text)),
        });
        lease.set_id(id.clone());
        lease.commit(history_hash(&messages));
        (acp.emit)(json!({"type":"done","sessionId":id}))?;
        Ok(())
    }
}

fn validate(input: &AgyInput) -> Result<(), String> {
    if input.session_id.is_empty()
        || input.session_id.len() > 256
        || input.model.is_empty()
        || input.model.len() > 256
        || input.messages.is_empty()
        || input.messages.len() > 2000
        || input.messages.last().map(|m| m.role.as_str()) != Some("user")
    {
        return Err("Invalid Antigravity request".into());
    }
    if input.messages.iter().any(|m| {
        !matches!(m.role.as_str(), "system" | "user" | "assistant")
            || !(m.content.is_string() || m.content.is_array())
    }) {
        return Err("Invalid Antigravity messages".into());
    }
    if input.reasoning_effort.as_deref().map_or(false, |v| {
        !v.is_empty() && !matches!(v, "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
    }) {
        return Err("Invalid Antigravity thinking level".into());
    }
    Ok(())
}

fn text_content(value: &Value) -> Result<String, String> {
    if let Some(text) = value.as_str() {
        return Ok(text.into());
    }
    value
        .as_array()
        .ok_or("Invalid text")?
        .iter()
        .map(|part| {
            if part["type"] == "text" {
                part["text"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or("Invalid text".into())
            } else {
                Err("System prompts must contain text".into())
            }
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|parts| parts.join("\n"))
}
fn blocks(value: &Value) -> Result<Vec<Value>, String> {
    if let Some(text) = value.as_str() {
        return Ok(vec![json!({"type":"text","text":text})]);
    }
    value
        .as_array()
        .ok_or("Invalid message")?
        .iter()
        .map(|part| {
            if part["type"] == "text" {
                return Ok(
                    json!({"type":"text","text":part["text"].as_str().ok_or("Invalid text")?}),
                );
            }
            let (mime, data) = part["image_url"]["url"]
                .as_str()
                .and_then(|url| url.strip_prefix("data:"))
                .and_then(|url| url.split_once(";base64,"))
                .ok_or("Images must be embedded as data URLs")?;
            if part["type"] != "image_url"
                || !mime.starts_with("image/")
                || !mime
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"/+.-".contains(&c))
                || !data
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"+/= \r\n\t".contains(&c))
            {
                return Err("Invalid image".into());
            }
            Ok(json!({"type":"image","mimeType":mime,"data":data}))
        })
        .collect()
}
fn take_start(text: &str, max: usize) -> &str {
    let mut end = max.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
fn take_end(text: &str, max: usize) -> &str {
    let mut start = text.len().saturating_sub(max);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}
fn prompt_blocks(messages: &[Message], resume: bool) -> Result<Vec<Value>, String> {
    let mut result = Vec::new();
    if !resume && messages.len() > 1 {
        let mut history = String::new();
        for message in &messages[..messages.len() - 1] {
            let text = blocks(&message.content)?
                .iter()
                .map(|part| part["text"].as_str().unwrap_or("[image]"))
                .collect::<Vec<_>>()
                .join("\n");
            let bounded = if text.len() > 16384 {
                format!("{}\n…\n{}", take_start(&text, 8192), take_end(&text, 8192))
            } else {
                text
            };
            history.push_str(&format!("{}:\n{}\n\n", message.role, bounded));
        }
        if history.len() > 112 * 1024 {
            history = format!(
                "{}\n…\n{}",
                take_start(&history, 16 * 1024),
                take_end(&history, 96 * 1024 - 10)
            );
        }
        result.push(json!({"type":"text","text":format!("Previous conversation:\n{history}\nCurrent user message:\n")}));
    }
    result.extend(blocks(&messages.last().ok_or("Invalid messages")?.content)?);
    Ok(result)
}
fn mcp_config(config: Option<Value>, ready_path: &Path) -> Result<Vec<Value>, String> {
    let Some(config) = config else {
        return Ok(vec![]);
    };
    let url = config["url"].as_str().ok_or("Invalid host tool endpoint")?;
    let token = config["headers"]["Authorization"]
        .as_str()
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or("Invalid host tool endpoint")?;
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid host tool endpoint")?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none()
    {
        return Err("Invalid host tool endpoint".into());
    }
    let executable = std::env::current_exe().map_err(|_| "Cannot locate NextChat")?;
    #[cfg(test)]
    let executable = std::env::var_os("NEXTCHAT_TEST_MCP_PROXY")
        .map(PathBuf::from)
        .unwrap_or(executable);
    Ok(vec![
        json!({"name":"nextchat","command":executable,"args":["--nextchat-mcp-stdio"],"env":[{"name":"NEXTCHAT_MCP_URL","value":url},{"name":"NEXTCHAT_MCP_TOKEN","value":token},{"name":"NEXTCHAT_MCP_READY","value":ready_path}]}),
    ])
}

type Emitter = Box<dyn Fn(Value) -> Result<(), String> + Send>;
struct RpcError {
    code: Option<i64>,
    message: String,
}
impl RpcError {
    fn resume_unavailable(&self) -> bool {
        if self.code == Some(-32601) {
            return true;
        }
        let message = self.message.to_ascii_lowercase();
        [
            "session not found",
            "session is not found",
            "session was not found",
            "session id not found",
            "session does not exist",
            "session no longer exists",
            "unknown session",
            "missing session",
        ]
        .iter()
        .any(|part| message.contains(part))
            || (message.contains("session/resume")
                && (message.contains("not supported") || message.contains("not implemented")))
    }
}
impl From<String> for RpcError {
    fn from(message: String) -> Self {
        Self {
            code: None,
            message,
        }
    }
}
impl From<&str> for RpcError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}
impl From<RpcError> for String {
    fn from(error: RpcError) -> Self {
        error.message
    }
}

struct Acp {
    work: PathBuf,
    child: Child,
    #[cfg(windows)]
    job: Option<crate::process_job::Job>,
    sender: Option<mpsc::Sender<String>>,
    receiver: Option<mpsc::Receiver<Result<Value, String>>>,
    output_thread: Option<JoinHandle<()>>,
    input_thread: Option<JoinHandle<()>>,
    error_thread: Option<JoinHandle<()>>,
    cancel: CancellationToken,
    deadline: Option<Instant>,
    next_id: u64,
    session_id: String,
    tools: HashSet<String>,
    started_tools: HashSet<String>,
    text: String,
    separate_text: bool,
    secrets: Vec<String>,
    emit: Emitter,
}
impl Acp {
    fn start(
        path: &Path,
        root: &Path,
        cancel: CancellationToken,
        deadline: Option<Instant>,
        tools: HashSet<String>,
        emit: Emitter,
    ) -> Result<Self, String> {
        let work = root.join("work");
        let gemini = root.join("gemini");
        let agent = work.join(".agents/agents/nextchat");
        fs::create_dir_all(&agent).map_err(|_| "Cannot prepare Antigravity agent")?;
        fs::create_dir_all(&gemini).map_err(|_| "Cannot prepare Antigravity agent")?;
        fs::write(agent.join("agent.md"), "---\nname: nextchat\ndescription: NextChat request agent\nmainAgent: true\nsubagent: false\ntools: []\ninheritMcp: false\ninheritCustomizations: false\n---\nUse only the tools supplied by NextChat.\n").map_err(|_| "Cannot prepare Antigravity agent")?;
        let mut command = Command::new(path);
        hide_window(&mut command);
        command
            .current_dir(&work)
            .args([
                "acp",
                "--agent",
                "nextchat",
                "--disable-telemetry",
                "--include-default-customizations=false",
                "--gemini-dir",
            ])
            .arg(&gemini)
            .arg("--log-file")
            .arg(root.join("agy.log"))
            .env("AGY_CLI_DISABLE_AUTO_UPDATE", "true")
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("ANTHROPIC_AUTH_TOKEN")
            .env_remove("OPENAI_API_KEY")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|_| "Cannot start Antigravity")?;
        #[cfg(windows)]
        let job = crate::process_job::Job::attach(&child).map_err(|_| {
            let _ = child.kill();
            "Cannot protect Antigravity process"
        })?;
        let mut stdin = child.stdin.take().ok_or("Cannot open Antigravity input")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Cannot read Antigravity output")?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or("Cannot read Antigravity errors")?;
        let (send_input, receive_input) = mpsc::channel::<String>();
        let input_thread = thread::spawn(move || {
            while let Ok(message) = receive_input.recv() {
                if writeln!(stdin, "{message}").is_err() || stdin.flush().is_err() {
                    break;
                }
            }
        });
        let (send_output, receive_output) = mpsc::sync_channel::<Result<Value, String>>(128);
        let output_thread = thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                let result = match reader
                    .by_ref()
                    .take(8 * 1024 * 1024 + 1)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => break,
                    Ok(_) if line.len() > 8 * 1024 * 1024 => {
                        Err("Antigravity event too large".into())
                    }
                    Ok(_) => serde_json::from_slice::<Value>(&line)
                        .map_err(|_| "Invalid Antigravity event".into()),
                    Err(_) => Err("Cannot read Antigravity event".into()),
                };
                if send_output.send(result).is_err() {
                    break;
                }
            }
        });
        let error_thread = thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while stderr.read(&mut buf).unwrap_or(0) > 0 {}
        });
        Ok(Self {
            work,
            child,
            #[cfg(windows)]
            job: Some(job),
            sender: Some(send_input),
            receiver: Some(receive_output),
            output_thread: Some(output_thread),
            input_thread: Some(input_thread),
            error_thread: Some(error_thread),
            cancel,
            deadline,
            next_id: 0,
            session_id: String::new(),
            tools,
            started_tools: HashSet::new(),
            text: String::new(),
            separate_text: false,
            secrets: [
                "GEMINI_API_KEY",
                "GOOGLE_API_KEY",
                "ANTHROPIC_API_KEY",
                "OPENAI_API_KEY",
            ]
            .iter()
            .filter_map(|name| std::env::var(name).ok())
            .filter(|value| value.len() >= 4)
            .collect(),
            emit,
        })
    }
    fn write(&self, value: Value) -> Result<(), String> {
        self.sender
            .as_ref()
            .ok_or("Antigravity connection closed")?
            .send(value.to_string())
            .map_err(|_| "Antigravity connection closed".into())
    }
    fn initialize(&mut self) -> Result<Value, String> {
        self.rpc("initialize", json!({"protocolVersion":1,"clientInfo":{"name":"NextChat","version":"2.16.1"},"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}), Some(Duration::from_secs(30))).map_err(Into::into)
    }
    fn rpc(
        &mut self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, RpcError> {
        if self.cancel.is_cancelled() {
            return Err("Antigravity request cancelled".into());
        }
        if self.deadline.map_or(false, |end| Instant::now() >= end) {
            return Err("Antigravity request timed out".into());
        }
        self.next_id += 1;
        let id = self.next_id;
        self.write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        let started = Instant::now();
        loop {
            if self.cancel.is_cancelled()
                || self.deadline.map_or(false, |end| Instant::now() >= end)
            {
                if !self.session_id.is_empty() {
                    let _ = self.write(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":self.session_id}}));
                }
                return Err(if self.cancel.is_cancelled() {
                    "Antigravity request cancelled"
                } else {
                    "Antigravity request timed out"
                }
                .into());
            }
            if timeout.map_or(false, |limit| started.elapsed() >= limit) {
                return Err(format!("Antigravity {method} timed out").into());
            }
            match self
                .receiver
                .as_ref()
                .unwrap()
                .recv_timeout(Duration::from_millis(25))
            {
                Ok(Ok(value)) => {
                    if value.get("method").is_none() && value["id"].as_u64() == Some(id) {
                        if !value["error"].is_null() {
                            let error = value["error"]["message"]
                                .as_str()
                                .unwrap_or("Antigravity request failed");
                            if error.to_ascii_lowercase().contains("not logged") {
                                return Err(
                                    "请运行 agy 完成登录 / Run agy and sign in first".into()
                                );
                            }
                            let mut safe = redact(error, "");
                            for secret in &self.secrets {
                                safe = redact(&safe, secret);
                            }
                            return Err(RpcError {
                                code: value["error"]["code"].as_i64(),
                                message: safe,
                            });
                        }
                        return Ok(value["result"].clone());
                    }
                    if value["method"] == "session/request_permission" && !value["id"].is_null() {
                        let result = permission(&value["params"], &self.tools, &self.session_id);
                        self.write(json!({"jsonrpc":"2.0","id":value["id"],"result":result}))?;
                    } else if value.get("method").is_some() && !value["id"].is_null() {
                        self.write(json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32601,"message":"Unsupported request"}}))?;
                    } else if value["method"] == "session/update"
                        && value["params"]["sessionId"] == self.session_id
                    {
                        self.update(&value["params"]["update"])?;
                    }
                }
                Ok(Err(error)) => return Err(error.into()),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Antigravity process exited".into())
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
    fn update(&mut self, value: &Value) -> Result<(), String> {
        let kind = value["sessionUpdate"].as_str().unwrap_or("");
        let event = match kind {
            "agent_message_chunk" if value["content"]["type"] == "text" => {
                let text = value["content"]["text"].as_str().unwrap_or("");
                let separator = if !text.is_empty() && self.separate_text && !self.text.is_empty() && !self.text.ends_with("\n\n") { if self.text.ends_with('\n') { "\n" } else { "\n\n" } } else { "" };
                if !text.is_empty() { self.separate_text = false; }
                let chunk = format!("{separator}{text}"); self.text.push_str(&chunk); Some(json!({"type":"text","text":chunk}))
            }
            "agent_thought_chunk" if value["content"]["type"] == "text" => Some(json!({"type":"thinking","text":value["content"]["text"]})),
            "tool_call" => value["toolCallId"].as_str().map(|id| { self.started_tools.insert(id.into()); self.separate_text = !self.text.is_empty(); json!({"type":"tool_start","id":id,"name":value["name"].as_str().or_else(|| value["title"].as_str()).unwrap_or("tool"),"input":value.get("rawInput").cloned().unwrap_or_else(|| json!({}))}) }),
            "tool_call_update" if matches!(value["status"].as_str(), Some("completed" | "failed")) => value["toolCallId"].as_str().and_then(|id| {
                if !self.started_tools.remove(id) { return None; }
                let output = value.get("rawOutput").or_else(|| value.get("content")).unwrap_or(&Value::Null);
                let text = output.as_str().map(str::to_owned).unwrap_or_else(|| output.to_string());
                Some(json!({"type":"tool_end","id":id,"content":text,"isError":value["status"] == "failed"}))
            }),
            _ => None,
        };
        if let Some(event) = event {
            (self.emit)(event)?;
        }
        Ok(())
    }
}
impl Drop for Acp {
    fn drop(&mut self) {
        #[cfg(windows)]
        drop(self.job.take());
        let _ = self.child.kill();
        self.sender.take();
        let _ = self.child.wait();
        self.receiver.take();
        if let Some(handle) = self.input_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.output_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.error_thread.take() {
            let _ = handle.join();
        }
    }
}

fn permission(params: &Value, names: &HashSet<String>, session: &str) -> Value {
    let mut allowed = false;
    if params["sessionId"]
        .as_str()
        .map_or(true, |id| id == session)
    {
        for key in ["name", "toolName"] {
            if let Some(value) = params["toolCall"][key].as_str() {
                let value = value.trim().trim_end_matches('?');
                let name = value
                    .strip_prefix("mcp(nextchat/")
                    .and_then(|s| s.strip_suffix(')'))
                    .or_else(|| value.strip_prefix("nextchat/"))
                    .or_else(|| value.strip_prefix("mcp_nextchat_"));
                if name.map_or(false, |name| names.contains(name)) {
                    allowed = true;
                    break;
                }
            }
        }
    }
    let options = params["options"].as_array().cloned().unwrap_or_default();
    let option = options
        .iter()
        .find(|item| item["kind"] == if allowed { "allow_once" } else { "reject_once" })
        .or_else(|| {
            if allowed {
                None
            } else {
                options.iter().find(|item| item["kind"] == "reject_always")
            }
        });
    match option {
        Some(option) => json!({"outcome":{"outcome":"selected","optionId":option["optionId"]}}),
        None => json!({"outcome":{"outcome":"cancelled"}}),
    }
}

fn set_model(
    acp: &mut Acp,
    session: &Value,
    model: &str,
    requested: Option<&str>,
) -> Result<(), String> {
    let available = session["models"]["availableModels"]
        .as_array()
        .ok_or("Antigravity did not return models")?;
    if !available.iter().any(|value| value["modelId"] == model) {
        return Err("The selected model is not offered by Antigravity".into());
    }
    let options = session["configOptions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let model_option = options.iter().find(|option| option["id"] == "model");
    let choices = model_option
        .and_then(|option| option["options"].as_array())
        .cloned()
        .unwrap_or_default();
    let base = choices
        .iter()
        .filter_map(|choice| choice["value"].as_str())
        .filter(|value| {
            model == *value
                || model
                    .strip_prefix(&format!("{value}-"))
                    .map_or(false, |suffix| {
                        matches!(suffix, "low" | "medium" | "high" | "xhigh" | "max")
                    })
        })
        .max_by_key(|value| value.len());
    let id = acp.session_id.clone();
    if let Some(base) = base {
        let suffix = model.strip_prefix(&format!("{base}-")).unwrap_or("");
        let effort = requested.filter(|s| !s.is_empty()).unwrap_or(suffix);
        let updated = acp.rpc(
            "session/set_config_option",
            json!({"sessionId":id,"configId":"model","value":base}),
            Some(Duration::from_secs(30)),
        )?;
        let order = ["minimal", "low", "medium", "high", "xhigh", "max"];
        let target = order.iter().position(|value| *value == effort);
        let chosen = updated["configOptions"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["id"] == "thought_level"))
            .and_then(|item| item["options"].as_array())
            .and_then(|values| {
                target.and_then(|target| {
                    values
                        .iter()
                        .filter_map(|value| value["value"].as_str())
                        .filter_map(|value| {
                            order
                                .iter()
                                .position(|item| *item == value)
                                .map(|index| (value, index.abs_diff(target)))
                        })
                        .min_by_key(|(_, distance)| *distance)
                        .map(|(value, _)| value.to_owned())
                })
            });
        if let Some(effort) = chosen {
            acp.rpc(
                "session/set_config_option",
                json!({"sessionId":id,"configId":"thought_level","value":effort}),
                Some(Duration::from_secs(30)),
            )?;
        }
    } else {
        acp.rpc(
            "session/set_model",
            json!({"sessionId":id,"modelId":model}),
            Some(Duration::from_secs(30)),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    struct Fixture {
        _root: tempfile::TempDir,
        executable: PathBuf,
    }
    fn fake() -> PathBuf {
        static FIXTURE: OnceLock<Fixture> = OnceLock::new();
        FIXTURE
            .get_or_init(|| {
                let root = tempfile::tempdir().unwrap();
                let executable = root.path().join("agy.exe");
                let repository = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
                let mut command = Command::new("rustc");
                hide_window(&mut command);
                assert!(command
                    .arg(repository.join("test/fixtures/fake-agy.rs"))
                    .arg("-o")
                    .arg(&executable)
                    .status()
                    .unwrap()
                    .success());
                let node =
                    std::env::var_os("NEXTCHAT_TEST_AGY_NODE").unwrap_or_else(|| "node".into());
                std::env::set_var("NEXTCHAT_TEST_AGY_NODE", node);
                std::env::set_var(
                    "NEXTCHAT_TEST_AGY_SCRIPT",
                    repository.join("test/fixtures/fake-agy.mjs"),
                );
                Fixture {
                    _root: root,
                    executable,
                }
            })
            .executable
            .clone()
    }
    fn runtime(root: &Path) -> Arc<AgyRuntime> {
        let runtime = AgyRuntime::new(root.join("runtime")).unwrap();
        runtime
            .update_settings(|settings| AgySettings {
                executable_path: fake().to_string_lossy().into_owned(),
                ..settings
            })
            .unwrap();
        runtime
    }
    fn input(text: &str) -> AgyInput {
        AgyInput {
            session_id: "one".into(),
            model: "test-model-low".into(),
            enable_tools: false,
            reasoning_effort: None,
            messages: vec![
                Message {
                    role: "system".into(),
                    content: json!("unchanged system"),
                },
                Message {
                    role: "user".into(),
                    content: json!(text),
                },
            ],
        }
    }
    #[test]
    fn fake_agent_discovers_models_streams_resumes_and_rejects_builtin() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = runtime(temp.path());
        let models = runtime.models(CancellationToken::new()).unwrap();
        assert_eq!(models[0]["id"], "test-model-low");
        let events = Arc::new(Mutex::new(Vec::new()));
        let first = input("hello");
        let captured = events.clone();
        runtime
            .run(
                first.clone(),
                vec![],
                None,
                CancellationToken::new(),
                move |event| {
                    captured.lock().unwrap().push(event);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(events.lock().unwrap()[0]["text"], "reply");
        assert_eq!(events.lock().unwrap().last().unwrap()["type"], "done");
        let mut next = first;
        next.messages.push(Message {
            role: "assistant".into(),
            content: json!("reply"),
        });
        next.messages.push(Message {
            role: "user".into(),
            content: json!("continue"),
        });
        events.lock().unwrap().clear();
        let captured = events.clone();
        runtime
            .run(next, vec![], None, CancellationToken::new(), move |event| {
                captured.lock().unwrap().push(event);
                Ok(())
            })
            .unwrap();
        assert_eq!(events.lock().unwrap()[0]["text"], "resumed");
        events.lock().unwrap().clear();
        let captured = events.clone();
        runtime
            .run(
                input("try builtin"),
                vec![],
                None,
                CancellationToken::new(),
                move |event| {
                    captured.lock().unwrap().push(event);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(events.lock().unwrap()[0]["text"], "denied");
    }
    #[test]
    fn resume_falls_back_only_when_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = runtime(temp.path());
        for mode in ["unsupported", "denied"] {
            let mut first = input(&format!("resume-{mode} init"));
            first.session_id = format!("resume-{mode}");
            runtime
                .run(
                    first.clone(),
                    vec![],
                    None,
                    CancellationToken::new(),
                    |_| Ok(()),
                )
                .unwrap();
            let mut next = first;
            next.messages.push(Message {
                role: "assistant".into(),
                content: json!("reply"),
            });
            next.messages.push(Message {
                role: "user".into(),
                content: json!("continue"),
            });
            let events = Arc::new(Mutex::new(Vec::new()));
            let captured = events.clone();
            let result = runtime.run(next, vec![], None, CancellationToken::new(), move |event| {
                captured.lock().unwrap().push(event);
                Ok(())
            });
            if mode == "unsupported" {
                result.unwrap();
                assert_eq!(events.lock().unwrap()[0]["text"], "reply");
            } else {
                assert_eq!(result.unwrap_err(), "Google rejected the request");
                assert!(events.lock().unwrap().is_empty());
            }
        }
    }
    #[tokio::test]
    async fn fake_agent_calls_host_tool_through_real_stdio_submode() {
        if std::env::var_os("NEXTCHAT_TEST_MCP_PROXY").is_none() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let runtime = runtime(temp.path());
        let host = Arc::new(crate::claude_cli_mcp::HostTools::default());
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let executor = host.clone();
        let emit: Arc<dyn Fn(Value) -> Result<(), String> + Send + Sync> = Arc::new(move |event| {
            if event["type"] == "host_tool_call" {
                assert_eq!(event["name"], "probe");
                executor.complete(
                    event["runId"].as_str().unwrap(),
                    event["id"].as_str().unwrap(),
                    "from NextChat".into(),
                    false,
                )?;
            }
            captured.lock().unwrap().push(event);
            Ok(())
        });
        let cancel = CancellationToken::new();
        let tools = vec![json!({"name":"probe","inputSchema":{"type":"object"}})];
        let facade = crate::claude_cli_mcp::HostMcp::start(
            tools.clone(),
            host,
            cancel.clone(),
            emit.clone(),
        )
        .unwrap();
        let mut request = input("use tool");
        request.enable_tools = true;
        let config = facade.config.clone();
        tokio::task::spawn_blocking(move || {
            runtime.run(request, tools, Some(config), cancel, move |event| {
                emit(event)
            })
        })
        .await
        .unwrap()
        .unwrap();
        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| event["type"] == "host_tool_call"));
        assert!(events
            .iter()
            .any(|event| event["type"] == "tool_end" && event["content"] == "from NextChat"));
        assert_eq!(events.last().unwrap()["type"], "done");
    }
    #[test]
    fn permission_requires_exact_nextchat_tool_identity() {
        let names = HashSet::from(["probe".to_owned()]);
        let request = |name| json!({"sessionId":"s","toolCall":{"name":name},"options":[{"kind":"allow_once","optionId":"yes"},{"kind":"reject_once","optionId":"no"}]});
        assert_eq!(
            permission(&request("mcp(nextchat/probe)"), &names, "s")["outcome"]["optionId"],
            "yes"
        );
        assert_eq!(
            permission(&request("run_command nextchat/probe"), &names, "s")["outcome"]["optionId"],
            "no"
        );
        assert_eq!(
            permission(&request("mcp(nextchat/other)"), &names, "s")["outcome"]["optionId"],
            "no"
        );
        assert_eq!(
            permission(
                &json!({"sessionId":"s","toolCall":{"title":"mcp(nextchat/probe)"},"options":[{"kind":"reject_once","optionId":"no"}]}),
                &names,
                "s"
            )["outcome"]["optionId"],
            "no"
        );
    }
    #[test]
    fn replay_is_bounded_and_preserves_utf8_and_current_input() {
        let mut messages = vec![Message {
            role: "user".into(),
            content: json!("首".repeat(120000)),
        }];
        messages.push(Message {
            role: "assistant".into(),
            content: json!("answer"),
        });
        messages.push(Message {
            role: "user".into(),
            content: json!("current"),
        });
        let prompt = prompt_blocks(&messages, false).unwrap();
        assert!(prompt[0]["text"].as_str().unwrap().len() < 115000);
        assert_eq!(prompt.last().unwrap()["text"], "current");
    }
    #[test]
    fn errors_redact_bearer_tokens_and_explain_login() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = runtime(temp.path());
        let error = runtime
            .run(
                input("emit error"),
                vec![],
                None,
                CancellationToken::new(),
                |_| Ok(()),
            )
            .unwrap_err();
        assert!(!error.contains("another-secret"));
        let error = runtime
            .run(
                input("login-needed"),
                vec![],
                None,
                CancellationToken::new(),
                |_| Ok(()),
            )
            .unwrap_err();
        assert!(error.contains("agy") && error.contains("登录"));
    }
    #[cfg(windows)]
    #[test]
    fn cancellation_ends_the_child_tree() {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let temp = tempfile::tempdir().unwrap();
        let runtime = runtime(temp.path());
        let cancel = CancellationToken::new();
        let worker = runtime.clone();
        let token = cancel.clone();
        let handle =
            thread::spawn(move || worker.run(input("stall"), vec![], None, token, |_| Ok(())));
        let start = Instant::now();
        let pid = loop {
            let root = temp.path().join("runtime/agy-sessions/managed-rust");
            let paths = fs::read_dir(root)
                .ok()
                .into_iter()
                .flatten()
                .flatten()
                .flat_map(|run| {
                    fs::read_dir(run.path())
                        .ok()
                        .into_iter()
                        .flatten()
                        .flatten()
                })
                .map(|entry| entry.path().join("work/fake-agy.pid"));
            if let Some(pid) = paths
                .filter_map(|path| fs::read_to_string(path).ok())
                .find_map(|text| text.parse::<u32>().ok())
            {
                break pid;
            }
            assert!(start.elapsed() < Duration::from_secs(15));
            thread::sleep(Duration::from_millis(30));
        };
        cancel.cancel();
        assert!(handle.join().unwrap().unwrap_err().contains("cancelled"));
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process != 0 {
                let mut code = 0;
                assert_ne!(GetExitCodeProcess(process, &mut code), 0);
                CloseHandle(process);
                assert_ne!(code, 259);
            }
        }
    }
}
