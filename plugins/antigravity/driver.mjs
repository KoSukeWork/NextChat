import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionStore } from "../../scripts/client-bridge/sessions.mjs";
import { createRuntimeInspector } from "../../scripts/client-bridge/runtime.mjs";
import { terminateProcessTree } from "../../scripts/client-bridge/process.mjs";
import {
  AcpConnection,
  contentBlocks,
  promptBlocks,
  selectModel,
  supportedEffort,
  resumeUnavailable,
} from "./acp.mjs";

const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const historyHash = (messages) =>
  hash(
    messages.map(({ role, content }) => ({
      role,
      content:
        role === "assistant" && typeof content === "string"
          ? content.trim()
          : content,
    })),
  );
const agent =
  "---\nname: nextchat\ndescription: NextChat request agent\nmainAgent: true\nsubagent: false\ntools: []\ninheritMcp: false\ninheritCustomizations: false\n---\nUse only the tools supplied by NextChat.\n";
const proxy = fileURLToPath(new URL("./stdio-proxy.mjs", import.meta.url));
const cancelled = () => new Error("Antigravity request cancelled");
function redactDiagnostic(value, hostMcp) {
  let result = String(value).replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
  const secrets = [
    hostMcp?.config?.headers?.Authorization?.replace(/^Bearer /, ""),
    ...[
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ].map((key) => process.env[key]),
  ];
  for (const secret of secrets)
    if (typeof secret === "string" && secret.length >= 4)
      result = result.split(secret).join("[REDACTED]");
  return result.slice(0, 2000);
}

function probeVersion(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      if (output.length < 10000) output += chunk;
    });
    child.stderr.resume();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Antigravity version check timed out"));
    }, 10000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Cannot start Antigravity"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const version = /^(\d+\.\d+\.\d+)\s*$/m.exec(output)?.[1];
      if (code === 0 && version) resolve(version);
      else reject(new Error("Antigravity did not report a version"));
    });
  });
}

function permission(params, toolNames) {
  let name = "";
  // A title can contain a shell command chosen by the model. Only use the
  // server-reported tool name as permission identity.
  for (const value of [params?.toolCall?.name, params?.toolCall?.toolName]) {
    if (typeof value !== "string") continue;
    const found =
      /^(?:mcp\(nextchat\/([^()\s]+)\)|(?:mcp\s+)?"?nextchat\/([^()\s"]+)"?|mcp_nextchat_(\S+))$/.exec(
        value.trim().replace(/\?$/, ""),
      );
    if (found) {
      name = found[1] || found[2] || found[3];
      break;
    }
  }
  const allowed = name && toolNames.has(name);
  const option =
    (params?.options ?? []).find(
      (item) => item.kind === (allowed ? "allow_once" : "reject_once"),
    ) ||
    (!allowed &&
      (params?.options ?? []).find((item) => item.kind === "reject_always"));
  return {
    outcome: option
      ? { outcome: "selected", optionId: option.optionId }
      : { outcome: "cancelled" },
  };
}

function validate(input) {
  if (
    !input ||
    typeof input !== "object" ||
    !input.sessionId ||
    typeof input.sessionId !== "string" ||
    input.sessionId.length > 256 ||
    !input.model ||
    typeof input.model !== "string" ||
    input.model.length > 256
  )
    throw new Error("Invalid Antigravity request");
  if (!/^\d+\.\d+\.\d+$/.test(input.cliVersion || ""))
    throw new Error("An exact Antigravity version is required");
  if (
    !Array.isArray(input.messages) ||
    !input.messages.length ||
    input.messages.length > 2000 ||
    input.messages.at(-1)?.role !== "user"
  )
    throw new Error("Invalid Antigravity messages");
  if (
    input.messages.some(
      (m) =>
        !["system", "user", "assistant"].includes(m?.role) ||
        !(typeof m.content === "string" || Array.isArray(m.content)),
    )
  )
    throw new Error("Invalid Antigravity message");
  if (
    input.reasoningEffort &&
    !["minimal", "low", "medium", "high", "xhigh", "max"].includes(
      input.reasoningEffort,
    )
  )
    throw new Error("Invalid Antigravity thinking level");
}

async function prepareWorkspace(directory) {
  const work = join(directory, "work");
  const gemini = join(directory, "gemini");
  await mkdir(join(work, ".agents", "agents", "nextchat"), { recursive: true });
  await mkdir(gemini, { recursive: true });
  await writeFile(
    join(work, ".agents", "agents", "nextchat", "agent.md"),
    agent,
    { mode: 0o600 },
  );
  return { work, gemini };
}

function toolsConfig(hostMcp, readyPath) {
  if (!hostMcp) return [];
  const url = new URL(hostMcp.config.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port)
    throw new Error("Invalid host tool endpoint");
  const token = hostMcp.config.headers.Authorization.replace(/^Bearer /, "");
  return [
    {
      name: "nextchat",
      command: process.execPath,
      args: [proxy],
      env: [
        { name: "NEXTCHAT_MCP_URL", value: url.toString() },
        { name: "NEXTCHAT_MCP_TOKEN", value: token },
        { name: "NEXTCHAT_MCP_READY", value: readyPath },
      ],
    },
  ];
}

async function openAcp(
  executable,
  directory,
  { signal, hostMcp, readyPath, emit = async () => {} },
) {
  signal?.throwIfAborted();
  const { work, gemini } = await prepareWorkspace(directory);
  const child = spawn(
    executable,
    [
      "acp",
      "--agent",
      "nextchat",
      "--disable-telemetry",
      "--include-default-customizations=false",
      "--gemini-dir",
      gemini,
      "--log-file",
      join(directory, "agy.log"),
    ],
    {
      cwd: work,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    },
  );
  child.stderr.resume();
  const names = new Set((hostMcp?.tools ?? []).map((tool) => tool.name));
  let eventQueue = Promise.resolve();
  let sessionId = "";
  const toolCalls = new Set();
  let text = "";
  let separateText = false;
  const conn = new AcpConnection(child, {
    onRequest: (method, params) => {
      if (
        method !== "session/request_permission" ||
        (params?.sessionId && params.sessionId !== sessionId)
      )
        throw new Error("Unsupported ACP request");
      return permission(params, names);
    },
    onUpdate: (method, params) => {
      if (method !== "session/update" || params?.sessionId !== sessionId)
        return;
      const update = params.update ?? {};
      let event;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text"
      ) {
        const chunk = update.content.text || "";
        const separator =
          chunk && separateText && text && !text.endsWith("\n\n")
            ? text.endsWith("\n")
              ? "\n"
              : "\n\n"
            : "";
        if (chunk) separateText = false;
        text += separator + chunk;
        event = { type: "text", text: separator + chunk };
      } else if (
        update.sessionUpdate === "agent_thought_chunk" &&
        update.content?.type === "text"
      )
        event = { type: "thinking", text: update.content.text || "" };
      else if (
        update.sessionUpdate === "tool_call" &&
        typeof update.toolCallId === "string"
      ) {
        toolCalls.add(update.toolCallId);
        separateText = !!text;
        event = {
          type: "tool_start",
          id: update.toolCallId,
          name: update.name || update.title || "tool",
          input: update.rawInput ?? {},
        };
      } else if (
        update.sessionUpdate === "tool_call_update" &&
        toolCalls.has(update.toolCallId) &&
        ["completed", "failed"].includes(update.status)
      ) {
        toolCalls.delete(update.toolCallId);
        event = {
          type: "tool_end",
          id: update.toolCallId,
          content:
            typeof update.rawOutput === "string"
              ? update.rawOutput
              : JSON.stringify(update.rawOutput ?? update.content ?? ""),
          isError: update.status === "failed",
        };
      }
      if (event) eventQueue = eventQueue.then(() => emit(event));
    },
  });
  const abort = () => {
    if (sessionId) {
      try {
        conn.notify("session/cancel", { sessionId });
      } catch {}
    }
    void terminateProcessTree(child);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const initialized = await conn.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "NextChat", version: "2.16.1" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    signal?.throwIfAborted();
    return {
      conn,
      work,
      initialized,
      mcpServers: toolsConfig(hostMcp, readyPath),
      setSession(id) {
        sessionId = id;
      },
      getText() {
        return text;
      },
      flush() {
        return eventQueue;
      },
      async close() {
        signal?.removeEventListener("abort", abort);
        conn.close();
        await terminateProcessTree(child);
      },
    };
  } catch (error) {
    signal?.removeEventListener("abort", abort);
    conn.close();
    await terminateProcessTree(child);
    throw error;
  }
}

async function applyModel(conn, sessionId, session, model, effort) {
  if (
    !(session.models?.availableModels ?? []).some(
      (item) => item.modelId === model,
    )
  )
    throw new Error("The selected model is not offered by Antigravity");
  let options = session.configOptions ?? [];
  const selection = selectModel(options, model, effort);
  if (
    options.some(
      (item) =>
        item.id === "model" &&
        (item.options ?? []).some((choice) => choice.value === selection.model),
    )
  ) {
    const updated = await conn.request("session/set_config_option", {
      sessionId,
      configId: "model",
      value: selection.model,
    });
    options = updated?.configOptions ?? options;
    const thought = options.find((item) => item.id === "thought_level");
    const effort = supportedEffort(
      selection.effort,
      (thought?.options ?? []).map((choice) => choice.value),
    );
    if (effort)
      await conn.request("session/set_config_option", {
        sessionId,
        configId: "thought_level",
        value: effort,
      });
  } else await conn.request("session/set_model", { sessionId, modelId: model });
}

// The underlying driver remains available to the controlled test harness, but
// the registered bridge must not run agy until tool isolation is verified.
export async function createDriver(options = {}) {
  const driver = await createUnverifiedDriver(options);
  const unavailable = async () => {
    throw new Error(
      "Antigravity 暂不可用：工具隔离尚未验证 / Antigravity is unavailable until tool isolation is verified",
    );
  };
  return { ...driver, models: unavailable, chat: unavailable };
}

export async function createUnverifiedDriver(options = {}) {
  const local =
    process.env.LOCALAPPDATA &&
    join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe");
  const executable =
    options.executable ||
    process.env.NEXTCHAT_AGY_PATH ||
    (local && existsSync(local) ? local : "agy");
  const directory = resolve(
    options.dataDirectory || join(tmpdir(), "nextchat-agy-data"),
  );
  await mkdir(directory, { recursive: true });
  const sessions = await createSessionStore(directory, options);
  const version = createRuntimeInspector(probeVersion);
  let modelCache;
  async function checkVersion(expected, signal) {
    let actual;
    try {
      actual = await version(executable, signal);
    } catch (error) {
      throw new Error(`Antigravity is unavailable: ${error.message}`);
    }
    if (expected && actual !== expected)
      throw new Error(
        `Antigravity version mismatch: requested ${expected}, installed ${actual}`,
      );
    return actual;
  }
  return {
    id: "antigravity",
    close: () => sessions.close(),
    async info() {
      try {
        return { sdkVersion: 1, versions: [await checkVersion()] };
      } catch {
        return { sdkVersion: 1, versions: [] };
      }
    },
    async models({ cliVersion }, { signal } = {}) {
      if (!/^\d+\.\d+\.\d+$/.test(cliVersion || ""))
        throw new Error("An exact Antigravity version is required");
      const actual = await checkVersion(cliVersion, signal);
      if (
        modelCache?.version === actual &&
        Date.now() - modelCache.time < 60000
      )
        return modelCache.models;
      const temp = await mkdtemp(join(directory, "models-"));
      let session;
      try {
        session = await openAcp(executable, temp, { signal });
        const result = await session.conn.request("session/new", {
          cwd: session.work,
          mcpServers: [],
        });
        if (
          !result?.sessionId ||
          !Array.isArray(result.models?.availableModels)
        )
          throw new Error("Antigravity did not return a model list");
        session.setSession(result.sessionId);
        const models = result.models.availableModels
          .filter((item) => typeof item.modelId === "string")
          .map((item) => ({
            id: item.modelId,
            display_name: item.name || item.modelId,
          }));
        try {
          await session.conn.request(
            "session/close",
            { sessionId: result.sessionId },
            2000,
          );
        } catch {}
        modelCache = { version: actual, time: Date.now(), models };
        return models;
      } finally {
        await session?.close();
        await rm(temp, { recursive: true, force: true });
      }
    },
    async chat(input, { signal, emit, hostMcp }) {
      validate(input);
      signal.throwIfAborted();
      const actual = await checkVersion(input.cliVersion, signal);
      const systems = input.messages
        .filter((message) => message.role === "system")
        .map((message) =>
          contentBlocks(message.content)
            .map((block) => {
              if (block.type !== "text")
                throw new Error("System prompts must contain text");
              return block.text;
            })
            .join("\n"),
        )
        .join("\n\n");
      const messages = input.messages.filter(
        (message) => message.role !== "system",
      );
      const key = hash(input.sessionId);
      const scope = hash([
        actual,
        input.model,
        input.reasoningEffort,
        systems,
        !!input.enableTools,
        hostMcp?.tools,
      ]);
      const stored = await sessions.begin(
        key,
        scope,
        historyHash(messages.slice(0, -1)),
      );
      let acp,
        requestDir,
        committed = false;
      try {
        requestDir = await mkdtemp(join(stored.directory, "request-"));
        const readyPath = join(requestDir, "mcp-ready");
        acp = await openAcp(executable, stored.directory, {
          signal,
          hostMcp: input.enableTools ? hostMcp : undefined,
          readyPath,
          emit,
        });
        if (
          systems &&
          !acp.initialized?.agentCapabilities?._meta?.antigravity?.systemPrompt
            ?.append
        )
          throw new Error(
            "This Antigravity version cannot append the system prompt",
          );
        const params = {
          cwd: acp.work,
          mcpServers: acp.mcpServers,
          ...(systems
            ? { _meta: { antigravity: { systemPrompt: { append: systems } } } }
            : {}),
        };
        let session,
          resume = false;
        if (stored.resume && stored.id) {
          try {
            session = await acp.conn.request("session/resume", {
              ...params,
              sessionId: stored.id,
            });
            if (!session || typeof session !== "object")
              throw new Error(
                "Antigravity returned an invalid resume response",
              );
            resume = true;
          } catch (error) {
            signal.throwIfAborted();
            if (!resumeUnavailable(error)) throw error;
            session = undefined;
          }
        }
        if (!resume) session = await acp.conn.request("session/new", params);
        const sessionId = resume ? stored.id : session?.sessionId;
        if (!sessionId) throw new Error("Antigravity did not create a session");
        acp.setSession(sessionId);
        await applyModel(
          acp.conn,
          sessionId,
          session,
          input.model,
          input.reasoningEffort,
        );
        if (acp.mcpServers.length) {
          const end = Date.now() + 5000;
          while (!existsSync(readyPath) && Date.now() < end) {
            signal.throwIfAborted();
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (!existsSync(readyPath))
            throw new Error(
              "Antigravity did not initialize the NextChat tool server",
            );
        }
        signal.throwIfAborted();
        const result = await acp.conn.request(
          "session/prompt",
          { sessionId, prompt: promptBlocks(messages, resume) },
          0,
        );
        await acp.flush();
        if (signal.aborted || result?.stopReason === "cancelled")
          throw cancelled();
        stored.id = sessionId;
        stored.history = historyHash([
          ...messages,
          { role: "assistant", content: acp.getText() },
        ]);
        committed = true;
        await emit({ type: "done", sessionId });
      } catch (error) {
        if (signal.aborted) throw cancelled();
        const message = redactDiagnostic(
          error?.message || "Antigravity request failed",
          hostMcp,
        );
        if (/not logged into Antigravity/i.test(message))
          throw new Error("请先运行 agy 完成登录 / Run agy and sign in first");
        throw new Error(message);
      } finally {
        await acp?.close();
        if (requestDir) await rm(requestDir, { recursive: true, force: true });
        await sessions.end(key, stored, committed);
      }
    },
  };
}
