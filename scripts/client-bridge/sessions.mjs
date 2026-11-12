import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  lstat,
  realpath,
  rm,
} from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";

const day = 86400000;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

export async function createSessionStore(
  dataDirectory,
  { maxSessions = 100, retentionMs = 7 * day } = {},
) {
  if (
    !Number.isInteger(maxSessions) ||
    maxSessions < 1 ||
    !Number.isFinite(retentionMs) ||
    retentionMs < 1
  )
    throw new Error("Invalid CLI session retention settings");
  await mkdir(dataDirectory, { recursive: true });
  const root = await realpath(dataDirectory);
  const remove = async (directory) => {
    const inside = relative(root, resolve(directory));
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw new Error("Unsafe session cleanup path");
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  };
  const ownedRoot = join(root, "managed-v2");
  await mkdir(ownedRoot, { recursive: true });
  if ((await lstat(ownedRoot)).isSymbolicLink())
    throw new Error("Session root must not be a symlink");
  for (const entry of await readdir(ownedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^run-[a-zA-Z0-9]+$/.test(entry.name))
      continue;
    const directory = join(ownedRoot, entry.name);
    try {
      const owner = JSON.parse(
        await readFile(join(directory, "owner.json"), "utf8"),
      );
      if (Number.isInteger(owner.pid) && owner.pid > 0 && !alive(owner.pid))
        await remove(directory);
    } catch {}
  }
  // Only legacy driver-owned hash directories are eligible, and only after all
  // their files have been inactive for the retention period. Never follow links.
  const stale = async (directory, cutoff) => {
    if ((await lstat(directory)).mtimeMs >= cutoff) return false;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) return false;
      const path = join(directory, entry.name);
      if (
        entry.isDirectory()
          ? !(await stale(path, cutoff))
          : (await lstat(path)).mtimeMs >= cutoff
      )
        return false;
    }
    return true;
  };
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) {
      const directory = join(root, entry.name);
      if (await stale(directory, Date.now() - retentionMs))
        await remove(directory);
    }
  }
  const instance = await mkdtemp(join(ownedRoot, "run-"));
  await writeFile(
    join(instance, "owner.json"),
    JSON.stringify({ pid: process.pid }),
    { mode: 0o600 },
  );
  const sessions = new Map();
  const active = new Set();
  const discard = async (key) => {
    const session = sessions.get(key);
    sessions.delete(key);
    if (session) await remove(session.directory);
  };
  const sweep = async () => {
    const idle = [...sessions]
      .filter(([key]) => !active.has(key))
      .sort((a, b) => a[1].used - b[1].used);
    for (const [key, session] of idle)
      if (
        !active.has(key) &&
        (Date.now() - session.used > retentionMs || sessions.size > maxSessions)
      )
        await discard(key);
  };
  const timer = setInterval(
    () => {
      void sweep().catch(() => {});
    },
    Math.min(retentionMs, 3600000),
  );
  timer.unref();
  return {
    async begin(key, scope, history) {
      if (active.has(key))
        throw new Error(
          "This CLI conversation is already generating a response",
        );
      active.add(key);
      try {
        const previous = sessions.get(key);
        if (previous?.scope === scope && previous.history === history)
          return { ...previous, resume: true };
        await discard(key);
        return {
          directory: await mkdtemp(join(instance, "session-")),
          scope,
          resume: false,
        };
      } catch (error) {
        active.delete(key);
        throw error;
      }
    },
    async end(key, session, success) {
      try {
        if (success) sessions.set(key, { ...session, used: Date.now() });
        else {
          sessions.delete(key);
          await remove(session.directory);
        }
      } finally {
        active.delete(key);
      }
      await sweep();
    },
    async close() {
      clearInterval(timer);
      if (active.size) throw new Error("CLI sessions are still running");
      sessions.clear();
      await remove(instance);
    },
  };
}
