use super::*;
use serde_json::{json, Value};
use std::sync::mpsc::{self, Receiver};

static NEXT_TEST: AtomicU64 = AtomicU64::new(1);

#[test]
fn config_directory_defaults_to_native_path_and_rejects_relative_overrides() {
    let default = std::env::temp_dir().join("default-mcp");
    let isolated = std::env::temp_dir().join("isolated-mcp");
    assert_eq!(config_directory(&default, None).unwrap(), default);
    assert_eq!(config_directory(&default, Some(isolated.clone().into_os_string())).unwrap(), isolated);
    assert!(config_directory(&default, Some("relative".into())).is_err());
}
struct Fixture {
    state: Arc<McpState>,
    directory: PathBuf,
}

#[test]
fn oauth_credentials_are_separate_and_removed_when_the_server_changes() {
    let fixture = Fixture::new();
    let mut config: McpConfig = serde_json::from_value(json!({"mcpServers": {"remote": {
        "url": "http://127.0.0.1:45670/mcp"
    }}})).unwrap();
    fixture.state.write_config(config.clone(), |_| true).unwrap();
    let url = "http://127.0.0.1:45670/mcp";
    let credentials = json!({"serverUrl": url, "redirectUri": "http://127.0.0.1:45671/callback", "tokens": {"access_token": "synthetic"}});
    fixture.state.write_oauth("remote", url, credentials.clone()).unwrap();
    assert_eq!(fixture.state.read_oauth("remote", url).unwrap(), Some(credentials.clone()));
    assert!(!fs::read_to_string(&fixture.state.config_path).unwrap().contains("synthetic"));
    assert_eq!(fixture.state.read_oauth("remote", "http://127.0.0.1:45670/other").unwrap(), None);
    config.mcp_servers.get_mut("remote").unwrap().status = Some(ServerStatus::Paused);
    fixture.state.write_config(config.clone(), |_| true).unwrap();
    assert_eq!(fixture.state.read_oauth("remote", url).unwrap(), Some(credentials.clone()));
    assert!(fixture.state.write_oauth("remote", url, credentials.clone()).is_err());
    config.mcp_servers.get_mut("remote").unwrap().status = Some(ServerStatus::Active);
    config.mcp_servers.get_mut("remote").unwrap().url = Some("http://127.0.0.1:45670/other".into());
    fixture.state.write_config(config, |_| true).unwrap();
    assert!(!fs::read_to_string(fixture.state.oauth_path()).unwrap().contains("synthetic"));
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "nextchat mcp test {} {}",
            std::process::id(),
            NEXT_TEST.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("server.cjs"),
            include_str!("../../test/fixtures/mcp-server.cjs"),
        )
        .unwrap();
        Self {
            state: Arc::new(McpState::new(directory.join("mcp_config.json"))),
            directory,
        }
    }
    fn config(&self) -> McpConfig {
        serde_json::from_value(json!({"mcpServers": {"fixture": {
            "command": "node", "args": [self.directory.join("server.cjs")], "env": {"MCP_EXPLICIT": "approved"}
        }}})).unwrap()
    }
    fn start(&self) -> (u64, Receiver<(String, ProcessEvent)>) {
        let (sender, receiver) = mpsc::channel();
        let run = self
            .state
            .spawn(
                "fixture",
                Arc::new(move |name, event| {
                    let _ = sender.send((name.into(), event));
                }),
            )
            .unwrap();
        (run, receiver)
    }
    fn request(
        &self,
        run: u64,
        receiver: &Receiver<(String, ProcessEvent)>,
        method: &str,
    ) -> Value {
        self.state
            .send(
                "fixture",
                run,
                &json!({"jsonrpc":"2.0","id":1,"method":method,"params":{"message":"hello 世界"}})
                    .to_string(),
            )
            .unwrap();
        loop {
            let (name, event) = receiver.recv_timeout(Duration::from_secs(10)).unwrap();
            if name == "mcp://stderr" {
                eprintln!("{}", event.line.as_deref().unwrap_or(""));
            }
            if name == "mcp://message" {
                assert_eq!(event.run_id, run);
                return serde_json::from_str(&event.line.unwrap()).unwrap();
            }
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.state.kill_all();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn approval_precedes_persistence_and_only_execution_changes_prompt() {
    let fixture = Fixture::new();
    let mut config = fixture.config();
    assert!(fixture
        .state
        .write_config(config.clone(), |message| {
            assert!(message.contains("node"));
            assert!(message.contains("MCP_EXPLICIT"));
            false
        })
        .is_err());
    assert!(!fixture.state.config_path.exists());
    fixture
        .state
        .write_config(config.clone(), |_| true)
        .unwrap();
    config.mcp_servers.get_mut("fixture").unwrap().status = Some(ServerStatus::Paused);
    fixture
        .state
        .write_config(config.clone(), |_| panic!("status-only edit prompted"))
        .unwrap();
    for field in ["command", "args", "env"] {
        let mut changed = config.clone();
        let server = changed.mcp_servers.get_mut("fixture").unwrap();
        match field {
            "command" => server.command = "other".into(),
            "args" => server.args.push("extra".into()),
            _ => {
                server.env.insert("NEW".into(), "value".into());
            }
        }
        assert!(fixture.state.write_config(changed, |_| false).is_err());
        assert_eq!(fixture.state.read_config().unwrap(), config);
    }
    assert!(fixture
        .state
        .spawn("fixture", Arc::new(|_, _| {}))
        .unwrap_err()
        .contains("paused"));
    assert!(fixture.state.spawn("unknown", Arc::new(|_, _| {})).is_err());
    fixture
        .state
        .write_config(McpConfig::default(), |_| panic!("removal prompted"))
        .unwrap();
}

#[test]
fn node_roundtrip_environment_replacement_and_lifecycle() {
    let fixture = Fixture::new();
    // A parent-only variable must not reach the server.
    std::env::set_var("NEXTCHAT_MCP_TEST_PRIVATE", "must-not-inherit");
    fixture
        .state
        .write_config(fixture.config(), |_| true)
        .unwrap();
    let (run, receiver) = fixture.start();
    let response = fixture.request(run, &receiver, "echo");
    assert_eq!(response["result"]["echo"]["message"], "hello 世界");
    assert_eq!(response["result"]["env"]["MCP_EXPLICIT"], "approved");
    assert!(response["result"]["env"]
        .get("NEXTCHAT_MCP_TEST_PRIVATE")
        .is_none());
    assert!(fixture.state.send("fixture", run, "one\ntwo").is_err());
    let (replacement, replacement_rx) = fixture.start();
    assert_ne!(run, replacement);
    assert!(fixture.state.send("fixture", run, "{}").is_err());
    fixture.state.kill("fixture", Some(run)).unwrap(); // stale close cannot kill replacement
    assert_eq!(
        fixture.request(replacement, &replacement_rx, "tools/list")["result"]["tools"][0]["name"],
        "echo"
    );
    let mut paused = fixture.config();
    paused.mcp_servers.get_mut("fixture").unwrap().status = Some(ServerStatus::Paused);
    fixture
        .state
        .write_config(paused, |_| panic!("pause prompted"))
        .unwrap();
    assert!(fixture.state.processes.lock().unwrap().is_empty());
    fixture
        .state
        .write_config(fixture.config(), |_| true)
        .unwrap();
    let (run, receiver) = fixture.start();
    fixture
        .state
        .send("fixture", run, r#"{"method":"exit"}"#)
        .unwrap();
    let (name, event) = receiver.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(name, "mcp://exit");
    assert_eq!(event.code, Some(0));
    fixture.start();
    fixture
        .state
        .write_config(McpConfig::default(), |_| true)
        .unwrap();
    assert!(fixture.state.processes.lock().unwrap().is_empty());
}

#[test]
fn invalid_config_never_runs_and_kill_all_cleans_up() {
    let fixture = Fixture::new();
    fs::write(&fixture.state.config_path, "invalid").unwrap();
    assert!(fixture.state.read_config().is_err());
    assert!(fixture.state.spawn("fixture", Arc::new(|_, _| {})).is_err());
    fs::remove_file(&fixture.state.config_path).unwrap();
    let mut config = fixture.config();
    config
        .mcp_servers
        .insert("second".into(), config.mcp_servers["fixture"].clone());
    fixture.state.write_config(config, |_| true).unwrap();
    fixture.start();
    fixture.state.spawn("second", Arc::new(|_, _| {})).unwrap();
    fixture.state.kill_all();
    assert!(fixture.state.processes.lock().unwrap().is_empty());
}

#[test]
fn remote_configuration_is_validated_and_approval_hides_header_values() {
    let fixture = Fixture::new();
    let config: McpConfig = serde_json::from_value(json!({"mcpServers": {
        "remote": {"url": "https://example.test/mcp", "headers": {"Authorization": "Bearer private-token", "X-Key": "another-secret"}}
    }})).unwrap();
    assert!(fixture.state.write_config(config.clone(), |message| {
        assert!(message.contains("https://example.test/mcp"));
        assert!(message.contains("Authorization"));
        assert!(message.contains("X-Key"));
        assert!(!message.contains("private-token"));
        assert!(!message.contains("another-secret"));
        false
    }).is_err());
    assert!(!fixture.state.config_path.exists());
    fixture.state.write_config(config.clone(), |_| true).unwrap();
    assert!(fixture.state.spawn("remote", Arc::new(|_, _| {})).unwrap_err().contains("local"));
    let mut paused = config.clone();
    paused.mcp_servers.get_mut("remote").unwrap().status = Some(ServerStatus::Paused);
    fixture.state.write_config(paused, |_| panic!("status-only change prompted")).unwrap();
    for invalid in [
        json!({"url":"file:///etc/passwd"}),
        json!({"url":"https://example.test", "command":"node"}),
        json!({"url":"https://example.test", "headers":{"Bad Header":"value"}}),
    ] {
        let candidate: McpConfig = serde_json::from_value(json!({"mcpServers":{"bad":invalid}})).unwrap();
        assert!(fixture.state.write_config(candidate, |_| panic!("invalid config prompted")).is_err());
    }
}

#[test]
fn approval_text_uses_fixed_chinese_or_english_and_falls_back_to_english() {
    let fixture = Fixture::new();
    let config: McpConfig = serde_json::from_value(json!({"mcpServers": {
        "remote": {"url": "https://example.test/mcp", "headers": {"Authorization": "Bearer private-token"}},
        "local": {"command": "node", "args": ["server.js"]}
    }})).unwrap();
    for (language, title, label, approve, reject) in [
        ("cn", "允许 MCP 服务器连接？", "请求头名称", "允许", "拒绝"),
        ("en", "Allow MCP server connections?", "Request header names", "Allow", "Deny"),
        ("unknown", "Allow MCP server connections?", "Request header names", "Allow", "Deny"),
    ] {
        assert_eq!(mcp_dialog_text(language).title, title);
        assert_eq!(mcp_dialog_text(language).approve, approve);
        assert_eq!(mcp_dialog_text(language).reject, reject);
        assert!(fixture.state.write_config_localized(config.clone(), language, |message| {
            assert!(message.contains(label));
            assert!(message.contains("remote"));
            assert!(message.contains("https://example.test/mcp"));
            assert!(message.contains("Authorization"));
            assert!(message.contains("node"));
            assert!(!message.contains("private-token"));
            false
        }).is_err());
        assert!(!fixture.state.config_path.exists());
    }
}

#[cfg(windows)]
#[test]
fn windows_cmd_resolution_spaces_and_argument_escaping() {
    let fixture = Fixture::new();
    let node = resolve_command("node", &child_environment(&BTreeMap::new())).unwrap();
    // Also place an extensionless Unix shim first, as npm does for npx.
    fs::write(
        fixture.directory.join("mock-mcp"),
        "not a windows executable",
    )
    .unwrap();
    fs::write(
        fixture.directory.join("mock-mcp.cmd"),
        format!("@\"{}\" %*\r\n", node.display()),
    )
    .unwrap();
    let resolved =
        resolve_in_path("mock-mcp", fixture.directory.to_str().unwrap(), ".EXE;.CMD").unwrap();
    assert!(
        resolved.to_string_lossy().ends_with("mock-mcp.CMD")
            || resolved.to_string_lossy().ends_with("mock-mcp.cmd")
    );
    let mut config = fixture.config();
    let server = config.mcp_servers.get_mut("fixture").unwrap();
    server.command = resolved.to_string_lossy().into();
    server.args.extend([
        "argument with spaces".into(),
        "ampersand&literal".into(),
        "Unicode 世界".into(),
    ]);
    fixture.state.write_config(config, |_| true).unwrap();
    let (run, receiver) = fixture.start();
    let response = fixture.request(run, &receiver, "echo");
    assert_eq!(
        response["result"]["args"],
        json!(["argument with spaces", "ampersand&literal", "Unicode 世界"])
    );
    fixture.state.kill("fixture", Some(run)).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_job_kills_descendants() {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    let fixture = Fixture::new();
    fixture
        .state
        .write_config(fixture.config(), |_| true)
        .unwrap();
    let (run, receiver) = fixture.start();
    let pid = fixture.request(run, &receiver, "child")["result"]["pid"]
        .as_u64()
        .unwrap();
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid as u32);
        assert_ne!(handle, 0);
        fixture.state.kill_all();
        let wait = WaitForSingleObject(handle, 10000);
        CloseHandle(handle);
        assert_eq!(wait, 0, "descendant did not exit with the job");
    }
}
