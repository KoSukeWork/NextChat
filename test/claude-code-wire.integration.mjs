import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prepareRequest } from "../plugins/claude-code-wire/index.mjs";

const load = async (version) => {
  const pkg = JSON.parse(
    await readFile(
      new URL(
        `../public/request-plugins/nextchat.claude-code-${version}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const plugin = await import(
    `data:text/javascript;base64,${Buffer.from(pkg.source).toString("base64")}`
  );
  return { pkg, plugin };
};
const previous = await load("3.0.0-beta.1");
const current = await load("3.0.0-beta.2");
const context = {
  operation: "chat",
  protocol: "anthropic",
  endpoint: {
    id: "fixture",
    baseUrl: "https://gateway.test",
    apiKey: "dummy-key",
  },
  sessionId: "12345678-1234-4234-a234-123456789abc",
  requestId: "test-request",
  config: Object.fromEntries(
    Object.entries(current.pkg.manifest.fields).map(([key, field]) => [
      key,
      field.default || "",
    ]),
  ),
};
const input = {
  url: "https://gateway.test/v1/messages",
  headers: { "Content-Type": "application/json", "x-api-key": "dummy-key" },
  body: {
    model: "claude-sonnet-4-6",
    messages: [
      { role: "user", content: "Reply exactly INTERACTIVE_PARITY_PROBE." },
    ],
    stream: true,
  },
};

test("new installable package preserves the captured profile and matches its sources", () => {
  const output = current.plugin.prepareRequest(input, context);
  // Include property/header order; object deep equality alone would miss it.
  assert.equal(
    JSON.stringify(output),
    JSON.stringify(previous.plugin.prepareRequest(input, context)),
  );
  assert.equal(
    JSON.stringify(output),
    JSON.stringify(prepareRequest(input, context)),
  );
});

test("custom version markers require explicit selection and retain the pinned network runtime", () => {
  const changed = structuredClone(context);
  changed.config.cliVersion = "2.1.400";
  assert.throws(
    () => current.plugin.prepareRequest(input, changed),
    /Custom profile/,
  );
  changed.config.profile = "custom";
  const output = current.plugin.prepareRequest(input, changed);
  assert.equal(
    output.headers["User-Agent"],
    "claude-cli/2.1.400 (external, cli)",
  );
  assert.match(output.body.system[0].text, /cc_version=2\.1\.400\./);
  assert.equal(output.transport.profile, "bun-1.4.4-38afee6c8-win32-x64");
  changed.config.platform = "Linux";
  assert.throws(
    () => current.plugin.prepareRequest(input, changed),
    /Windows x64/,
  );
});
