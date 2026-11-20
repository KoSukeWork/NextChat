import { spawn } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  lstat,
  unlink,
  rename,
  realpath,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { terminateProcessTree } from "../../scripts/client-bridge/process.mjs";

const blockedEnv =
  /^(ANTHROPIC_|CLAUDE_|NEXTCHAT_(?:BRIDGE|WIRE|SERVICE)_|BUN_OPTIONS$|NODE_OPTIONS$)/i;
export function cleanCliEnvironment() {
  const result = {};
  // Enumerate names first: never read the values of inherited Claude credentials.
  for (const name of Object.keys(process.env))
    if (!blockedEnv.test(name)) result[name] = process.env[name];
  return result;
}

export async function subscriptionStatus(executable, signal, cwd) {
  if (signal?.aborted) throw new Error("Claude Code request cancelled");
  const child = spawn(executable, ["auth", "status", "--json"], {
    cwd,
    env: {
      ...cleanCliEnvironment(),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    },
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  child.stdout.on("data", (part) => {
    if (output.length < 65536) output += part;
  });
  const abort = () => void terminateProcessTree(child);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 10000);
  try {
    const code = await new Promise((resolve) => {
      child.once("error", () => resolve(-1));
      child.once("close", resolve);
    });
    if (signal?.aborted) throw new Error("Claude Code request cancelled");
    if (code !== 0 && code !== 1) return "unknown";
    const status = JSON.parse(output);
    if (status.loggedIn === false) return "signed-out";
    if (
      status.loggedIn === true &&
      ["oauth_token", "oauth", "claude.ai"].includes(status.authMethod)
    )
      return "signed-in";
    return "unknown";
  } catch (error) {
    if (signal?.aborted) throw error;
    return "unknown";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    output = "";
  }
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};
// Multiple drivers can share a data directory in the same Node process.
// Serialize index operations and track all their active sessions together.
const registries = new Map();

/** Track only NextChat-generated IDs; never enumerate or remove other transcripts. */
export async function createOwnedSessions({
  dataDirectory,
  workDirectory,
  configRoot = join(homedir(), ".claude"),
  maxSessions = 100,
  retentionMs = 7 * 86400000,
}) {
  const indexPath = join(resolve(dataDirectory), "subscription-owned");
  await mkdir(indexPath, { recursive: true });
  if ((await lstat(indexPath)).isSymbolicLink())
    throw new Error("Invalid owned-session index");
  const index = await realpath(indexPath);
  const project = join(
    configRoot,
    "projects",
    (await realpath(workDirectory)).replace(/[^A-Za-z0-9]/g, "-"),
  );
  let state = registries.get(index);
  if (!state) {
    state = { active: new Set(), tail: Promise.resolve() };
    registries.set(index, state);
  }
  const owner = randomUUID();
  const locked = (operation) => {
    const result = state.tail.then(operation, operation);
    state.tail = result.catch(() => {});
    return result;
  };
  const writeRecord = async (record, create = false) => {
    if (create) {
      await writeFile(
        join(index, `${record.id}.json`),
        JSON.stringify(record),
        {
          mode: 0o600,
          flag: "wx",
        },
      );
      return;
    }
    const temporary = join(index, `record-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(record), {
      mode: 0o600,
      flag: "wx",
    });
    try {
      await rename(temporary, join(index, `${record.id}.json`));
    } finally {
      await unlink(temporary).catch(() => {});
    }
  };
  const readRecord = async (id) => {
    try {
      const path = join(index, `${id}.json`);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
        return undefined;
      const value = JSON.parse(await readFile(path, "utf8"));
      return value.id === id &&
        Number.isInteger(value.pid) &&
        value.pid > 0 &&
        Number.isFinite(value.used)
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  };
  const safeProject = async () => {
    try {
      for (const path of [configRoot, join(configRoot, "projects"), project]) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      }
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  };
  async function discard(id) {
    if (!uuid.test(id) || !(await safeProject())) return false;
    const transcript = join(project, `${id}.jsonl`);
    try {
      const stat = await lstat(transcript);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      await unlink(transcript);
    } catch (error) {
      if (error.code !== "ENOENT") return false;
    }
    await unlink(join(index, `${id}.json`)).catch(() => {});
    return true;
  }
  async function sweep() {
    const entries = await readdir(index, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      const id = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
      if (!entry.isFile() || !uuid.test(id)) continue;
      const record = await readRecord(id);
      if (record) records.push(record);
    }
    records.sort((a, b) => a.used - b.used);
    let remaining = records.length;
    for (const record of records) {
      if (Date.now() - record.used <= retentionMs && remaining <= maxSessions)
        continue;
      if (
        state.active.has(record.id) ||
        (record.pid !== process.pid && alive(record.pid))
      )
        continue;
      if (await discard(record.id)) remaining--;
    }
  }
  return {
    begin(id) {
      return locked(async () => {
        if (!uuid.test(id)) throw new Error("Invalid owned-session identity");
        if (state.active.has(id))
          throw new Error("Subscription session already active");
        const prior = await readRecord(id);
        if (prior && (prior.pid !== process.pid || prior.owner !== owner))
          throw new Error("Session identity is already owned");
        if (!prior) {
          try {
            await lstat(join(index, `${id}.json`));
            throw new Error("Invalid owned-session record");
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          try {
            await lstat(join(project, `${id}.jsonl`));
            throw new Error("Session identity already exists");
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        await writeRecord(
          { id, pid: process.pid, owner, used: Date.now() },
          !prior,
        );
        state.active.add(id);
      });
    },
    end(id) {
      return locked(async () => {
        const record = await readRecord(id);
        if (record && record.owner === owner)
          await writeRecord({ ...record, used: Date.now() });
        state.active.delete(id);
        await sweep();
      });
    },
    sweep: () => locked(sweep),
  };
}
