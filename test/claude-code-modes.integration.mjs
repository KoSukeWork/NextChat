import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  prepareChat,
  prepareRequest,
} from "../plugins/claude-code-switchable/index.mjs";

async function load(version) {
  const pkg = JSON.parse(
    await readFile(
      new URL(
        `../public/request-plugins/nextchat.claude-code-${version}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return {
    pkg,
    hooks: await import(
      `data:text/javascript;base64,${Buffer.from(pkg.source).toString(
        "base64",
      )}`
    ),
  };
}
const { pkg, hooks } = await load("3.1.0-beta.1");
const http = (await load("3.0.0-beta.2")).hooks;
const context = (config = {}) => ({
  config: {
    ...Object.fromEntries(
      Object.entries(pkg.manifest.fields).map(([key, field]) => [
        key,
        field.default || "",
      ]),
    ),
    ...config,
  },
  endpoint: {
    id: "fixture",
    baseUrl: "https://gateway.test",
    apiKey: "dummy-key",
  },
  sessionId: "12345678-1234-4234-a234-123456789abc",
  requestId: "test-request",
  operation: "chat",
  protocol: "anthropic",
});
const chat = {
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "hello" }],
  enableTools: false,
};
const input = {
  url: "https://gateway.test/v1/messages",
  headers: { "x-api-key": "dummy-key" },
  body: { model: chat.model, messages: chat.messages, stream: true },
};

test("default HTTP mode is byte-identical to the independent plugin and needs no CLI config", () => {
  const ctx = context({ bridgeUrl: "not configured", nativeCliVersion: "" });
  assert.equal(hooks.prepareChat(chat, ctx), null);
  assert.equal(
    JSON.stringify(hooks.prepareRequest(input, ctx)),
    JSON.stringify(http.prepareRequest(input, ctx)),
  );
  assert.equal(
    JSON.stringify(hooks.prepareRequest(input, ctx)),
    JSON.stringify(prepareRequest(input, ctx)),
  );
});

test("CLI mode uses its own version, token and betas without requiring the HTTP relay", () => {
  const ctx = context({
    mode: "cli",
    bridgeToken: "local-bridge-token-12345",
    nativeCliVersion: "2.1.400",
    nativeBeta: "cli-one, cli-two",
    cliVersion: "HTTP-only-invalid-value",
    transportToken: "",
  });
  const request = hooks.prepareChat(chat, ctx);
  assert.deepEqual(request, prepareChat(chat, ctx));
  assert.equal(
    request.url,
    "http://127.0.0.1:8788/v1/drivers/claude-code/chat",
  );
  assert.equal(
    request.headers.authorization,
    "Bearer local-bridge-token-12345",
  );
  assert.equal(request.body.cliVersion, "2.1.400");
  assert.deepEqual(request.body.betas, ["cli-one", "cli-two"]);
  assert.deepEqual(request.body.messages, chat.messages);
  assert.equal(request.transport, undefined);
  assert.equal(request.body.transportToken, undefined);
  assert.throws(
    () => hooks.prepareRequest(input, ctx),
    /HTTP fallback is disabled/,
  );
  assert.throws(
    () => hooks.prepareRequest(input, { ...ctx, operation: "models" }),
    /Add models manually/,
  );
});

test("invalid CLI setup or unknown mode fails without silently choosing another mode", () => {
  assert.throws(
    () => hooks.prepareChat(chat, context({ mode: "cli" })),
    /bridge token/,
  );
  assert.throws(
    () =>
      hooks.prepareChat(
        chat,
        context({
          mode: "cli",
          bridgeToken: "local-bridge-token-12345",
          nativeCliVersion: "latest",
        }),
      ),
    /exact installed/,
  );
  assert.throws(
    () => hooks.prepareChat(chat, context({ mode: "unexpected" })),
    /Select HTTP/,
  );
  assert.throws(
    () => hooks.prepareRequest(input, context({ mode: "unexpected" })),
    /Select HTTP/,
  );
});
