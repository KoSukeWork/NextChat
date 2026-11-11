import { execFile } from "node:child_process";

/** End the driver and its tools, not just the top-level CLI. */
export async function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      execFile(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 5000 },
        (error) => {
          if (error) child.kill();
          resolve();
        },
      );
    });
  } else {
    // Driver processes are started in their own process group on Unix.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  }
}
