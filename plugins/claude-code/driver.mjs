import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { terminateProcessTree } from "../../scripts/client-bridge/process.mjs";
import { createRuntimeInspector } from "../../scripts/client-bridge/runtime.mjs";
import { createSessionStore } from "../../scripts/client-bridge/sessions.mjs";

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
const abortError = () => new Error("Claude Code request cancelled");

function validate(input) {
  if (!/^\d+\.\d+\.\d+$/.test(input.cliVersion || ""))
    throw new Error("An exact CLI version is required");
  if (
    typeof input.model !== "string" ||
    !input.model ||
    input.model.length > 256
  )
    throw new Error("Invalid model");
  if (
    typeof input.sessionId !== "string" ||
    input.sessionId.length > 256 ||
    !input.sessionId
  )
    throw new Error("Invalid session identity");
  if (
    !Array.isArray(input.messages) ||
    !input.messages.length ||
    input.messages.length > 2000
  )
    throw new Error("Invalid messages");
  for (const m of input.messages) {
    if (
      !["system", "user", "assistant"].includes(m?.role) ||
      !(typeof m.content === "string" || Array.isArray(m.content))
    )
      throw new Error("Invalid message");
  }
  if (input.messages.at(-1).role !== "user")
    throw new Error("The last message must be a user message");
  const target = new URL(input.endpoint?.baseUrl);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error("Use a plain HTTP(S) gateway base URL");
  if (typeof input.endpoint.apiKey !== "string" || !input.endpoint.apiKey)
    throw new Error("Gateway API key is required");
  if (!["api-key", "bearer"].includes(input.authType))
    throw new Error("Invalid gateway authentication");
  if (
    input.betas !== undefined &&
    (!Array.isArray(input.betas) ||
      input.betas.length > 30 ||
      input.betas.some((b) => typeof b !== "string" || !/^[a-z0-9-]+$/.test(b)))
  )
    throw new Error("Invalid beta flags");
  if (
    input.reasoningEffort &&
    !["low", "medium", "high", "xhigh", "max"].includes(input.reasoningEffort)
  )
    throw new Error(
      "CLI reasoning effort must be low, medium, high, xhigh or max",
    );
}

function contentBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) => {
    if (part.type === "text" && typeof part.text === "string") return part;
    const match =
      /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(
        part.image_url?.url || "",
      );
    if (part.type === "image_url" && match)
      return {
        type: "image",
        source: { type: "base64", media_type: match[1], data: match[2] },
      };
    throw new Error("CLI images must be embedded as data URLs");
  });
}

/** Convert first-use/imported context to a single CLI user turn. Subsequent
 * unchanged histories resume native CLI sessions, including signed thinking. */
function firstTurn(messages) {
  if (messages.length === 1) return contentBlocks(messages[0].content);
  return messages.flatMap((message, index) => [
    {
      type: "text",
      text:
        index === messages.length - 1
          ? "\nCurrent user message:\n"
          : `\nPrevious ${message.role} message:\n`,
    },
    ...contentBlocks(message.content),
  ]);
}

export async function createDriver(options = {}) {
  const workingDirectory = options.workingDirectory
    ? resolve(options.workingDirectory)
    : await mkdtemp(join(tmpdir(), "nextchat-cli-work-"));
  const dataDirectory = resolve(
    options.dataDirectory || join(tmpdir(), "nextchat-cli-data"),
  );
  await mkdir(workingDirectory, { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  const runtimes = options.runtimes || {};
  const fallback =
    options.executable || process.env.NEXTCHAT_CLAUDE_PATH || "claude";
  const sessions = await createSessionStore(dataDirectory, options);
  const cliVersion = createRuntimeInspector();
  return {
    id: "claude-code",
    close: () => sessions.close(),
    async info() {
      const versions = await Promise.all(
        Object.entries(runtimes).map(async ([expected, path]) => {
          const actual = await cliVersion(path);
          if (actual !== expected)
            throw new Error("Configured CLI runtime version mismatch");
          return actual;
        }),
      );
      if (!versions.length) versions.push(await cliVersion(fallback));
      return { sdkVersion: 1, versions };
    },
    async chat(input, { signal, emit, hostMcp, settings = {} }) {
      validate(input);
      if (signal.aborted) throw abortError();
      const executable = runtimes[input.cliVersion] || fallback;
      const actualVersion = await cliVersion(executable, signal);
      if (
        actualVersion !== input.cliVersion &&
        options.versionPolicy !== "installed"
      )
        throw new Error(
          `Claude Code version mismatch: requested ${input.cliVersion}, installed ${actualVersion}. Configure the matching executable on the bridge.`,
        );
      const systems = input.messages
        .filter((m) => m.role === "system")
        .map((m) =>
          contentBlocks(m.content)
            .map((p) => {
              if (p.type !== "text")
                throw new Error("CLI system prompts must contain text");
              return p.text;
            })
            .join("\n"),
        )
        .join("\n\n");
      const messages = input.messages.filter((m) => m.role !== "system");
      // API key contributes only a hash to isolation; it never appears in paths.
      const allowedTools =
        settings.allowedTools ?? options.allowedTools ?? "Read,Glob,Grep";
      if (typeof allowedTools !== "string" || allowedTools.length > 4096)
        throw new Error("Invalid allowed CLI tools");
      const scope = hash([
        input.endpoint,
        actualVersion,
        input.model,
        systems,
        input.enableTools,
        input.betas,
        input.reasoningEffort,
        allowedTools,
        hostMcp?.tools,
      ]);
      const key = hash([input.endpoint, input.sessionId]);
      const stored = await sessions.begin(
        key,
        scope,
        historyHash(messages.slice(0, -1)),
      );
      let child;
      let failure;
      let success = false;
      let text = "";
      let diagnostic = "";
      const redact = (value) =>
        String(value)
          .split(input.endpoint.apiKey)
          .join("[REDACTED]")
          .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
          .slice(0, 2000);
      let sawStream = false;
      let assistantStream = false;
      const canResume = stored.resume;
      const session = canResume ? stored.id : randomUUID();
      const configDirectory = stored.directory;
      let requestDirectory;
      let committed = false;
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !/^(ANTHROPIC_|CLAUDE_|NEXTCHAT_(?:BRIDGE|WIRE|SERVICE)_|BUN_OPTIONS$|NODE_OPTIONS$)/i.test(
              name,
            ),
        ),
      );
      Object.assign(env, {
        ANTHROPIC_BASE_URL: input.endpoint.baseUrl
          .replace(/\/+$/, "")
          .replace(/\/v1$/, ""),
        [input.authType === "bearer"
          ? "ANTHROPIC_AUTH_TOKEN"
          : "ANTHROPIC_API_KEY"]: input.endpoint.apiKey,
        CLAUDE_CONFIG_DIR: configDirectory,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
      });
      const args = [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        input.model,
        "--setting-sources",
        options.settingsSources || "",
        "--strict-mcp-config",
        "--permission-mode",
        "dontAsk",
        canResume ? "--resume" : "--session-id",
        session,
      ];
      const permitted = input.enableTools
        ? allowedTools
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
      args.push(
        "--tools",
        [
          ...new Set(
            permitted
              .filter((value) => !value.startsWith("mcp__"))
              .map((value) => value.split("(")[0]),
          ),
        ].join(","),
      );
      if (input.enableTools && hostMcp)
        // The per-request facade exposes only tools selected by the host.
        permitted.push("mcp__nextchat__*");
      if (permitted.length) args.push("--allowedTools", permitted.join(","));
      if (options.mcpConfig && input.enableTools)
        args.push("--mcp-config", resolve(options.mcpConfig));
      if (input.betas?.length) args.push("--betas", input.betas.join(","));
      if (input.reasoningEffort) args.push("--effort", input.reasoningEffort);
      const stop = () => {
        void terminateProcessTree(child);
      };
      try {
        await mkdir(configDirectory, { recursive: true });
        requestDirectory = await mkdtemp(join(configDirectory, "request-"));
        if (systems) {
          const promptFile = join(requestDirectory, "system.txt");
          await writeFile(promptFile, systems, { mode: 0o600 });
          args.push("--append-system-prompt-file", promptFile);
        }
        if (input.enableTools && hostMcp) {
          const configFile = join(requestDirectory, "mcp.json");
          await writeFile(
            configFile,
            JSON.stringify({ mcpServers: { nextchat: hostMcp.config } }),
            { mode: 0o600 },
          );
          args.push("--mcp-config", configFile);
        }
        if (signal.aborted) throw abortError();
        child = spawn(executable, args, {
          cwd: workingDirectory,
          env,
          windowsHide: true,
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
        signal.addEventListener("abort", stop, { once: true });
        const completion = new Promise((resolve) => {
          child.on("error", () => {
            failure = new Error("Cannot launch Claude Code");
            resolve(-1);
          });
          child.on("close", resolve);
        });
        // Retain a bounded in-memory diagnostic; redact credentials before
        // returning errors. Never write CLI stderr to the bridge console.
        child.stderr.on("data", (chunk) => {
          diagnostic = (diagnostic + chunk).slice(-8000);
        });
        child.stdin.on("error", () => {});
        const content = canResume
          ? contentBlocks(messages.at(-1).content)
          : firstTurn(messages);
        child.stdin.end(
          JSON.stringify({
            type: "user",
            message: { role: "user", content },
            session_id: session,
            parent_tool_use_id: null,
          }) + "\n",
        );
        const lines = createInterface({
          input: child.stdout,
          crlfDelay: Infinity,
        });
        const stopReading = () => {
          lines.close();
          child.stdout.destroy();
        };
        signal.addEventListener("abort", stopReading, { once: true });
        child.once("close", () =>
          signal.removeEventListener("abort", stopReading),
        );
        let separateText = false;
        const appendText = async (chunk) => {
          if (!chunk) return;
          const separator =
            separateText && text && !text.endsWith("\n\n")
              ? text.endsWith("\n")
                ? "\n"
                : "\n\n"
              : "";
          separateText = false;
          text += separator + chunk;
          await emit({ type: "text", text: separator + chunk });
        };
        for await (const line of lines) {
          if (signal.aborted) throw abortError();
          if (line.length > 8 * 1024 * 1024)
            throw new Error("Claude Code output exceeded the event size limit");
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            throw new Error("Claude Code returned an invalid stream event");
          }
          if (event.type === "stream_event") {
            if (event.parent_tool_use_id) continue;
            const e = event.event;
            if (e?.type === "message_start") {
              assistantStream = false;
              separateText = !!text;
            }
            if (
              e?.type === "content_block_delta" &&
              e.delta?.type === "text_delta"
            ) {
              sawStream = assistantStream = true;
              await appendText(e.delta.text);
            } else if (
              e?.type === "content_block_delta" &&
              e.delta?.type === "thinking_delta"
            ) {
              await emit({ type: "thinking", text: e.delta.thinking });
            }
          } else if (event.type === "assistant" && !event.parent_tool_use_id) {
            for (const part of event.message?.content || []) {
              if (part.type === "text" && !assistantStream) {
                await appendText(part.text);
              }
              if (part.type === "tool_use")
                await emit({
                  type: "tool_start",
                  id: part.id,
                  name: part.name,
                  input: part.input,
                });
            }
            separateText = !!text;
          } else if (
            event.type === "user" &&
            !event.parent_tool_use_id &&
            Array.isArray(event.message?.content)
          ) {
            for (const part of event.message.content)
              if (part.type === "tool_result")
                await emit({
                  type: "tool_end",
                  id: part.tool_use_id,
                  content:
                    typeof part.content === "string"
                      ? part.content
                      : JSON.stringify(part.content),
                  isError: !!part.is_error,
                });
          } else if (event.type === "result") {
            if (event.is_error || event.subtype !== "success") {
              throw new Error(
                `Claude Code failed (${String(
                  event.subtype || "unknown",
                ).replace(/[^a-z0-9_-]/gi, "")}): ${redact(
                  event.errors?.join("\n") || event.result || "Request failed",
                )}`,
              );
            }
            if (!sawStream && !text && typeof event.result === "string") {
              text = event.result;
              await emit({ type: "text", text });
            }
            success = true;
          }
        }
        const code = await completion;
        if (signal.aborted) throw abortError();
        if (failure) throw failure;
        if (code !== 0 || !success)
          throw new Error(
            `Claude Code stopped without a successful result (exit ${code}): ${redact(
              diagnostic,
            )}`,
          );
        stored.id = session;
        stored.history = historyHash([
          ...messages,
          { role: "assistant", content: text },
        ]);
        committed = true;
        await emit({ type: "done", sessionId: session });
      } catch (error) {
        committed = false;
        await terminateProcessTree(child);
        throw error;
      } finally {
        signal.removeEventListener("abort", stop);
        try {
          if (requestDirectory)
            await rm(requestDirectory, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 100,
            });
        } finally {
          await sessions.end(key, stored, committed);
        }
      }
    },
  };
}
