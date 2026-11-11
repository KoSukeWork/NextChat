import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createBridge } from "../scripts/client-bridge/server.mjs";
import { createDriver } from "../plugins/claude-code/driver.mjs";
// Keep exercising the immutable legacy package's optional CLI driver.
const legacy = JSON.parse(
  await readFile(
    new URL(
      "../public/request-plugins/nextchat.claude-code-1.0.0.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const { prepareChat, prepareRequest } = await import(
  `data:text/javascript;base64,${Buffer.from(legacy.source).toString("base64")}`
);
import { mockAnthropic } from "./fixtures/anthropic-http.mjs";

const token = "nextchat-local-fixture-token";
async function serve(driver) {
  const server = createBridge({
    token,
    drivers: new Map([[driver.id, driver]]),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
};

test("bridge authenticates requests and streams a separately installed driver", async () => {
  const bridge = await serve({
    id: "fixture",
    info: async () => ({ sdkVersion: 1 }),
    async chat(input, { emit }) {
      await emit({ type: "text", text: input.prompt });
      await emit({ type: "done" });
    },
  });
  try {
    assert.equal((await fetch(bridge.url + "/v1/drivers")).status, 401);
    assert.equal(
      (await fetch(bridge.url + "/v1/drivers", { headers })).status,
      200,
    );
    const response = await fetch(bridge.url + "/v1/drivers/fixture/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "你好" }),
    });
    const events = (await response.text()).trim().split("\n").map(JSON.parse);
    assert.deepEqual(events, [
      { type: "text", text: "你好" },
      { type: "done" },
    ]);
  } finally {
    await bridge.close();
  }
});

test("disconnect aborts a running driver", async () => {
  let stopped;
  const aborted = new Promise((resolve) => (stopped = resolve));
  const bridge = await serve({
    id: "fixture",
    info: async () => ({}),
    async chat(_, { signal, emit }) {
      signal.addEventListener("abort", stopped, { once: true });
      await emit({ type: "text", text: "started" });
      await aborted;
    },
  });
  try {
    const controller = new AbortController();
    const response = await fetch(bridge.url + "/v1/drivers/fixture/chat", {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await Promise.race([
      aborted,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("driver was not cancelled")),
          3000,
        ).unref(),
      ),
    ]);
  } finally {
    await bridge.close();
  }
});

test("simulation is explicit, immutable, versioned, and separates models from chat", () => {
  const context = {
    config: { mode: "simulate", cliVersion: "2.1.322", authType: "api-key" },
    sessionId: "session",
    endpoint: { apiKey: "dummy" },
    operation: "chat",
  };
  const request = {
    url: "https://gateway.test/v1/messages",
    headers: { "x-api-key": "dummy" },
    body: {
      system: "User system",
      tools: [{ name: "real_tool" }],
      messages: [],
    },
  };
  const result = prepareRequest(request, context);
  assert.equal(
    result.headers["user-agent"],
    "claude-cli/2.1.322 (external, sdk-cli)",
  );
  assert.equal(result.url, "https://gateway.test/v1/messages?beta=true");
  assert.equal(result.body.system, "User system");
  assert.deepEqual(result.body.tools, request.body.tools);
  assert.equal(request.url, "https://gateway.test/v1/messages");
  assert.equal(
    prepareRequest(
      { url: "https://gateway.test/v1/models", headers: {} },
      { ...context, operation: "models" },
    ).body,
    undefined,
  );
  assert.throws(
    () =>
      prepareRequest(request, {
        ...context,
        config: { ...context.config, cliVersion: "9.9.9" },
      }),
    /No verified/,
  );
  assert.throws(
    () =>
      prepareRequest(request, {
        ...context,
        config: { ...context.config, headerOverrides: '{"Host":"evil.test"}' },
      }),
    /Transport header/,
  );
  assert.equal(prepareChat({}, context), null);
});

test(
  "real CLI sends its own headers, checks the executable version and resumes signed history",
  { skip: process.env.NEXTCHAT_TEST_REAL_CLAUDE !== "1", timeout: 90000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "nextchat-cli-test-"));
    const upstream = await mockAnthropic();
    const driver = await createDriver({
      workingDirectory: join(directory, "work"),
      dataDirectory: join(directory, "data"),
    });
    const info = await driver.info();
    const bridge = await serve(driver);
    const context = {
      config: {
        mode: "cli",
        cliVersion: info.versions[0],
        bridgeUrl: bridge.url,
        bridgeToken: token,
        authType: "api-key",
      },
      endpoint: { baseUrl: upstream.url, apiKey: "nextchat-local-dummy" },
      sessionId: "test-conversation",
      requestId: "test-request",
    };
    const send = async (chat) => {
      const request = prepareChat(chat, context);
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
      });
      const events = (await response.text()).trim().split("\n").map(JSON.parse);
      assert.equal(events.at(-1).type, "done", JSON.stringify(events));
      return events;
    };
    try {
      const messages = [{ role: "user", content: "First question" }];
      const first = await send({
        messages,
        model: "claude-sonnet-4-6",
        enableTools: true,
      });
      const text = first
        .filter((e) => e.type === "text")
        .map((e) => e.text)
        .join("");
      assert.equal(text, "Reply 1");
      assert.ok(first.some((e) => e.type === "thinking"));
      messages.push(
        { role: "assistant", content: text },
        { role: "user", content: "Second question" },
      );
      const second = await send({
        messages,
        model: "claude-sonnet-4-6",
        enableTools: true,
      });
      assert.equal(first.at(-1).sessionId, second.at(-1).sessionId);
      const [a, b] = upstream.captures;
      assert.equal(a.path, "/v1/messages?beta=true");
      assert.match(
        a.headers["user-agent"],
        new RegExp(`claude-cli/${info.versions[0].replaceAll(".", "\\.")}`),
      );
      assert.equal(a.headers["x-api-key"], "nextchat-local-dummy");
      assert.equal(a.headers["x-app"], "cli");
      assert.ok(
        a.body.system.some((part) => part.text.includes("cc_version=")),
      );
      assert.ok(a.body.tools.length > 0);
      assert.equal(
        a.headers["x-claude-code-session-id"],
        b.headers["x-claude-code-session-id"],
      );
      assert.ok(
        JSON.stringify(b.body.messages).includes("local-fixture-signature"),
      );
      assert.ok(JSON.stringify(b.body.messages).includes("Second question"));
      const mismatch = prepareChat(
        {
          messages: [{ role: "user", content: "never sent" }],
          model: "m",
          enableTools: false,
        },
        { ...context, config: { ...context.config, cliVersion: "0.0.0" } },
      );
      const response = await fetch(mismatch.url, {
        method: "POST",
        headers: mismatch.headers,
        body: JSON.stringify(mismatch.body),
      });
      assert.match(await response.text(), /version mismatch/);
      assert.equal(upstream.captures.length, 2);
      const bearer = prepareChat(
        {
          messages: [{ role: "user", content: "Bearer authentication" }],
          model: "claude-sonnet-4-6",
          enableTools: false,
        },
        { ...context, config: { ...context.config, authType: "bearer" } },
      );
      const bearerResponse = await fetch(bearer.url, {
        method: "POST",
        headers: bearer.headers,
        body: JSON.stringify(bearer.body),
      });
      assert.match(await bearerResponse.text(), /"type":"done"/);
      assert.equal(
        upstream.captures.at(-1).headers.authorization,
        "Bearer nextchat-local-dummy",
      );
      assert.equal(upstream.captures.at(-1).headers["x-api-key"], undefined);
      console.log(
        `Verified real Claude Code ${info.versions[0]} against a local dummy gateway`,
      );
    } finally {
      await bridge.close();
      await upstream.close();
      // Only delete the explicitly created test directory within the OS temp root.
      const target = resolve(directory);
      if (
        !target.startsWith(resolve(tmpdir()) + sep) ||
        !target.split(sep).at(-1).startsWith("nextchat-cli-test-")
      )
        throw new Error("Unsafe test cleanup path");
      await rm(target, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      });
    }
  },
);

test(
  "real CLI owns tool execution and cancellation kills its upstream request",
  { skip: process.env.NEXTCHAT_TEST_REAL_CLAUDE !== "1", timeout: 90000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "nextchat-cli-test-"));
    const file = join(directory, "fixture.txt");
    await writeFile(file, "Only a temporary test fixture.");
    const upstream = await mockAnthropic({ toolFile: file });
    const stalled = await mockAnthropic({ stall: true });
    const driver = await createDriver({
      workingDirectory: directory,
      dataDirectory: join(directory, "data"),
      allowedTools: "Read",
    });
    const input = {
      cliVersion: (await driver.info()).versions[0],
      sessionId: "tools-test",
      endpoint: { baseUrl: upstream.url, apiKey: "local-dummy-key" },
      authType: "api-key",
      model: "claude-sonnet-4-6",
      enableTools: true,
      messages: [{ role: "user", content: "Read the test fixture." }],
    };
    try {
      const events = [];
      await driver.chat(input, {
        signal: new AbortController().signal,
        emit: async (event) => {
          events.push(event);
        },
      });
      assert.equal(events.at(-1).type, "done");
      assert.ok(
        events.some((e) => e.type === "tool_start" && e.name === "Read"),
      );
      assert.ok(
        events.some(
          (e) =>
            e.type === "tool_end" &&
            e.content.includes("temporary test fixture"),
        ),
      );
      assert.equal(upstream.captures.length, 2);
      const controller = new AbortController();
      const work = driver.chat(
        { ...input, endpoint: { ...input.endpoint, baseUrl: stalled.url } },
        { signal: controller.signal, emit: async () => {} },
      );
      const rejection = assert.rejects(work, /cancelled/i);
      await stalled.received;
      controller.abort();
      await rejection;
      await Promise.race([
        stalled.disconnected,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("CLI upstream did not disconnect")),
            3000,
          ).unref(),
        ),
      ]);
    } finally {
      await upstream.close();
      await stalled.close();
      const target = resolve(directory);
      if (
        !target.startsWith(resolve(tmpdir()) + sep) ||
        !target.split(sep).at(-1).startsWith("nextchat-cli-test-")
      )
        throw new Error("Unsafe test cleanup path");
      await rm(target, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      });
    }
  },
);
