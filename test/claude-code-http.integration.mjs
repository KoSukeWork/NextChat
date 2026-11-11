import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { prepareRequest as sourceHook } from "../plugins/claude-code/index.mjs";
import { mockAnthropic } from "./fixtures/anthropic-http.mjs";

const readJSON = async (file) =>
  JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
const pkg = await readJSON(
  "../public/request-plugins/nextchat.claude-code-2.0.0.json",
);
const capture = await readJSON(
  "./fixtures/claude-code-interactive-2.1.322.json",
);
// Exercise the actual installable package, including the bundled hash library.
const plugin = await import(
  `data:text/javascript;base64,${Buffer.from(pkg.source).toString("base64")}`
);
const hook = plugin.prepareRequest;
const defaults = Object.fromEntries(
  Object.entries(pkg.manifest.fields).map(([key, field]) => [
    key,
    field.default || "",
  ]),
);
const ctx = (config = {}) => ({
  operation: "chat",
  protocol: "anthropic",
  config: { ...defaults, ...config },
  endpoint: {
    id: "local-fixture",
    apiKey: "dummy-key",
    baseUrl: "https://gateway.test",
  },
  sessionId: "12345678-1234-4234-a234-123456789abc",
  requestId: "test-request",
});
const input = (body = {}) => ({
  url: "https://gateway.test/v1/messages?existing=1",
  headers: {
    "Content-Type": "application/json",
    "X-Api-Key": "stale-key",
    Authorization: "stale-bearer",
  },
  body: {
    model: capture.bodySettings.model,
    messages: [{ role: "user", content: capture.userText }],
    system: "User instructions",
    max_tokens: 1000,
    stream: true,
    ...body,
  },
});

test("portable package matches the captured interactive envelope, billing, and generation settings", () => {
  assert.deepEqual(pkg.manifest.capabilities, ["request"]);
  assert.equal(plugin.prepareChat, undefined);
  const request = input();
  const before = structuredClone(request);
  const output = hook(request, ctx());
  assert.deepEqual(
    output,
    sourceHook(request, ctx()),
    "package must be repacked after source changes",
  );
  for (const [key, value] of Object.entries(capture.headers))
    assert.equal(output.headers[key], value, key);
  assert.deepEqual(output.body.system.slice(0, 2), capture.systemPrefix);
  assert.deepEqual(
    output.body.system.map((b) => b.cache_control || null),
    capture.systemCache,
  );
  assert.equal(output.body.system[2].text, "User instructions");
  for (const [key, value] of Object.entries(capture.bodySettings))
    assert.deepEqual(output.body[key], value, key);
  const metadata = JSON.parse(output.body.metadata.user_id);
  assert.deepEqual(Object.keys(metadata), capture.metadataKeys);
  assert.equal(metadata.session_id, output.headers["x-claude-code-session-id"]);
  assert.match(metadata.device_id, /^[a-f0-9]{64}$/);
  assert.equal(metadata.account_uuid, "");
  assert.equal(output.headers.authorization, undefined);
  assert.equal(output.headers["x-api-key"], "dummy-key");
  assert.deepEqual(output.body.messages[0].content, [
    {
      type: "text",
      text: capture.userText,
      cache_control: { type: "ephemeral" },
    },
  ]);
  assert.equal(new URL(output.url).search, "?existing=1&beta=true");
  assert.deepEqual(request, before);
});

test("billing depends on first actual user text, uses UTF-16, and stays stable on continuation", () => {
  for (const text of [
    "",
    "hi",
    capture.userText,
    "中文😀😀abcdefghijklmnop你好",
    "abcdefghijklmnopqrstuvw",
  ]) {
    const sample = [4, 7, 20].map((i) => text[i] || "0").join("");
    const suffix = createHash("sha256")
      .update(`59cf53e54c78${sample}2.1.322`)
      .digest("hex")
      .slice(0, 3);
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: "https://example.test/image.png" },
          },
          { type: "text", text },
        ],
      },
    ];
    const first = hook(input({ messages }), ctx());
    messages.push(
      { role: "assistant", content: "answer" },
      { role: "user", content: "next question" },
    );
    const next = hook(input({ messages }), ctx());
    assert.equal(
      first.body.system[0].text,
      `x-anthropic-billing-header: cc_version=2.1.322.${suffix}; cc_entrypoint=cli;`,
    );
    assert.equal(next.body.system[0].text, first.body.system[0].text);
  }
});

test("tool round keeps tool definitions, signatures, IDs, results, and canonical history", () => {
  const thinking = {
    type: "thinking",
    thinking: "private thought",
    signature: "original-signature",
  };
  const redacted = { type: "redacted_thinking", data: "opaque-data" };
  const use = {
    type: "tool_use",
    id: "call_1",
    name: "lookup",
    input: { key: "a" },
  };
  const result = {
    type: "tool_result",
    tool_use_id: "call_1",
    content: "found",
  };
  const tools = [
    {
      name: "lookup",
      input_schema: { type: "object" },
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];
  const request = input({
    tools,
    messages: [
      { role: "user", content: "search" },
      { role: "assistant", content: [thinking, redacted, use] },
      { role: "user", content: [result] },
    ],
  });
  const snapshot = structuredClone(request);
  const output = hook(request, ctx({ systemPrompt: "Extra instructions" }));
  assert.deepEqual(output.body.messages[1].content, [thinking, redacted, use]);
  assert.deepEqual(output.body.messages[2].content, [
    { ...result, cache_control: { type: "ephemeral" } },
  ]);
  assert.deepEqual(output.body.tools, [
    { name: "lookup", input_schema: { type: "object" } },
  ]);
  assert.equal(
    output.body.system[2].text,
    "Extra instructions\n\nUser instructions",
  );
  assert.deepEqual(
    hook(output, ctx({ systemPrompt: "Extra instructions" })),
    output,
  );
  assert.deepEqual(request, snapshot);
});

test("version selection is explicit; custom fields and auth are configurable without a CLI", () => {
  assert.throws(
    () => hook(input(), ctx({ cliVersion: "9.9.9" })),
    /Custom version/,
  );
  const config = {
    profile: "custom",
    cliVersion: "9.9.9",
    sdkVersion: "0.999.0",
    runtimeVersion: "v99.0.0",
    platform: "Linux",
    arch: "arm64",
    deviceId: "a".repeat(64),
    accountUuid: "test-account",
    authType: "bearer",
  };
  const output = hook(input(), ctx(config));
  assert.equal(
    output.headers["user-agent"],
    "claude-cli/9.9.9 (external, cli)",
  );
  assert.match(output.body.system[0].text, /cc_version=9\.9\.9\.[a-f0-9]{3};/);
  assert.equal(output.headers["x-stainless-os"], "Linux");
  assert.equal(output.headers["x-stainless-arch"], "arm64");
  assert.equal(output.headers["x-stainless-package-version"], "0.999.0");
  assert.equal(output.headers["x-stainless-runtime-version"], "v99.0.0");
  assert.equal(output.headers.authorization, "Bearer dummy-key");
  assert.equal(output.headers["x-api-key"], undefined);
  assert.deepEqual(JSON.parse(output.body.metadata.user_id), {
    device_id: "a".repeat(64),
    account_uuid: "test-account",
    session_id: ctx().sessionId,
  });
  assert.throws(
    () => hook(input(), ctx({ deviceId: "invalid" })),
    /64 hexadecimal/,
  );
});

test("thinking, cache, and manual models are independently configurable", () => {
  const request = input({
    temperature: 0.5,
    top_p: 0.9,
    system: [
      {
        type: "text",
        text: "instructions",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
  });
  const adaptive = hook(request, ctx());
  assert.equal(adaptive.body.temperature, undefined);
  assert.equal(adaptive.body.top_p, undefined);
  const preserved = hook(
    request,
    ctx({
      cache: "preserve",
      thinking: "preserve",
      maxTokens: "",
      effort: "",
      beta: "",
    }),
  );
  assert.equal(preserved.body.max_tokens, 1000);
  assert.equal(preserved.body.temperature, 0.5);
  assert.equal(preserved.body.thinking, undefined);
  assert.equal(preserved.body.context_management, undefined);
  assert.equal(preserved.headers["anthropic-beta"], undefined);
  assert.deepEqual(preserved.body.system.at(-1), request.body.system[0]);
  assert.deepEqual(hook(request, ctx({ thinking: "disabled" })).body.thinking, {
    type: "disabled",
  });
  assert.throws(
    () => hook(input(), { ...ctx(), operation: "models" }),
    /Add models manually/,
  );
  const modelRequest = { url: "https://gateway.test/v1/models", headers: {} };
  const models = hook(modelRequest, {
    ...ctx({ modelList: "standard" }),
    operation: "models",
  });
  assert.equal(models.url, modelRequest.url);
  assert.equal(models.body, undefined);
});

test("overrides normalize headers and affect billing before final formatting", () => {
  const output = hook(
    input(),
    ctx({
      headerOverrides: JSON.stringify({
        "Anthropic-Beta": null,
        "X-Claude-Code-Session-ID": "override-session",
      }),
      bodyOverrides: JSON.stringify({
        messages: [{ role: "user", content: "new input" }],
        max_tokens: 500,
      }),
    }),
  );
  assert.equal(output.body.max_tokens, 500);
  assert.equal(output.body.context_management, undefined);
  assert.equal(output.body.thinking.display, undefined);
  assert.equal(
    JSON.parse(output.body.metadata.user_id).session_id,
    "override-session",
  );
  assert.notEqual(output.body.system[0].text, capture.systemPrefix[0].text);
  for (const config of [
    { headerOverrides: '{"Host":"evil.test"}' },
    { headerOverrides: '{"a":123}' },
    { bodyOverrides: "[]" },
    { bodyOverrides: '{"__proto__":{}}' },
    { maxTokens: "-5" },
  ])
    assert.throws(() => hook(input(), ctx(config)));
});

test("direct HTTP reaches a local gateway and returns streaming thinking, signature and text", async () => {
  const server = await mockAnthropic();
  try {
    const request = input();
    request.url = `${server.url}/v1/messages`;
    const output = hook(request, ctx());
    const response = await fetch(output.url, {
      method: "POST",
      headers: output.headers,
      body: JSON.stringify(output.body),
    });
    const stream = await response.text();
    assert.match(stream, /thinking_delta/);
    assert.match(stream, /local-fixture-signature/);
    assert.match(stream, /Reply 1/);
    assert.match(stream, /message_stop/);
    assert.equal(server.captures[0].path, capture.path);
    for (const [key, value] of Object.entries(capture.headers))
      assert.equal(server.captures[0].headers[key], value, key);
    assert.deepEqual(server.captures[0].body, output.body);
  } finally {
    await server.close();
  }
});

test("cancellation closes the upstream HTTP connection", async () => {
  const server = await mockAnthropic({ stall: true });
  try {
    const output = hook(
      { ...input(), url: `${server.url}/v1/messages` },
      ctx(),
    );
    const controller = new AbortController();
    const response = await fetch(output.url, {
      method: "POST",
      headers: output.headers,
      body: JSON.stringify(output.body),
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(response.text(), /abort/i);
    await Promise.race([
      server.disconnected,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("cancel timeout")), 3000).unref(),
      ),
    ]);
  } finally {
    await server.close();
  }
});
