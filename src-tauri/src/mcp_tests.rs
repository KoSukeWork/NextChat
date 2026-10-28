use super::*;
use serde_json::{json, Value};
use std::sync::mpsc::{self, Receiver};

static NEXT_TEST: AtomicU64 = AtomicU64::new(1);
struct Fixture {
    state: Arc<McpState>,
    directory: PathBuf,
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
