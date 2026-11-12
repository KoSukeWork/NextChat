import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  stat,
  utimes,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { createRuntimeInspector } from "../scripts/client-bridge/runtime.mjs";
import { createSessionStore } from "../scripts/client-bridge/sessions.mjs";
import { createDriver } from "../plugins/claude-code/driver.mjs";
import { createBridge } from "../scripts/client-bridge/server.mjs";
import { mockAnthropic } from "./fixtures/anthropic-http.mjs";

const token = "cli-runtime-test-secret";
async function cleanup(root) {
  const inside = relative(resolve(tmpdir()), resolve(root));
  if (
    !inside.startsWith("nextchat-") ||
    inside.startsWith("..") ||
    isAbsolute(inside)
  )
    throw new Error("Unsafe fixture cleanup path");
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
async function serve(driver, options = {}) {
  const server = createBridge({
    token,
    drivers: new Map([[driver.id, driver]]),
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
async function consume(
  bridge,
  body,
  onTool = async () => ({ content: "ok", isError: false }),
) {
  const response = await fetch(`${bridge.url}/v1/drivers/claude-code/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const events = [];
  let buffer = "";
  for await (const bytes of response.body) {
    buffer += Buffer.from(bytes).toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const event = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      events.push(event);
      if (event.type === "host_tool_call") {
        const result = await onTool(event);
        const reply = await fetch(
          `${bridge.url}/v1/runs/${event.runId}/results/${event.id}`,
          { method: "POST", headers, body: JSON.stringify(result) },
        );
        assert.equal(reply.status, 204);
      }
    }
  }
  return events;
}

test("runtime version cache coalesces probes and invalidates on executable replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "nextchat-version-"));
  try {
    const path = join(root, "claude.exe");
    await writeFile(path, "1.0.0");
    let count = 0;
    const version = createRuntimeInspector(async (path) => {
      count++;
      return readFile(path, "utf8");
    });
    assert.deepEqual(await Promise.all([version(path), version(path)]), [
      "1.0.0",
      "1.0.0",
    ]);
    assert.equal(count, 1);
    await writeFile(path, "2.20.0");
    assert.equal(await version(path), "2.20.0");
    assert.equal(count, 2);
  } finally {
    await cleanup(root);
  }
});

test("session rollover removes the old directory and bounds inactive conversations", async () => {
  const root = await mkdtemp(join(tmpdir(), "nextchat-sessions-"));
  const store = await createSessionStore(root, { maxSessions: 1 });
  try {
    const first = await store.begin("chat", "scope", "");
    Object.assign(first, { id: "one", history: "prefix" });
    await writeFile(join(first.directory, "transcript.jsonl"), "stored");
    await store.end("chat", first, true);
    const resumed = await store.begin("chat", "scope", "prefix");
    assert.equal(resumed.resume, true);
    await assert.rejects(
      store.begin("chat", "changed", ""),
      /already generating/,
    );
    await store.end("chat", resumed, true);
    const next = await store.begin("chat", "changed", "truncated");
    await assert.rejects(stat(first.directory), { code: "ENOENT" });
    await store.end("chat", next, true);
    const other = await store.begin("other", "scope", "");
    await store.end("other", other, true);
    await assert.rejects(stat(next.directory), { code: "ENOENT" });
    assert.equal((await readdir(join(root, "managed-v2"))).length, 1);
  } finally {
    await store.close();
    await cleanup(root);
  }
});

test("bridge deadlines are configurable and zero leaves cancellation to the caller", async () => {
  const driver = {
    id: "claude-code",
    info: async () => ({}),
    async chat(_, { signal, emit }) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 50);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      await emit({ type: "done" });
    },
  };
  for (const [timeoutMs, expected] of [
    [10, "error"],
    [0, "done"],
  ]) {
    const bridge = await serve(driver, { timeoutMs });
    try {
      assert.equal((await consume(bridge, {})).at(-1).type, expected);
    } finally {
      await bridge.close();
    }
  }
});

test("MCP facade authenticates CLI calls and exposes only the request's host tools", async () => {
  const driver = {
    id: "claude-code",
    info: async () => ({}),
    async chat(_, { hostMcp, emit }) {
      assert.equal((await fetch(hostMcp.config.url)).status, 401);
      const rpc = async (method, params) =>
        (
          await fetch(hostMcp.config.url, {
            method: "POST",
            headers: {
              ...hostMcp.config.headers,
              "content-type": "application/json",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          })
        ).json();
      assert.deepEqual(
        (await rpc("tools/list")).result.tools.map((tool) => tool.name),
        ["enabled"],
      );
      assert.ok((await rpc("tools/call", { name: "disabled" })).error);
      const result = await rpc("tools/call", {
        name: "enabled",
        arguments: { value: 42 },
      });
      assert.equal(result.result.content[0].text, "from-nextchat");
      await emit({ type: "done" });
    },
  };
  const bridge = await serve(driver);
  try {
    const events = await consume(
      bridge,
      {
        enableTools: true,
        hostTools: [{ name: "enabled", inputSchema: { type: "object" } }],
      },
      async (event) => {
        assert.equal(event.name, "enabled");
        assert.deepEqual(event.input, { value: 42 });
        return { content: "from-nextchat", isError: false };
      },
    );
    assert.equal(events.at(-1).type, "done");
  } finally {
    await bridge.close();
  }
});

test(
  "real managed CLI accepts version drift, long system files, and NextChat MCP tools",
  { skip: process.env.NEXTCHAT_TEST_REAL_CLAUDE !== "1", timeout: 90000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nextchat-managed-fixes-"));
    const gateway = await mockAnthropic({
      tool: { name: "mcp__nextchat__probe", input: { text: "hello" } },
      beforeToolText: "Before tool",
    });
    const driver = await createDriver({
      executable: process.env.NEXTCHAT_CLAUDE_PATH,
      versionPolicy: "installed",
      workingDirectory: join(root, "work"),
      dataDirectory: join(root, "data"),
      allowedTools: "",
    });
    const bridge = await serve(driver);
    try {
      const system = "Long system prompt 中文\n".repeat(4000);
      const body = {
        cliVersion: "0.0.1",
        model: "claude-sonnet-4-6",
        sessionId: "fixes",
        endpoint: { baseUrl: gateway.url, apiKey: "dummy-fixes-key" },
        authType: "api-key",
        enableTools: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: "Use the probe" },
        ],
        hostTools: [
          {
            name: "probe",
            description: "A local test",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
          },
        ],
      };
      let calls = 0;
      const events = await consume(bridge, body, async (event) => {
        calls++;
        assert.equal(event.name, "probe");
        return { content: "MCP success", isError: false };
      });
      assert.equal(events.at(-1).type, "done", JSON.stringify(events));
      assert.equal(calls, 1);
      assert.equal(
        events
          .filter((event) => event.type === "text")
          .map((event) => event.text)
          .join(""),
        "Before tool\n\nReply 2",
      );
      assert.ok(
        gateway.captures[0].body.system.some((part) =>
          part.text.includes(system),
        ),
      );
      assert.ok(
        gateway.captures[0].body.tools.some(
          (tool) => tool.name === "mcp__nextchat__probe",
        ),
      );
      assert.ok(
        !gateway.captures[0].body.tools.some((tool) => tool.name === "Bash"),
      );
      const next = await consume(bridge, {
        ...body,
        enableTools: false,
        messages: [{ role: "user", content: "No tools" }],
      });
      assert.equal(next.at(-1).type, "done", JSON.stringify(next));
      assert.ok(!gateway.captures.at(-1).body.tools?.length);
      const [instance] = await readdir(join(root, "data", "managed-v2"));
      const sessions = (
        await readdir(join(root, "data", "managed-v2", instance))
      ).filter((name) => name.startsWith("session-"));
      assert.equal(sessions.length, 1);
      assert.ok(
        !(
          await readdir(join(root, "data", "managed-v2", instance, sessions[0]))
        ).some((name) => name.startsWith("request-")),
      );
    } finally {
      await bridge.close();
      await driver.close();
      await gateway.close();
      await cleanup(root);
    }
  },
);

test(
  "a preapproved CLI Write tool can execute in the isolated work directory",
  { skip: process.env.NEXTCHAT_TEST_REAL_CLAUDE !== "1", timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nextchat-tool-policy-"));
    const output = join(root, "work", "approved.txt");
    const gateway = await mockAnthropic({
      tool: {
        name: "Write",
        input: { file_path: output, content: "approved by settings" },
      },
    });
    const driver = await createDriver({
      executable: process.env.NEXTCHAT_CLAUDE_PATH,
      workingDirectory: join(root, "work"),
      dataDirectory: join(root, "data"),
      allowedTools: "Write",
    });
    try {
      const events = [];
      await driver.chat(
        {
          cliVersion: (await driver.info()).versions[0],
          model: "claude-sonnet-4-6",
          sessionId: "write",
          endpoint: { baseUrl: gateway.url, apiKey: "dummy-write-key" },
          authType: "api-key",
          enableTools: true,
          messages: [{ role: "user", content: "Write the test file" }],
        },
        {
          signal: new AbortController().signal,
          emit: async (event) => {
            events.push(event);
          },
        },
      );
      assert.equal(await readFile(output, "utf8"), "approved by settings");
      assert.ok(
        events.some((event) => event.type === "tool_end" && !event.isError),
      );
      assert.ok(
        !gateway.captures[0].body.tools.some((tool) => tool.name === "Bash"),
      );
    } finally {
      await driver.close();
      await gateway.close();
      await cleanup(root);
    }
  },
);
