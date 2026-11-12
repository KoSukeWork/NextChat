//! Built-in Claude Code `--print` runtime. The caller cannot provide an
//! executable, arbitrary arguments or environment variables in a chat request.
use crate::claude_cli_events::{redact, ClaudeEvents};
use crate::claude_cli_sessions::SessionStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

fn default_tools() -> String {
    "Read,Glob,Grep".into()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliSettings {
    #[serde(default)]
    pub cli_path: String,
    #[serde(default = "default_tools")]
    pub allowed_tools: String,
    #[serde(default)]
    pub request_timeout_ms: u64,
}
impl Default for CliSettings {
    fn default() -> Self {
        Self {
            cli_path: String::new(),
            allowed_tools: default_tools(),
            request_timeout_ms: 0,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EndpointInput {
    pub base_url: String,
    pub api_key: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub role: String,
    pub content: Value,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliInput {
    pub endpoint: EndpointInput,
    pub session_id: String,
    pub model: String,
    pub messages: Vec<Message>,
    pub auth_type: String,
    #[serde(default)]
    pub enable_tools: bool,
    #[serde(default)]
    pub betas: Vec<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

pub(crate) fn random_uuid() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "Cannot create CLI request identity")?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}", bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]))
}

fn digest(value: &Value) -> String {
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(value).unwrap_or_default());
    format!("{:x}", hash.finalize())
}

fn history_hash(messages: &[Message]) -> String {
    digest(&Value::Array(messages.iter().map(|message| json!({
        "role": message.role,
        "content": if message.role == "assistant" { message.content.as_str().map(|text| Value::String(text.trim().into())).unwrap_or_else(|| message.content.clone()) } else { message.content.clone() },
    })).collect()))
}

fn validate(input: &CliInput) -> Result<(), String> {
    if input.model.is_empty()
        || input.model.len() > 256
        || input.model.starts_with('-')
        || input.model.contains('\0')
    {
        return Err("Invalid model".into());
    }
    if input.session_id.is_empty() || input.session_id.len() > 256 {
        return Err("Invalid session identity".into());
    }
    if input.messages.is_empty()
        || input.messages.len() > 2000
        || input.messages.last().map(|item| item.role.as_str()) != Some("user")
    {
        return Err("Invalid messages".into());
    }
    if input.messages.iter().any(|item| {
        !matches!(item.role.as_str(), "system" | "user" | "assistant")
            || !(item.content.is_string() || item.content.is_array())
    }) {
        return Err("Invalid message".into());
    }
    let url = reqwest::Url::parse(&input.endpoint.base_url)
        .map_err(|_| "Use a plain HTTP(S) gateway base URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || input.endpoint.api_key.is_empty()
    {
        return Err("Invalid gateway configuration".into());
    }
    if !matches!(input.auth_type.as_str(), "api-key" | "bearer") {
        return Err("Invalid gateway authentication".into());
    }
    if input.betas.len() > 30
        || input.betas.iter().any(|beta| {
            beta.is_empty()
                || !beta
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
    {
        return Err("Invalid beta flags".into());
    }
    if input.reasoning_effort.as_deref().map_or(false, |effort| {
        !effort.is_empty() && !matches!(effort, "low" | "medium" | "high" | "xhigh" | "max")
    }) {
        return Err("Invalid reasoning effort".into());
    }
    Ok(())
}

fn content_blocks(content: &Value) -> Result<Vec<Value>, String> {
    if let Some(text) = content.as_str() {
        return Ok(vec![json!({"type":"text","text":text})]);
    }
    let parts = content.as_array().ok_or("Invalid message content")?;
    let mut result = Vec::new();
    for part in parts {
        if part["type"] == "text" {
            let text = part["text"].as_str().ok_or("Invalid text content")?;
            result.push(json!({"type":"text","text":text}));
            continue;
        }
        let value = part["image_url"]["url"].as_str().unwrap_or("");
        let (media_type, data) = value
            .strip_prefix("data:")
            .and_then(|s| s.split_once(";base64,"))
            .ok_or("CLI images must be embedded as data URLs")?;
        if part["type"] != "image_url"
            || !media_type.starts_with("image/")
            || !media_type
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"/+.-".contains(&c))
            || !data
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"+/= \r\n\t".contains(&c))
        {
            return Err("Invalid CLI image".into());
        }
        result.push(
            json!({"type":"image","source":{"type":"base64","media_type":media_type,"data":data}}),
        );
    }
    Ok(result)
}

fn exact_executable(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute()
        || !path.is_file()
        || !path
            .extension()
            .map_or(false, |ext| ext.eq_ignore_ascii_case("exe"))
    {
        return Err("Select an installed Claude Code .exe using an absolute path".into());
    }
    Ok(dunce::simplified(path).to_path_buf())
}

fn detect_cli() -> Option<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        paths.push(PathBuf::from(home).join(".local/bin/claude.exe"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path).map(|part| part.join("claude.exe")));
    }
    paths.into_iter().find(|path| path.is_file())
}

fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

#[cfg(windows)]
fn file_identity(path: &Path) -> Result<String, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let file =
        fs::File::open(path).map_err(|_| "Cannot inspect configured Claude Code executable")?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as isize, &mut info) } == 0 {
        return Err("Cannot inspect configured Claude Code executable".into());
    }
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect configured Claude Code executable")?;
    Ok(format!(
        "{:?}:{}:{}:{}:{}:{:?}:{:?}",
        fs::canonicalize(path).ok(),
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
        metadata.len(),
        metadata.modified().ok(),
        metadata.created().ok()
    ))
}
#[cfg(not(windows))]
fn file_identity(path: &Path) -> Result<String, String> {
    let metadata =
        fs::metadata(path).map_err(|_| "Cannot inspect configured Claude Code executable")?;
    Ok(format!(
        "{:?}:{}:{:?}:{:?}",
        fs::canonicalize(path).ok(),
        metadata.len(),
        metadata.modified().ok(),
        metadata.created().ok()
    ))
}

#[cfg(windows)]
fn attach_job(child: &std::process::Child) -> Result<crate::process_job::Job, String> {
    crate::process_job::Job::attach(child)
}

pub struct CliRuntime {
    directory: PathBuf,
    pub sessions: Arc<SessionStore>,
    version: Mutex<HashMap<PathBuf, (String, String)>>,
    settings_lock: Mutex<()>,
}
impl CliRuntime {
    pub fn new(directory: PathBuf) -> Result<Arc<Self>, String> {
        fs::create_dir_all(&directory).map_err(|_| "Cannot prepare CLI data directory")?;
        let sessions = SessionStore::new(&directory.join("cli-sessions"))?;
        Ok(Arc::new(Self {
            directory,
            sessions,
            version: Mutex::new(HashMap::new()),
            settings_lock: Mutex::new(()),
        }))
    }
    pub fn settings(&self) -> CliSettings {
        fs::read(self.directory.join("settings.json"))
            .ok()
            .and_then(|value| serde_json::from_slice(&value).ok())
            .unwrap_or_default()
    }
    pub fn save_settings(&self, settings: &CliSettings) -> Result<(), String> {
        let _guard = self
            .settings_lock
            .lock()
            .map_err(|_| "CLI settings unavailable")?;
        self.write_settings(settings)
    }
    pub fn update_settings(
        &self,
        update: impl FnOnce(CliSettings) -> CliSettings,
    ) -> Result<(), String> {
        let _guard = self
            .settings_lock
            .lock()
            .map_err(|_| "CLI settings unavailable")?;
        self.write_settings(&update(self.settings()))
    }
    fn write_settings(&self, settings: &CliSettings) -> Result<(), String> {
        if settings.allowed_tools.len() > 1024
            || settings.request_timeout_ms > 86_400_000
            || settings
                .allowed_tools
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .any(|s| !s.bytes().all(|ch| ch.is_ascii_alphanumeric() || ch == b'_'))
        {
            return Err("Invalid CLI settings".into());
        }
        if !settings.cli_path.is_empty() {
            exact_executable(&settings.cli_path)?;
        }
        let mut file = tempfile::NamedTempFile::new_in(&self.directory)
            .map_err(|_| "Cannot save CLI settings")?;
        serde_json::to_writer(&mut file, settings).map_err(|_| "Cannot save CLI settings")?;
        file.persist(self.directory.join("settings.json"))
            .map_err(|_| "Cannot save CLI settings")?;
        Ok(())
    }
    pub fn executable(&self, settings: &CliSettings) -> Result<PathBuf, String> {
        if settings.cli_path.is_empty() {
            detect_cli().ok_or_else(|| "Claude Code was not found; select its executable".into())
        } else {
            exact_executable(&settings.cli_path)
        }
    }
    pub fn cli_version(
        &self,
        path: &Path,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<String, String> {
        let identity = file_identity(path)?;
        if let Some((key, value)) = self
            .version
            .lock()
            .map_err(|_| "CLI version state unavailable")?
            .get(path)
        {
            if *key == identity {
                return Ok(value.clone());
            }
        }
        let mut command = Command::new(path);
        hide_window(&mut command);
        command
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|_| "Cannot start the configured Claude Code executable")?;
        #[cfg(windows)]
        let job = attach_job(&child).map_err(|_| {
            let _ = child.kill();
            "Cannot protect Claude Code process"
        })?;
        let stdout = child.stdout.take().ok_or("Cannot read CLI version")?;
        let reader = thread::spawn(move || {
            let mut text = String::new();
            let _ = stdout.take(10000).read_to_string(&mut text);
            text
        });
        let began = Instant::now();
        let status = loop {
            let request_timed_out = deadline.map_or(false, |deadline| Instant::now() >= deadline);
            if cancel.is_cancelled()
                || request_timed_out
                || began.elapsed() > Duration::from_secs(10)
            {
                #[cfg(windows)]
                drop(job);
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(if cancel.is_cancelled() {
                    "Claude Code request cancelled"
                } else if request_timed_out {
                    "Client driver request timed out"
                } else {
                    "Claude Code version check timed out"
                }
                .into());
            }
            if let Some(status) = child
                .try_wait()
                .map_err(|_| "Cannot inspect Claude Code version")?
            {
                break status;
            }
            thread::sleep(Duration::from_millis(20));
        };
        let text = reader.join().unwrap_or_default();
        if !status.success() {
            return Err("Configured executable did not report a Claude Code version".into());
        }
        let version = text
            .lines()
            .find_map(|line| line.trim().strip_suffix(" (Claude Code)"))
            .filter(|s| {
                let parts: Vec<_> = s.split('.').collect();
                parts.len() == 3
                    && parts
                        .iter()
                        .all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
            })
            .ok_or("Configured executable did not report a Claude Code version")?
            .to_owned();
        self.version
            .lock()
            .map_err(|_| "CLI version state unavailable")?
            .insert(path.to_path_buf(), (identity, version.clone()));
        Ok(version)
    }

    pub fn run(
        &self,
        input: CliInput,
        host_tools: Option<Value>,
        host_config: Option<Value>,
        cancel: CancellationToken,
        emit: impl Fn(Value) -> Result<(), String>,
    ) -> Result<(), String> {
        validate(&input)?;
        let settings = self.settings();
        let started = Instant::now();
        let expired = || {
            settings.request_timeout_ms > 0
                && started.elapsed() >= Duration::from_millis(settings.request_timeout_ms)
        };
        if cancel.is_cancelled() {
            return Err("Claude Code request cancelled".into());
        }
        let path = self.executable(&settings)?;
        let deadline = if settings.request_timeout_ms == 0 {
            None
        } else {
            started.checked_add(Duration::from_millis(settings.request_timeout_ms))
        };
        let version = self.cli_version(&path, &cancel, deadline)?;
        let mut systems = Vec::new();
        let mut messages = Vec::new();
        for message in &input.messages {
            if message.role == "system" {
                let blocks = content_blocks(&message.content)?;
                let text = blocks
                    .iter()
                    .map(|part| {
                        part["text"]
                            .as_str()
                            .ok_or("CLI system prompts must contain text")
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .join("\n");
                systems.push(text);
            } else {
                messages.push(message.clone());
            }
        }
        if messages.is_empty() {
            return Err("Invalid messages".into());
        }
        let system = systems.join("\n\n");
        let scope = digest(&json!([
            input.endpoint,
            version,
            input.model,
            system,
            input.enable_tools,
            input.betas,
            input.reasoning_effort,
            settings.allowed_tools,
            host_tools
        ]));
        let key = digest(&json!([input.endpoint, input.session_id]));
        let lease = self.sessions.begin(
            &key,
            &scope,
            &history_hash(&messages[..messages.len() - 1]),
            random_uuid()?,
        )?;
        let request_dir = tempfile::Builder::new()
            .prefix("request-")
            .tempdir_in(lease.path())
            .map_err(|_| "Cannot prepare CLI request")?;
        let mut command = Command::new(path);
        hide_window(&mut command);
        let work = self.directory.join("cli-work");
        fs::create_dir_all(&work).map_err(|_| "Cannot prepare CLI working directory")?;
        command
            .current_dir(work)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (name, _) in std::env::vars_os() {
            let key = name.to_string_lossy().to_ascii_uppercase();
            if key.starts_with("ANTHROPIC_")
                || key.starts_with("CLAUDE_")
                || key.starts_with("NEXTCHAT_BRIDGE_")
                || key.starts_with("NEXTCHAT_WIRE_")
                || key.starts_with("NEXTCHAT_SERVICE_")
                || key == "BUN_OPTIONS"
                || key == "NODE_OPTIONS"
            {
                command.env_remove(name);
            }
        }
        let gateway = input
            .endpoint
            .base_url
            .trim_end_matches('/')
            .strip_suffix("/v1")
            .unwrap_or(input.endpoint.base_url.trim_end_matches('/'));
        command
            .env("ANTHROPIC_BASE_URL", gateway)
            .env(
                if input.auth_type == "bearer" {
                    "ANTHROPIC_AUTH_TOKEN"
                } else {
                    "ANTHROPIC_API_KEY"
                },
                &input.endpoint.api_key,
            )
            .env("CLAUDE_CONFIG_DIR", lease.path())
            .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
            .env("DISABLE_AUTOUPDATER", "1");
        command.args([
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--model",
            &input.model,
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--permission-mode",
            "dontAsk",
            if lease.resume {
                "--resume"
            } else {
                "--session-id"
            },
            lease.id(),
        ]);
        let mut allowed: Vec<&str> = if input.enable_tools {
            settings
                .allowed_tools
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect()
        } else {
            Vec::new()
        };
        let builtins: Vec<_> = allowed
            .iter()
            .copied()
            .filter(|s| !s.starts_with("mcp__"))
            .collect();
        command.args(["--tools", &builtins.join(",")]);
        if input.enable_tools && host_config.is_some() {
            allowed.push("mcp__nextchat__*");
        }
        if !allowed.is_empty() {
            command.args(["--allowedTools", &allowed.join(",")]);
        }
        if !input.betas.is_empty() {
            command.args(["--betas", &input.betas.join(",")]);
        }
        if let Some(effort) = input
            .reasoning_effort
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            command.args(["--effort", effort]);
        }
        if !system.is_empty() {
            let prompt = request_dir.path().join("system.txt");
            fs::write(&prompt, system).map_err(|_| "Cannot write system prompt")?;
            command.arg("--append-system-prompt-file").arg(prompt);
        }
        if input.enable_tools {
            if let Some(config) = host_config {
                let file = request_dir.path().join("mcp.json");
                fs::write(
                    &file,
                    serde_json::to_vec(&json!({"mcpServers":{"nextchat":config}})).unwrap(),
                )
                .map_err(|_| "Cannot write tool configuration")?;
                command.arg("--mcp-config").arg(file);
            }
        }
        let mut blocks = Vec::new();
        if lease.resume {
            blocks.extend(content_blocks(&messages.last().unwrap().content)?);
        } else {
            for (index, message) in messages.iter().enumerate() {
                if messages.len() > 1 {
                    blocks.push(json!({"type":"text","text":if index == messages.len()-1 { "\nCurrent user message:\n".to_owned() } else { format!("\nPrevious {} message:\n", message.role) }}));
                }
                blocks.extend(content_blocks(&message.content)?);
            }
        }
        if cancel.is_cancelled() || expired() {
            return Err(if expired() {
                "Client driver request timed out"
            } else {
                "Claude Code request cancelled"
            }
            .into());
        }
        let mut child = command.spawn().map_err(|_| "Cannot launch Claude Code")?;
        #[cfg(windows)]
        let job = attach_job(&child).map_err(|_| {
            let _ = child.kill();
            "Cannot protect Claude Code process"
        })?;
        let mut stdin = child.stdin.take().ok_or("Cannot open CLI input")?;
        let value = json!({"type":"user","message":{"role":"user","content":blocks},"session_id":lease.id(),"parent_tool_use_id":null});
        let input_writer = thread::spawn(move || writeln!(stdin, "{}", value));
        let stdout = child.stdout.take().ok_or("Cannot read CLI output")?;
        let stderr = child.stderr.take().ok_or("Cannot read CLI errors")?;
        let (sender, receiver) = mpsc::sync_channel::<Result<Vec<u8>, String>>(128);
        let out_thread = thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match reader
                    .by_ref()
                    .take(8 * 1024 * 1024 + 1)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => break,
                    Ok(_) if line.len() <= 8 * 1024 * 1024 => {
                        if sender.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {
                        let _ = sender.send(Err(
                            "Claude Code output exceeded the event size limit".into(),
                        ));
                        break;
                    }
                    Err(_) => {
                        let _ = sender.send(Err("Cannot read Claude Code output".into()));
                        break;
                    }
                }
            }
        });
        let err_thread = thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut tail = Vec::new();
            let mut buf = [0u8; 2048];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                tail.extend_from_slice(&buf[..n]);
                if tail.len() > 8000 {
                    tail.drain(..tail.len() - 8000);
                }
            }
            String::from_utf8_lossy(&tail).into_owned()
        });
        let mut parser = ClaudeEvents::default();
        let mut exit = None;
        let mut eof = false;
        let result = (|| -> Result<(), String> {
            while !eof || exit.is_none() {
                if cancel.is_cancelled() || expired() {
                    return Err(if expired() {
                        "Client driver request timed out"
                    } else {
                        "Claude Code request cancelled"
                    }
                    .into());
                }
                match receiver.recv_timeout(Duration::from_millis(25)) {
                    Ok(Ok(line)) => {
                        let event: Value = serde_json::from_slice(&line)
                            .map_err(|_| "Claude Code returned an invalid stream event")?;
                        for output in parser.accept(&event, &input.endpoint.api_key)? {
                            emit(output)?;
                        }
                    }
                    Ok(Err(error)) => return Err(error),
                    Err(mpsc::RecvTimeoutError::Disconnected) => eof = true,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if exit.is_none() {
                    exit = child
                        .try_wait()
                        .map_err(|_| "Cannot inspect Claude Code process")?;
                }
            }
            if !exit.map_or(false, |status| status.success()) || !parser.succeeded {
                return Err("Claude Code stopped without a successful result".into());
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = child.kill();
        }
        #[cfg(windows)]
        drop(job);
        let _ = child.wait();
        drop(receiver);
        let _ = out_thread.join();
        let diagnostic = err_thread.join().unwrap_or_default();
        if let Err(error) = result {
            return Err(format!(
                "{}{}",
                redact(&error, &input.endpoint.api_key),
                if diagnostic.is_empty() {
                    String::new()
                } else {
                    format!(": {}", redact(&diagnostic, &input.endpoint.api_key))
                }
            ));
        }
        if input_writer.join().map_or(true, |result| result.is_err()) {
            return Err("Cannot write CLI input".into());
        }
        let session_id = lease.id().to_owned();
        messages.push(Message {
            role: "assistant".into(),
            content: Value::String(parser.text),
        });
        drop(request_dir);
        lease.commit(history_hash(&messages));
        emit(json!({"type":"done", "sessionId": session_id}))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    fn fake_cli() -> PathBuf {
        static ROOT: OnceLock<TempFixture> = OnceLock::new();
        ROOT.get_or_init(|| {
            let root = tempfile::tempdir().unwrap();
            let source = root.path().join("fake.rs");
            let binary = root.path().join("claude.exe");
            fs::write(
                &source,
                include_str!("../../test/fixtures/claude-cli-fake.rs"),
            )
            .unwrap();
            let mut command = Command::new("rustc");
            hide_window(&mut command);
            assert!(command
                .arg(&source)
                .arg("-o")
                .arg(&binary)
                .status()
                .unwrap()
                .success());
            TempFixture {
                _root: root,
                binary,
            }
        })
        .binary
        .clone()
    }
    struct TempFixture {
        _root: tempfile::TempDir,
        binary: PathBuf,
    }

    fn input(text: &str) -> CliInput {
        CliInput {
            endpoint: EndpointInput {
                base_url: "http://127.0.0.1:12345/v1".into(),
                api_key: "dummy-secret".into(),
            },
            session_id: "one".into(),
            model: "claude-test".into(),
            messages: vec![
                Message {
                    role: "system".into(),
                    content: json!("system instructions"),
                },
                Message {
                    role: "user".into(),
                    content: json!(text),
                },
            ],
            auth_type: "api-key".into(),
            enable_tools: false,
            betas: vec![],
            reasoning_effort: None,
        }
    }
    fn runtime(root: &Path, timeout: u64) -> Arc<CliRuntime> {
        let runtime = CliRuntime::new(root.join("local-services")).unwrap();
        runtime
            .save_settings(&CliSettings {
                cli_path: fake_cli().to_string_lossy().into_owned(),
                allowed_tools: default_tools(),
                request_timeout_ms: timeout,
            })
            .unwrap();
        runtime
    }
    #[test]
    fn invokes_cli_streams_events_resumes_and_removes_request_files() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = runtime(temp.path(), 0);
        let events = Mutex::new(Vec::new());
        let first = input("first");
        runtime
            .run(
                first.clone(),
                None,
                None,
                CancellationToken::new(),
                |event| {
                    events.lock().unwrap().push(event);
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
            content: json!("second"),
        });
        events.lock().unwrap().clear();
        runtime
            .run(next, None, None, CancellationToken::new(), |event| {
                events.lock().unwrap().push(event);
                Ok(())
            })
            .unwrap();
        assert_eq!(events.lock().unwrap()[0]["text"], "resumed");
        let managed = temp.path().join("local-services/cli-sessions/managed-rust");
        let run = fs::read_dir(managed)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let session = fs::read_dir(run)
            .unwrap()
            .flatten()
            .find(|entry| entry.file_name().to_string_lossy().starts_with("session-"))
            .unwrap()
            .path();
        assert!(fs::read_dir(session).unwrap().next().is_none());
    }
    #[test]
    fn timeout_and_diagnostics_are_redacted() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = runtime(temp.path(), 100);
        let error = runtime
            .run(
                input("slow-request"),
                None,
                None,
                CancellationToken::new(),
                |_| Ok(()),
            )
            .unwrap_err();
        assert!(error.contains("timed out"));
        let error = runtime
            .run(
                input("fail-request"),
                None,
                None,
                CancellationToken::new(),
                |_| Ok(()),
            )
            .unwrap_err();
        assert!(!error.contains("dummy-secret"));
        assert!(!error.contains("another-secret"));
    }

    #[test]
    fn shared_fake_cli_converts_segments_and_tools() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = runtime(temp.path(), 0);
        let events = Mutex::new(Vec::new());
        runtime
            .run(
                input("events-request"),
                None,
                None,
                CancellationToken::new(),
                |event| {
                    events.lock().unwrap().push(event);
                    Ok(())
                },
            )
            .unwrap();
        let events = events.lock().unwrap();
        let types: Vec<_> = events
            .iter()
            .filter_map(|event| event["type"].as_str())
            .collect();
        assert_eq!(
            types,
            ["thinking", "text", "tool_start", "tool_end", "text", "done"]
        );
        assert_eq!(events[1]["text"], "before");
        assert_eq!(events[4]["text"], "\n\nafter");
    }

    #[test]
    fn legacy_settings_are_retained_and_updates_do_not_clobber_each_other() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = runtime(temp.path(), 0);
        let path = fake_cli().to_string_lossy().into_owned();
        fs::write(
            temp.path().join("local-services/settings.json"),
            serde_json::to_vec(
                &json!({"cliPath":path,"allowedTools":"Read,Grep","requestTimeoutMs":120000}),
            )
            .unwrap(),
        )
        .unwrap();
        let one = runtime.clone();
        let two = runtime.clone();
        let first = thread::spawn(move || {
            one.update_settings(|settings| CliSettings {
                allowed_tools: "Write".into(),
                ..settings
            })
            .unwrap()
        });
        let second = thread::spawn(move || {
            two.update_settings(|settings| CliSettings {
                request_timeout_ms: 180000,
                ..settings
            })
            .unwrap()
        });
        first.join().unwrap();
        second.join().unwrap();
        let settings = runtime.settings();
        assert_eq!(settings.cli_path, path);
        assert_eq!(settings.allowed_tools, "Write");
        assert_eq!(settings.request_timeout_ms, 180000);
    }

    #[test]
    fn version_cache_refreshes_when_executable_is_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = CliRuntime::new(temp.path().join("data")).unwrap();
        let executable = temp.path().join("claude.exe");
        fs::copy(fake_cli(), &executable).unwrap();
        assert_eq!(
            runtime
                .cli_version(&executable, &CancellationToken::new(), None)
                .unwrap(),
            "1.2.3"
        );
        let source = temp.path().join("new.rs");
        fs::write(&source, "fn main() { println!(\"9.8.7 (Claude Code)\"); }").unwrap();
        let replacement = temp.path().join("replacement.exe");
        let mut command = Command::new("rustc");
        hide_window(&mut command);
        assert!(command
            .arg(source)
            .arg("-o")
            .arg(&replacement)
            .status()
            .unwrap()
            .success());
        fs::remove_file(&executable).unwrap();
        fs::rename(replacement, &executable).unwrap();
        assert_eq!(
            runtime
                .cli_version(&executable, &CancellationToken::new(), None)
                .unwrap(),
            "9.8.7"
        );
    }

    #[cfg(windows)]
    #[test]
    fn cancellation_kills_descendants_and_blocks_concurrent_conversation() {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let temp = tempfile::tempdir().unwrap();
        let runtime = runtime(temp.path(), 0);
        let cancel = CancellationToken::new();
        let worker = runtime.clone();
        let worker_cancel = cancel.clone();
        let (started, ready) = mpsc::channel();
        let handle = thread::spawn(move || {
            worker.run(input("slow-request"), None, None, worker_cancel, |event| {
                if event["type"] == "text" {
                    let _ = started.send(());
                }
                Ok(())
            })
        });
        ready.recv_timeout(Duration::from_secs(10)).unwrap();
        let pid: u32 =
            fs::read_to_string(temp.path().join("local-services/cli-work/fake-child.pid"))
                .unwrap()
                .parse()
                .unwrap();
        let error = runtime
            .run(
                input("another"),
                None,
                None,
                CancellationToken::new(),
                |_| Ok(()),
            )
            .unwrap_err();
        assert!(error.contains("already generating"));
        cancel.cancel();
        assert!(handle.join().unwrap().unwrap_err().contains("cancelled"));
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process != 0 {
                let mut code = 0;
                assert_ne!(GetExitCodeProcess(process, &mut code), 0);
                CloseHandle(process);
                assert_ne!(code, 259, "CLI descendant survived cancellation");
            }
        }
    }

    #[tokio::test]
    async fn real_cli_uses_local_gateway_and_host_mcp_when_requested() {
        if std::env::var("NEXTCHAT_TEST_REAL_CLAUDE").as_deref() != Ok("1") {
            return;
        }
        struct Gateway(std::process::Child);
        impl Drop for Gateway {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let repository = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let script = "import {mockAnthropic} from './test/fixtures/anthropic-http.mjs'; const gateway=await mockAnthropic({tool:{name:'mcp__nextchat__probe',input:{text:'hello'}},beforeToolText:'Before tool'}); console.log(gateway.url); process.stdin.resume();";
        let mut command = Command::new("node");
        hide_window(&mut command);
        let mut gateway = Gateway(
            command
                .current_dir(repository)
                .args(["--input-type=module", "-e", script])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut url = String::new();
        BufReader::new(gateway.0.stdout.take().unwrap())
            .read_line(&mut url)
            .unwrap();
        assert!(url.starts_with("http://127.0.0.1:"));
        let temp = tempfile::tempdir().unwrap();
        let runtime = CliRuntime::new(temp.path().join("local-services")).unwrap();
        let path = std::env::var("NEXTCHAT_CLAUDE_PATH")
            .ok()
            .map(PathBuf::from)
            .or_else(detect_cli)
            .expect("Claude Code executable");
        runtime
            .save_settings(&CliSettings {
                cli_path: path.to_string_lossy().into_owned(),
                allowed_tools: String::new(),
                request_timeout_ms: 30_000,
            })
            .unwrap();
        let host = Arc::new(crate::claude_cli_mcp::HostTools::default());
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let executor = host.clone();
        let emit: Arc<dyn Fn(Value) -> Result<(), String> + Send + Sync> = Arc::new(move |event| {
            if event["type"] == "host_tool_call" {
                assert_eq!(event["name"], "probe");
                assert_eq!(event["input"]["text"], "hello");
                executor.complete(
                    event["runId"].as_str().unwrap(),
                    event["id"].as_str().unwrap(),
                    "from-nextchat".into(),
                    false,
                )?;
            }
            captured.lock().unwrap().push(event);
            Ok(())
        });
        let definitions = vec![
            json!({"name":"probe","description":"Local test tool","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}),
        ];
        let cancel = CancellationToken::new();
        let facade = crate::claude_cli_mcp::HostMcp::start(
            definitions.clone(),
            host,
            cancel.clone(),
            emit.clone(),
        )
        .unwrap();
        let mut request = input("hello");
        request.endpoint.base_url = url.trim().into();
        request.enable_tools = true;
        let config = facade.config.clone();
        let result = tokio::task::spawn_blocking(move || {
            runtime.run(
                request,
                Some(Value::Array(definitions)),
                Some(config),
                cancel,
                |event| emit(event),
            )
        })
        .await
        .unwrap();
        result.unwrap();
        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| event["type"] == "host_tool_call"));
        assert!(events.iter().any(|event| event["type"] == "tool_start"));
        assert!(events.iter().any(|event| event["type"] == "tool_end"));
        assert!(events.iter().any(|event| event["type"] == "done"));
        let text: String = events
            .iter()
            .filter(|event| event["type"] == "text")
            .filter_map(|event| event["text"].as_str())
            .collect();
        assert!(text.contains("Before tool\n\nReply"), "{text}");
    }
}
