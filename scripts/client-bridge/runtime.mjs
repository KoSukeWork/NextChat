import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

async function identity(executable) {
  const candidates =
    isAbsolute(executable) || /[\\/]/.test(executable)
      ? [resolve(executable)]
      : (process.env.PATH || "")
          .split(delimiter)
          .flatMap((directory) =>
            process.platform === "win32" && !executable.endsWith(".exe")
              ? [
                  join(directory, `${executable}.exe`),
                  join(directory, executable),
                ]
              : [join(directory, executable)],
          );
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      const value = await stat(path, { bigint: true });
      if (value.isFile())
        return `${path}:${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
    } catch {}
  }
  throw new Error("Cannot find the configured Claude Code executable");
}

export function probeVersion(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Claude Code version check timed out"));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      if (text.length < 10000) text += chunk;
    });
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Cannot start the configured Claude Code executable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const version = /^(\d+\.\d+\.\d+)\s+\(Claude Code\)/m.exec(text)?.[1];
      code === 0 && version
        ? resolve(version)
        : reject(
            new Error(
              "Configured executable did not report a Claude Code version",
            ),
          );
    });
  });
}

/** File identity, not a timer, invalidates the cache when the CLI updater replaces it. */
export function createRuntimeInspector(probe = probeVersion) {
  const cache = new Map();
  return async (executable, signal) => {
    signal?.throwIfAborted();
    const key = await identity(executable);
    let entry = cache.get(executable);
    if (entry?.key !== key) {
      entry = { key, promise: probe(executable) };
      cache.set(executable, entry);
      entry.promise.catch(() => {
        if (cache.get(executable) === entry) cache.delete(executable);
      });
    }
    let abort;
    try {
      return await (signal
        ? Promise.race([
            entry.promise,
            new Promise((_, reject) => {
              abort = () =>
                reject(
                  signal.reason || new Error("Claude Code request cancelled"),
                );
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            }),
          ])
        : entry.promise);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  };
}
