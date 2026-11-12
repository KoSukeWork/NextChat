use std::io::{self, Read};
use std::process::Command;
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--child-sleeper") {
        std::thread::sleep(Duration::from_secs(60));
        return;
    }
    if args.iter().any(|arg| arg == "--version") {
        println!("1.2.3 (Claude Code)");
        return;
    }
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    if input.contains("slow-request") {
        let mut command = Command::new(std::env::current_exe().unwrap());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = command.arg("--child-sleeper").spawn().unwrap();
        std::fs::write("fake-child.pid", child.id().to_string()).unwrap();
        println!("{{\"type\":\"stream_event\",\"event\":{{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"text_delta\",\"text\":\"started\"}}}}}}");
        std::thread::sleep(Duration::from_secs(60));
        return;
    }
    if input.contains("fail-request") {
        eprintln!("dummy-secret Bearer another-secret");
        println!("{{\"type\":\"result\",\"subtype\":\"error\",\"result\":\"dummy-secret\"}}");
        return;
    }
    if let Some(i) = args
        .iter()
        .position(|arg| arg == "--append-system-prompt-file")
    {
        assert!(std::fs::read_to_string(&args[i + 1])
            .unwrap()
            .contains("system instructions"));
    }
    assert_eq!(std::env::var("ANTHROPIC_API_KEY").unwrap(), "dummy-secret");
    if input.contains("events-request") {
        for event in [
            r#"{"type":"stream_event","event":{"type":"message_start"}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"think"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"before"}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"before"},{"type":"tool_use","id":"t","name":"probe","input":{"x":1}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}}"#,
            r#"{"type":"stream_event","event":{"type":"message_start"}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"after"}}}"#,
            r#"{"type":"result","subtype":"success"}"#,
        ] {
            println!("{event}");
        }
        return;
    }
    let reply = if args.iter().any(|arg| arg == "--resume") {
        "resumed"
    } else {
        "reply"
    };
    println!("{{\"type\":\"stream_event\",\"event\":{{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"text_delta\",\"text\":\"{reply}\"}}}}}}");
    println!("{{\"type\":\"result\",\"subtype\":\"success\"}}");
}
