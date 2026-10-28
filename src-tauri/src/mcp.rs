use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpConfig {
    #[serde(default)]
    pub mcp_servers: BTreeMap<String, ServerConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub status: Option<ServerStatus>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ServerStatus {
    Active,
    Paused,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEvent {
    pub id: String,
    pub run_id: u64,
    pub line: Option<String>,
    pub code: Option<i32>,
}

type EventSink = Arc<dyn Fn(&str, ProcessEvent) + Send + Sync>;

struct RunningProcess {
    run_id: u64,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    #[cfg(windows)]
    _job: windows_job::Job,
}

pub struct McpState {
    config_path: PathBuf,
    config_lock: Mutex<()>,
    processes: Mutex<HashMap<String, RunningProcess>>,
    next_run: AtomicU64,
}

impl McpState {
    pub fn new(config_path: PathBuf) -> Self {
        Self {
            config_path,
            config_lock: Mutex::new(()),
            processes: Mutex::new(HashMap::new()),
            next_run: AtomicU64::new(1),
        }
    }

    fn read_disk(&self) -> Result<McpConfig, String> {
        match fs::read(&self.config_path) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|e| format!("Invalid MCP config: {e}"))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(McpConfig::default()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn read_config(&self) -> Result<McpConfig, String> {
        let _guard = self.config_lock.lock().map_err(|e| e.to_string())?;
        self.read_disk()
    }

    fn write_config(
        &self,
        config: McpConfig,
        confirm: impl FnOnce(&str) -> bool,
    ) -> Result<(), String> {
        let _guard = self.config_lock.lock().map_err(|e| e.to_string())?;
        let old = self.read_disk()?;
        let mut changes = Vec::new();
        for (id, server) in &config.mcp_servers {
            if id.trim().is_empty()
                || server.command.trim().is_empty()
                || server.command.contains('\0')
                || server.args.iter().any(|s| s.contains('\0'))
                || server
                    .env
                    .iter()
                    .any(|(k, v)| k.is_empty() || k.contains(['=', '\0']) || v.contains('\0'))
            {
                return Err("Invalid MCP server configuration".into());
            }
            if old
                .mcp_servers
                .get(id)
                .map(|s| (&s.command, &s.args, &s.env))
                != Some((&server.command, &server.args, &server.env))
            {
                // JSON quoting keeps argument boundaries and control characters visible.
                let command = std::iter::once(&server.command)
                    .chain(server.args.iter())
                    .map(|arg| serde_json::to_string(arg).unwrap())
                    .collect::<Vec<_>>()
                    .join(" ");
                changes.push(format!(
                    "Server: {}\nCommand: {}\nEnvironment: {}",
                    serde_json::to_string(id).unwrap(),
                    command,
                    serde_json::to_string_pretty(&server.env).unwrap()
                ));
            }
        }
        if !changes.is_empty() && !confirm(&format!("Allow these MCP servers to run local programs with your permissions?\nOnly approve commands you trust.\n\n{}", changes.join("\n\n"))) {
            return Err("MCP configuration was not approved. No changes were saved.".into());
        }
        let parent = self
            .config_path
            .parent()
            .ok_or("Missing MCP config directory")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let temporary = self.config_path.with_extension("json.tmp");
        let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temporary, &self.config_path).map_err(|e| e.to_string())?;
        // Enforce lifecycle in Rust even when the caller bypasses the UI actions.
        for (id, previous) in &old.mcp_servers {
            if config.mcp_servers.get(id).map_or(true, |next| {
                next.status == Some(ServerStatus::Paused)
                    || (&next.command, &next.args, &next.env)
                        != (&previous.command, &previous.args, &previous.env)
            }) {
                self.kill(id, None)?;
            }
        }
        Ok(())
    }

    fn spawn(self: &Arc<Self>, id: &str, emit: EventSink) -> Result<u64, String> {
        // Serialize config approval/writes and process creation. Never accept a command from JS.
        let _config_guard = self.config_lock.lock().map_err(|e| e.to_string())?;
        let config = self.read_disk()?;
        let server = config
            .mcp_servers
            .get(id)
            .ok_or("MCP server is not configured")?;
        if server.status == Some(ServerStatus::Paused) {
            return Err("MCP server is paused".into());
        }
        self.kill(id, None)?;
        let environment = child_environment(&server.env);
        let executable = resolve_command(&server.command, &environment)?;
        let mut command = Command::new(executable);
        command
            .args(&server.args)
            .env_clear()
            .envs(&environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start {}: {e}", server.command))?;
        #[cfg(windows)]
        let job = match windows_job::Job::attach(&child) {
            Ok(job) => job,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        let stdin = child.stdin.take().ok_or("Missing MCP stdin")?;
        let stdout = child.stdout.take().ok_or("Missing MCP stdout")?;
        let stderr = child.stderr.take().ok_or("Missing MCP stderr")?;
        let run_id = self.next_run.fetch_add(1, Ordering::SeqCst);
        let child = Arc::new(Mutex::new(child));
        self.processes.lock().map_err(|e| e.to_string())?.insert(
            id.into(),
            RunningProcess {
                run_id,
                child: child.clone(),
                stdin: Arc::new(Mutex::new(stdin)),
                #[cfg(windows)]
                _job: job,
            },
        );
        let stdout_reader = read_lines(stdout, id.into(), run_id, "mcp://message", emit.clone());
        let stderr_reader = read_lines(stderr, id.into(), run_id, "mcp://stderr", emit.clone());
        let state = self.clone();
        let id = id.to_owned();
        thread::spawn(move || {
            let code = loop {
                let status = child.lock().unwrap().try_wait();
                match status {
                    Ok(Some(status)) => break status.code(),
                    Err(_) => break None,
                    Ok(None) => thread::sleep(Duration::from_millis(25)),
                }
            };
            // Closing the job also closes inherited pipes in remaining descendants.
            if let Ok(mut processes) = state.processes.lock() {
                if processes.get(&id).map(|p| p.run_id) == Some(run_id) {
                    processes.remove(&id);
                }
            }
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            emit(
                "mcp://exit",
                ProcessEvent {
                    id,
                    run_id,
                    line: None,
                    code,
                },
            );
        });
        Ok(run_id)
    }

    fn send(&self, id: &str, run_id: u64, line: &str) -> Result<(), String> {
        if line.contains(['\n', '\r']) {
            return Err("MCP input must be a single JSON line".into());
        }
        let input = {
            let processes = self.processes.lock().map_err(|e| e.to_string())?;
            processes
                .get(id)
                .filter(|p| p.run_id == run_id)
                .ok_or("MCP connection is closed")?
                .stdin
                .clone()
        };
        // A blocked pipe write must not prevent kill/exit from terminating the child.
        let mut stdin = input.lock().map_err(|e| e.to_string())?;
        writeln!(stdin, "{line}")
            .and_then(|_| stdin.flush())
            .map_err(|e| e.to_string())
    }

    fn kill(&self, id: &str, run_id: Option<u64>) -> Result<(), String> {
        let mut processes = self.processes.lock().map_err(|e| e.to_string())?;
        if processes
            .get(id)
            .map(|p| run_id.map_or(true, |r| p.run_id == r))
            == Some(true)
        {
            if let Some(process) = processes.remove(id) {
                let mut child = process.child.lock().map_err(|e| e.to_string())?;
                if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                    child.kill().map_err(|e| e.to_string())?;
                    child.wait().map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        let ids = self
            .processes
            .lock()
            .map(|p| p.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in ids {
            let _ = self.kill(&id, None);
        }
    }
}

fn read_lines(
    reader: impl std::io::Read + Send + 'static,
    id: String,
    run_id: u64,
    event: &'static str,
    emit: EventSink,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) => emit(
                    event,
                    ProcessEvent {
                        id: id.clone(),
                        run_id,
                        line: Some(line),
                        code: None,
                    },
                ),
                Err(_) => break,
            }
        }
    })
}

fn child_environment(overrides: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    #[cfg(windows)]
    let allowed = [
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERNAME",
        "USERPROFILE",
        "PROGRAMFILES",
    ]
    .as_slice();
    #[cfg(not(windows))]
    let allowed = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"].as_slice();
    let mut environment: BTreeMap<String, String> = std::env::vars()
        .filter(|(key, value)| {
            allowed.iter().any(|k| key.eq_ignore_ascii_case(k)) && !value.starts_with("()")
        })
        .collect();
    for (key, value) in overrides {
        #[cfg(windows)]
        environment.retain(|k, _| !k.eq_ignore_ascii_case(key));
        environment.insert(key.clone(), value.clone());
    }
    environment
}

fn resolve_command(
    command: &str,
    environment: &BTreeMap<String, String>,
) -> Result<PathBuf, String> {
    let path = environment
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    #[cfg(windows)]
    let extensions = environment
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATHEXT"))
        .map(|(_, v)| v.clone())
        .or_else(|| std::env::var("PATHEXT").ok())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
    #[cfg(not(windows))]
    let extensions = String::new();
    resolve_in_path(command, path, &extensions)
}

fn resolve_in_path(command: &str, path: &str, extensions: &str) -> Result<PathBuf, String> {
    let input = Path::new(command);
    let bases: Vec<PathBuf> = if input.is_absolute() || input.components().count() > 1 {
        vec![input.to_owned()]
    } else {
        std::env::split_paths(path).map(|p| p.join(input)).collect()
    };
    for base in bases {
        let candidates = if cfg!(windows) && base.extension().is_none() {
            extensions
                .split(';')
                .filter(|ext| ext.starts_with('.'))
                .map(|ext| PathBuf::from(format!("{}{}", base.display(), ext)))
                .collect::<Vec<_>>()
        } else {
            vec![base]
        };
        for candidate in candidates {
            // cmd.exe cannot execute ordinary batch files via verbatim (\\?\) paths.
            if candidate.is_file() {
                return dunce::canonicalize(candidate).map_err(|e| e.to_string());
            }
        }
    }
    Err(format!("MCP executable not found on PATH: {command}"))
}

#[cfg(windows)]
mod windows_job {
    use std::{mem, os::windows::io::AsRawHandle, process::Child};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };
    pub struct Job(HANDLE);
    impl Job {
        pub fn attach(child: &Child) -> Result<Self, String> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle == 0 {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let job = Self(handle);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    mem::size_of_val(&limits) as u32,
                ) == 0
                    || AssignProcessToJobObject(handle, child.as_raw_handle() as HANDLE) == 0
                {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                Ok(job)
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[tauri::command]
pub async fn mcp_read_config(state: tauri::State<'_, Arc<McpState>>) -> Result<McpConfig, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.read_config())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mcp_write_config(
    window: tauri::Window,
    state: tauri::State<'_, Arc<McpState>>,
    config: McpConfig,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.write_config(config, |message| {
            tauri::api::dialog::blocking::ask(
                Some(&window),
                "Allow MCP command execution?",
                message,
            )
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mcp_spawn(
    window: tauri::Window,
    state: tauri::State<'_, Arc<McpState>>,
    id: String,
) -> Result<u64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.spawn(
            &id,
            Arc::new(move |event, payload| {
                let _ = window.emit(event, payload);
            }),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mcp_send(
    state: tauri::State<'_, Arc<McpState>>,
    id: String,
    run_id: u64,
    line: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.send(&id, run_id, &line))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mcp_kill(
    state: tauri::State<'_, Arc<McpState>>,
    id: String,
    run_id: Option<u64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.kill(&id, run_id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;
