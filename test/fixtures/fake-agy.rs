use std::process::{Command, Stdio};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|value| value == "--version") {
        println!("1.5.11");
        return;
    }
    let mut child = Command::new(std::env::var("NEXTCHAT_TEST_AGY_NODE").unwrap());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        child.creation_flags(0x08000000);
    }
    let status = child
        .arg(std::env::var("NEXTCHAT_TEST_AGY_SCRIPT").unwrap())
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .unwrap();
    std::process::exit(status.code().unwrap_or(1));
}
