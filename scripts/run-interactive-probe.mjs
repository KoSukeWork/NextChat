// Development-only launcher. Inherit the terminal; do not pass a prompt,
// --print, SDK flags, or pipe stdin. Runtime application code never imports it.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const probe = JSON.parse(readFileSync(process.argv[2], "utf8"));
const url = new URL(probe.url);
if (
  url.protocol !== "http:" ||
  url.hostname !== "127.0.0.1" ||
  url.username ||
  url.password ||
  !probe.key.startsWith("nextchat-local-dummy-")
)
  throw new Error(
    "This development probe only supports its loopback dummy gateway",
  );
const executable = process.env.NEXTCHAT_CLAUDE_PATH || "claude";
const args = [
  "--model",
  "claude-sonnet-4-6",
  "--setting-sources",
  "",
  "--strict-mcp-config",
];
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(ANTHROPIC_|CLAUDE_|BUN_OPTIONS$|NODE_OPTIONS$)/i.test(key),
  ),
);
Object.assign(env, {
  ANTHROPIC_BASE_URL: probe.url,
  ANTHROPIC_API_KEY: probe.key,
  CLAUDE_CONFIG_DIR: join(probe.directory, "config"),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
});
const version = execFileSync(executable, ["--version"], {
  env,
  encoding: "utf8",
  windowsHide: true,
}).trim();
writeFileSync(
  join(probe.directory, "client.json"),
  JSON.stringify(
    {
      version,
      args,
      mode: "interactive",
      capturedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
const child = spawn(executable, args, {
  cwd: join(probe.directory, "workspace"),
  env,
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
