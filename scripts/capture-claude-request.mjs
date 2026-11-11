// A local-only CLI probe. Uses dummy credentials and an isolated configuration.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "nextchat-claude-probe-"));
const captures = [];
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  captures.push({ path: req.url, headers: req.headers, body });
  if (req.url.includes("count_tokens")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ input_tokens: 10 }));
  }
  const message = {
    id: "msg_probe",
    type: "message",
    role: "assistant",
    model: body.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        ...message,
        content: [{ type: "text", text: "Probe OK" }],
        stop_reason: "end_turn",
      }),
    );
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "message_start", message },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Probe OK" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ])
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(ANTHROPIC_|CLAUDE_)/i.test(key),
  ),
);
Object.assign(env, {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  ANTHROPIC_API_KEY: "nextchat-probe-dummy",
  CLAUDE_CONFIG_DIR: join(directory, "config"),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
});
const child = spawn(
  process.env.NEXTCHAT_CLAUDE_PATH || "claude",
  [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    "claude-sonnet-4-6",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
  ],
  { cwd: directory, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
let output = "",
  errors = "";
child.stdout.on("data", (data) => (output += data));
child.stderr.on("data", (data) => (errors += data));
child.stdin.end("Reply Probe OK.");
const timeout = setTimeout(() => child.kill(), 45000);
try {
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const target = resolve(process.argv[2] || ".next/claude-probe.json");
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(
    target,
    JSON.stringify({ code, captures, output, errors }, null, 2),
  );
  console.log(
    JSON.stringify({
      code,
      target,
      requests: captures.map(({ path, headers, body }) => ({
        path,
        headers,
        keys: Object.keys(body),
        systemStart: body.system?.[0],
        toolCount: body.tools?.length,
      })),
      errors,
    }),
  );
} finally {
  clearTimeout(timeout);
  server.closeAllConnections();
  server.close();
}
