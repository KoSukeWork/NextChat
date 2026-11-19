import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (
  !args.includes("acp") ||
  !args.includes("--disable-telemetry") ||
  !args.includes("--include-default-customizations=false") ||
  !args.includes("--gemini-dir") ||
  !args.includes("--agent") ||
  args.includes("--dangerously-skip-permissions") ||
  args.includes("--ide-mcp-port")
)
  process.exit(2);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const options = [
  {
    id: "model",
    currentValue: "test-model",
    options: [{ value: "test-model", name: "Test" }],
  },
  {
    id: "thought_level",
    currentValue: "medium",
    options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
  },
];
const models = {
  availableModels: [
    { modelId: "test-model-low", name: "Test Low" },
    { modelId: "test-model-high", name: "Test High" },
  ],
  currentModelId: "test-model-low",
};
let mcpServers = [],
  activeProxy,
  sessionId = "session-1",
  resumed = false,
  pending = new Map();
let next = 100;
const notification = (update) =>
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
function request(method, params) {
  const id = ++next;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}
async function connectProxy(server) {
  const env = {
    ...process.env,
    ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
  };
  const child = spawn(server.command, server.args, {
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const replies = new Map();
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    replies.get(value.id)?.(value);
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const current = ++id;
      replies.set(current, resolve);
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n",
      );
    });
  await rpc("server/discover", {});
  await rpc("initialize", { protocolVersion: "2025-03-26" });
  const tools = await rpc("tools/list", {});
  if (
    !tools.result.tools.some(
      (tool) => tool.name === "probe" && tool._meta?.["antigravity/alwaysLoad"],
    )
  )
    throw new Error("Missing tool");
  return {
    call: () => rpc("tools/call", { name: "probe", arguments: { value: 42 } }),
    close: () => {
      child.stdin.end();
      lines.close();
    },
  };
}
async function handle(message) {
  if (!message.method) {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.id === undefined) return;
  let result = {};
  if (message.method === "initialize")
    result = {
      protocolVersion: 1,
      agentCapabilities: {
        _meta: { antigravity: { systemPrompt: { append: true } } },
        sessionCapabilities: { resume: {} },
      },
    };
  else if (
    message.method === "session/new" ||
    message.method === "session/resume"
  ) {
    if (message.method === "session/resume" && existsSync(".resume-error")) {
      const mode = readFileSync(".resume-error", "utf8");
      send({
        jsonrpc: "2.0",
        id: message.id,
        error:
          mode === "unsupported"
            ? { code: -32601, message: "Method not found" }
            : { code: -32000, message: "Google rejected the request" },
      });
      return;
    }
    mcpServers = message.params.mcpServers;
    if (mcpServers.length) activeProxy = await connectProxy(mcpServers[0]);
    if (
      message.params._meta &&
      message.params._meta.antigravity?.systemPrompt?.append !==
        "unchanged system"
    )
      throw new Error("system prompt changed");
    resumed = message.method === "session/resume";
    sessionId = message.params.sessionId || "session-1";
    result = { sessionId, models, configOptions: options };
  } else if (message.method === "session/set_config_option") {
    const option = options.find((item) => item.id === message.params.configId);
    option.currentValue = message.params.value;
    result = { configOptions: options };
  } else if (message.method === "session/prompt") {
    const prompt = message.params.prompt
      .map((item) => item.text || "")
      .join("");
    if (prompt.includes("resume-unsupported init"))
      writeFileSync(".resume-error", "unsupported");
    if (prompt.includes("resume-denied init"))
      writeFileSync(".resume-error", "denied");
    if (prompt.includes("emit error")) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "failed Bearer another-secret" },
      });
      return;
    }
    if (prompt.includes("login-needed")) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "You are not logged into Antigravity" },
      });
      return;
    }
    if (prompt.includes("auxiliary-login-warning")) {
      process.stderr.write("background: not logged into Antigravity\n");
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "Google rejected the request" },
      });
      return;
    }
    if (prompt.includes("stall")) {
      writeFileSync("fake-agy.pid", String(process.pid));
      return;
    }
    if (prompt.includes("try builtin")) {
      const decision = await request("session/request_permission", {
        sessionId,
        toolCall: { title: "run_command" },
        options: [
          { kind: "allow_once", optionId: "yes" },
          { kind: "reject_once", optionId: "no" },
        ],
      });
      if (decision.outcome?.optionId !== "no")
        throw new Error("Built-in permission was not rejected");
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "denied" },
      });
    } else if (prompt.includes("use tool")) {
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "before" },
      });
      notification({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "mcp(nextchat/probe)",
        rawInput: { value: 42 },
      });
      const decision = await request("session/request_permission", {
        sessionId,
        toolCall: { name: "mcp(nextchat/probe)" },
        options: [
          { kind: "allow_once", optionId: "yes" },
          { kind: "reject_once", optionId: "no" },
        ],
      });
      if (decision.outcome?.optionId !== "yes")
        throw new Error("Tool permission rejected");
      const reply = await activeProxy.call();
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: reply.result.content[0].text,
      });
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "after" },
      });
    } else
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: resumed ? "resumed" : "reply" },
      });
    result = { stopReason: "end_turn" };
  } else if (message.method === "session/close") activeProxy?.close();
  send({ jsonrpc: "2.0", id: message.id, result });
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on(
  "line",
  (line) => {
    void handle(JSON.parse(line)).catch(() => process.exit(3));
  },
);
