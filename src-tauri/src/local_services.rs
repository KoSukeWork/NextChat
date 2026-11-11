//! Desktop-owned bundled services. Plugins select a registered service, never
//! arbitrary helper commands, arguments, ports, or environment variables.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceKind {
    Wire,
    ClaudeCli,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub url: String,
    pub token: String,
    pub cli_version: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    service: ServiceKind,
    available: bool,
    running: bool,
    pid: Option<u32>,
    executable_path: String,
    can_select_executable: bool,
    connection: Option<Connection>,
    error: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    #[serde(default)]
    cli_path: String,
}

struct Running {
    child: Child,
    #[cfg(windows)]
    job: Option<crate::process_job::Job>,
    connection: Option<Connection>,
}
impl Drop for Running {
    fn drop(&mut self) {
        #[cfg(windows)]
        drop(self.job.take()); // Kill the entire tree, including a running CLI.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct Inner {
    processes: BTreeMap<ServiceKind, Running>,
    errors: BTreeMap<ServiceKind, String>,
    options: Options,
}

pub struct ServiceState {
    directory: PathBuf,
    helper: PathBuf,
    inner: Mutex<Inner>,
}

pub fn bundled_helper(app: tauri::AppHandle) -> PathBuf {
    let relative = Path::new("claude-code-tools/nextchat-wire-relay.exe");
    let installed = app
        .path_resolver()
        .resource_dir()
        .unwrap_or_default()
        .join(relative);
    if installed.is_file() {
        return installed;
    }
    if let Ok(exe) = std::env::current_exe() {
        let portable = exe.parent().unwrap_or(Path::new("")).join(relative);
        if portable.is_file() {
            return portable;
        }
    }
    #[cfg(debug_assertions)]
    {
        let development =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../build/nextchat-wire-relay.exe");
        if development.is_file() {
            return development;
        }
    }
    installed
}

fn exact_executable(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute()
        || !path.is_file()
        || !path
            .extension()
            .map_or(false, |s| s.eq_ignore_ascii_case("exe"))
    {
        return Err("Select an installed Claude Code .exe using an absolute path".into());
    }
    dunce::canonicalize(path).map_err(|_| "Claude Code executable is unavailable".into())
}

fn detect_cli() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        candidates.push(PathBuf::from(home).join(".local/bin/claude.exe"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|p| p.join("claude.exe")));
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "Could not create a local service token")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn parse_ready(kind: ServiceKind, bytes: &[u8], token: String) -> Result<Connection, String> {
    let info: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "Invalid bundled service startup response")?;
    let expected = match kind {
        ServiceKind::Wire => "nextchat-wire-relay",
        ServiceKind::ClaudeCli => "nextchat-cli-bridge",
    };
    if info["name"] != expected || info["protocolVersion"] != 1 {
        return Err("Bundled service version is incompatible".into());
    }
    let address = info["listening"]
        .as_str()
        .ok_or("Missing local service address")?;
    let url = reqwest::Url::parse(address).map_err(|_| "Invalid local service address")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("The bundled service must listen on loopback".into());
    }
    let cli_version = if kind == ServiceKind::ClaudeCli {
        let version = info["versions"][0]
            .as_str()
            .ok_or("Claude Code did not report a version")?;
        if version.split('.').count() != 3
            || version
                .split('.')
                .any(|s| s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()))
        {
            return Err("Claude Code reported an invalid version".into());
        }
        Some(version.into())
    } else {
        None
    };
    Ok(Connection {
        url: address.trim_end_matches('/').into(),
        token,
        cli_version,
    })
}

impl ServiceState {
    pub fn new(directory: PathBuf, helper: PathBuf) -> Self {
        let options = fs::read(directory.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            directory,
            helper,
            inner: Mutex::new(Inner {
                options,
                ..Inner::default()
            }),
        }
    }

    fn available(&self) -> bool {
        cfg!(all(windows, target_arch = "x86_64")) && self.helper.is_file()
    }

    fn snapshot(&self, inner: &mut Inner, kind: ServiceKind) -> ServiceStatus {
        let ended = inner
            .processes
            .get_mut(&kind)
            .and_then(|run| run.child.try_wait().ok().flatten());
        if let Some(code) = ended {
            inner.processes.remove(&kind);
            inner.errors.insert(
                kind,
                format!("Local service exited ({code}); start it again"),
            );
        }
        let run = inner.processes.get(&kind);
        ServiceStatus {
            service: kind,
            available: self.available(),
            running: run.is_some(),
            pid: run.map(|p| p.child.id()),
            executable_path: if kind == ServiceKind::ClaudeCli {
                if inner.options.cli_path.is_empty() {
                    detect_cli()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default()
                } else {
                    inner.options.cli_path.clone()
                }
            } else {
                String::new()
            },
            can_select_executable: kind == ServiceKind::ClaudeCli,
            connection: run.and_then(|p| p.connection.clone()),
            error: inner.errors.get(&kind).cloned(),
        }
    }

    fn status(&self, kind: ServiceKind) -> Result<ServiceStatus, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Local service state is unavailable")?;
        Ok(self.snapshot(&mut inner, kind))
    }

    fn launch(&self, kind: ServiceKind, cli: Option<&Path>) -> Result<Running, String> {
        if !self.available() {
            return Err("Bundled local services are missing or unsupported; extract the complete Windows x64 package".into());
        }
        fs::create_dir_all(&self.directory).map_err(|_| "Could not prepare local service data")?;
        let token = token()?;
        let mut command = Command::new(&self.helper);
        command
            .env_clear()
            .envs(std::env::vars_os().filter(|(name, _)| {
                let name = name.to_string_lossy().to_ascii_uppercase();
                !name.starts_with("ANTHROPIC_")
                    && !name.starts_with("CLAUDE_")
                    && !name.starts_with("NEXTCHAT_")
                    && name != "BUN_OPTIONS"
                    && name != "NODE_OPTIONS"
            }));
        command
            .current_dir(&self.directory)
            .env("NEXTCHAT_SERVICE_MANAGED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        match kind {
            ServiceKind::Wire => {
                command
                    .env("NEXTCHAT_WIRE_TOKEN", &token)
                    .env("NEXTCHAT_WIRE_HOST", "127.0.0.1")
                    .env("NEXTCHAT_WIRE_PORT", "0");
            }
            ServiceKind::ClaudeCli => {
                command
                    .arg("--bridge")
                    .env("NEXTCHAT_BRIDGE_TOKEN", &token)
                    .env("NEXTCHAT_BRIDGE_HOST", "127.0.0.1")
                    .env("NEXTCHAT_BRIDGE_PORT", "0")
                    .env(
                        "NEXTCHAT_CLAUDE_PATH",
                        cli.ok_or("Select a Claude Code executable")?,
                    )
                    .env("NEXTCHAT_SERVICE_WORK_DIR", self.directory.join("cli-work"))
                    .env(
                        "NEXTCHAT_SERVICE_DATA_DIR",
                        self.directory.join("cli-sessions"),
                    );
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = command
            .spawn()
            .map_err(|_| "Could not start the bundled local service")?;
        let mut running = Running {
            child,
            #[cfg(windows)]
            job: None,
            connection: None,
        };
        #[cfg(windows)]
        {
            running.job = Some(crate::process_job::Job::attach(&running.child)?);
        }
        running
            .child
            .stdin
            .take()
            .ok_or("Missing service startup pipe")?
            .write_all(b"start\n")
            .map_err(|_| "Local service stopped before startup")?;
        let stdout = running
            .child
            .stdout
            .take()
            .ok_or("Missing local service output")?;
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            let result = reader.by_ref().take(8193).read_until(b'\n', &mut line);
            let _ = sender.send(
                if result.is_ok() && !line.is_empty() && line.len() <= 8192 {
                    Some(line)
                } else {
                    None
                },
            );
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
        let bytes = receiver
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| "Local service startup timed out; check the selected CLI executable")?
            .ok_or(
                "Local service could not start; check the bundled component and CLI executable",
            )?;
        running.connection = Some(parse_ready(kind, &bytes, token)?);
        if running
            .child
            .try_wait()
            .map_err(|_| "Could not inspect local service")?
            .is_some()
        {
            return Err("Local service exited during startup".into());
        }
        Ok(running)
    }

    fn save_cli_path(&self, inner: &mut Inner, path: String) -> Result<(), String> {
        fs::create_dir_all(&self.directory).map_err(|_| "Could not save local service settings")?;
        let options = Options { cli_path: path };
        let mut file = tempfile::NamedTempFile::new_in(&self.directory)
            .map_err(|_| "Could not save local service settings")?;
        serde_json::to_writer(&mut file, &options)
            .map_err(|_| "Could not save local service settings")?;
        file.persist(self.directory.join("settings.json"))
            .map_err(|_| "Could not save local service settings")?;
        inner.options = options;
        Ok(())
    }

    fn configure(
        &self,
        kind: ServiceKind,
        executable_path: String,
    ) -> Result<ServiceStatus, String> {
        if kind != ServiceKind::ClaudeCli {
            return Err("This service has no executable setting".into());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Local service state is unavailable")?;
        if self.snapshot(&mut inner, kind).running {
            return Err("Stop the CLI service before changing its executable".into());
        }
        let path = if executable_path.trim().is_empty() {
            String::new()
        } else {
            exact_executable(executable_path.trim())?
                .to_string_lossy()
                .into_owned()
        };
        self.save_cli_path(&mut inner, path)?;
        Ok(self.snapshot(&mut inner, kind))
    }

    fn start(
        &self,
        kind: ServiceKind,
        executable_path: Option<String>,
    ) -> Result<ServiceStatus, String> {
        // Serialize startup with stop and duplicate start requests. No external
        // process is adopted, and no PID supplied by the renderer is ever killed.
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Local service state is unavailable")?;
        let previous = self.snapshot(&mut inner, kind);
        if previous.running {
            return Ok(previous);
        }
        let result = (|| {
            let cli = if kind == ServiceKind::ClaudeCli {
                let requested = executable_path.unwrap_or(previous.executable_path);
                let path = if requested.trim().is_empty() {
                    detect_cli().ok_or("Claude Code was not found; select its executable")?
                } else {
                    exact_executable(requested.trim())?
                };
                self.save_cli_path(&mut inner, path.to_string_lossy().into_owned())?;
                Some(path)
            } else {
                None
            };
            self.launch(kind, cli.as_deref())
        })();
        match result {
            Ok(process) => {
                inner.processes.insert(kind, process);
                inner.errors.remove(&kind);
                Ok(self.snapshot(&mut inner, kind))
            }
            Err(error) => {
                inner.errors.insert(kind, error.clone());
                Err(error)
            }
        }
    }

    fn stop(&self, kind: ServiceKind) -> Result<ServiceStatus, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Local service state is unavailable")?;
        inner.processes.remove(&kind);
        inner.errors.remove(&kind);
        Ok(self.snapshot(&mut inner, kind))
    }

    pub fn shutdown(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.processes.clear();
        }
    }
}

#[tauri::command]
pub async fn local_service_configure(
    state: tauri::State<'_, Arc<ServiceState>>,
    service: ServiceKind,
    executable_path: String,
) -> Result<ServiceStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.configure(service, executable_path))
        .await
        .map_err(|_| "Could not save local service settings")?
}

#[tauri::command]
pub async fn local_service_status(
    state: tauri::State<'_, Arc<ServiceState>>,
    service: ServiceKind,
) -> Result<ServiceStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.status(service))
        .await
        .map_err(|_| "Could not inspect local service")?
}
#[tauri::command]
pub async fn local_service_start(
    state: tauri::State<'_, Arc<ServiceState>>,
    service: ServiceKind,
    executable_path: Option<String>,
) -> Result<ServiceStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.start(service, executable_path))
        .await
        .map_err(|_| "Could not start local service")?
}
#[tauri::command]
pub async fn local_service_stop(
    state: tauri::State<'_, Arc<ServiceState>>,
    service: ServiceKind,
) -> Result<ServiceStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.stop(service))
        .await
        .map_err(|_| "Could not stop local service")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readiness_rejects_non_loopback_and_wrong_service_identity() {
        for address in [
            "http://evil.test:1234",
            "https://127.0.0.1:1234",
            "http://127.0.0.1:1234/path",
            "http://user@127.0.0.1:1234",
        ] {
            let value = serde_json::json!({ "name": "nextchat-wire-relay", "protocolVersion": 1, "listening": address });
            assert!(parse_ready(
                ServiceKind::Wire,
                &serde_json::to_vec(&value).unwrap(),
                "token".into()
            )
            .is_err());
        }
        assert!(serde_json::from_str::<ServiceKind>("\"arbitrary-command\"").is_err());
        assert!(exact_executable("claude.cmd").is_err());
        let first = token().unwrap();
        assert_eq!(first.len(), 64);
        assert_ne!(first, token().unwrap());
    }

    #[test]
    fn executable_selection_persists_without_starting_a_service() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("selected.exe");
        fs::write(&executable, b"configuration test; not executable").unwrap();
        let helper = directory.path().join("missing-helper.exe");
        let state = ServiceState::new(directory.path().into(), helper.clone());
        let configured = state
            .configure(
                ServiceKind::ClaudeCli,
                executable.to_string_lossy().into_owned(),
            )
            .unwrap();
        assert!(!configured.running);
        assert!(configured.connection.is_none());
        assert!(state.configure(ServiceKind::Wire, String::new()).is_err());
        assert!(state
            .configure(ServiceKind::ClaudeCli, "missing.cmd".into())
            .is_err());
        drop(state);
        let restored = ServiceState::new(directory.path().into(), helper);
        assert_eq!(
            restored
                .status(ServiceKind::ClaudeCli)
                .unwrap()
                .executable_path,
            exact_executable(&executable.to_string_lossy())
                .unwrap()
                .to_string_lossy()
        );
        assert!(!restored.status(ServiceKind::ClaudeCli).unwrap().running);
        restored
            .configure(ServiceKind::ClaudeCli, String::new())
            .unwrap();
        let options: Options =
            serde_json::from_slice(&fs::read(directory.path().join("settings.json")).unwrap())
                .unwrap();
        assert!(options.cli_path.is_empty());
    }

    #[test]
    #[cfg(windows)]
    fn bundled_service_lifecycle_reuses_one_process_and_rotates_credentials() {
        let helper = Path::new(env!("CARGO_MANIFEST_DIR")).join("../build/nextchat-wire-relay.exe");
        if !helper.is_file() {
            eprintln!("Build the service helper to run the native lifecycle check");
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let state = ServiceState::new(directory.path().into(), helper);
        let first = state.start(ServiceKind::Wire, None).unwrap();
        assert!(first.running);
        let again = state.start(ServiceKind::Wire, None).unwrap();
        assert_eq!(first.pid, again.pid);
        assert_eq!(
            first.connection.as_ref().unwrap().token,
            again.connection.as_ref().unwrap().token
        );
        assert!(!state.stop(ServiceKind::Wire).unwrap().running);
        let restarted = state.start(ServiceKind::Wire, None).unwrap();
        assert_ne!(
            first.connection.unwrap().token,
            restarted.connection.unwrap().token
        );
        state.shutdown();
        assert!(!state.status(ServiceKind::Wire).unwrap().running);
    }

    #[test]
    #[cfg(windows)]
    fn cli_start_reports_actual_version_and_persists_selected_executable() {
        if std::env::var("NEXTCHAT_TEST_REAL_CLAUDE").as_deref() != Ok("1") {
            return;
        }
        let helper = Path::new(env!("CARGO_MANIFEST_DIR")).join("../build/nextchat-wire-relay.exe");
        let cli = detect_cli().expect("Install Claude Code for the opt-in CLI test");
        let cli = exact_executable(&cli.to_string_lossy()).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let state = ServiceState::new(directory.path().into(), helper.clone());
        let started = state
            .start(
                ServiceKind::ClaudeCli,
                Some(cli.to_string_lossy().into_owned()),
            )
            .unwrap();
        assert!(started.running);
        assert!(started.connection.as_ref().unwrap().cli_version.is_some());
        assert!(state
            .configure(ServiceKind::ClaudeCli, String::new())
            .is_err());
        assert_eq!(
            state.start(ServiceKind::ClaudeCli, None).unwrap().pid,
            started.pid
        );
        state.shutdown();
        let restored = ServiceState::new(directory.path().into(), helper);
        assert_eq!(
            restored
                .status(ServiceKind::ClaudeCli)
                .unwrap()
                .executable_path,
            cli.to_string_lossy()
        );
        assert!(
            restored
                .start(ServiceKind::ClaudeCli, None)
                .unwrap()
                .running
        );
        restored.shutdown();
        assert!(restored
            .start(ServiceKind::ClaudeCli, Some("missing.cmd".into()))
            .is_err());
        assert!(!restored.status(ServiceKind::ClaudeCli).unwrap().running);
    }
}
