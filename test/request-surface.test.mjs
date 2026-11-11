import test from "node:test";
import assert from "node:assert/strict";
import { compareClientSurface } from "../scripts/request-surface.mjs";
import { compareRequests } from "../scripts/request-parity.mjs";

const system = [
  { type: "text", text: "billing fixture" },
  {
    type: "text",
    text: "identity fixture",
    cache_control: { type: "ephemeral" },
  },
  {
    type: "text",
    text: "CLI instructions",
    cache_control: { type: "ephemeral" },
  },
];
const body = {
  model: "claude-sonnet-4-6",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
      ],
    },
  ],
  system,
  tools: [{ name: "Read", input_schema: { type: "object" } }],
  metadata: {
    user_id: JSON.stringify({
      device_id: "a".repeat(64),
      account_uuid: "",
      session_id: "local-session",
    }),
  },
  max_tokens: 32000,
  thinking: { type: "adaptive", display: "updates" },
  safeguards: { fixture: "native tool context" },
  stream: true,
};
function capture(
  value = body,
  headers = "User-Agent: cli-fixture\r\nX-Claude-Code-Session-Id: local-session",
) {
  const text = JSON.stringify(value);
  return {
    wireBase64: Buffer.from(
      `POST /v1/messages?beta=true HTTP/1.1\r\n${headers}\r\nContent-Length: ${Buffer.byteLength(
        text,
      )}\r\n\r\n${text}`,
    ).toString("base64"),
  };
}

test("application-owned content is allowed without reclassifying full-byte parity", () => {
  const application = structuredClone(body);
  application.system[2].text = "NextChat instructions";
  application.messages[0].content[0].text = "Different user input";
  application.tools = [{ name: "lookup", input_schema: { type: "object" } }];
  delete application.safeguards;
  const report = compareClientSurface(capture(), capture(application));
  assert.equal(report.checksPass, true);
  assert.equal(compareRequests(capture(), capture(application)).equal, false);
  assert.ok(
    report.notAssessed.some((item) => item.includes("Gateway acceptance")),
  );
});

test("client headers, billing, metadata and protocol parameters still fail on drift", () => {
  const changes = [
    (value) => (value.system[0].text = "wrong billing"),
    (value) =>
      (value.metadata.user_id = JSON.stringify({
        device_id: "a".repeat(64),
        session_id: "wrong-session",
      })),
    (value) => (value.thinking.display = "different"),
    (value) => (value.system[2].cache_control = undefined),
    (value) => (value.messages[0].content[0].cache_control = undefined),
  ];
  for (const change of changes) {
    const modified = structuredClone(body);
    change(modified);
    assert.equal(
      compareClientSurface(capture(), capture(modified)).checksPass,
      false,
    );
  }
  assert.equal(
    compareClientSurface(
      capture(),
      capture(
        body,
        "user-agent: cli-fixture\r\nX-Claude-Code-Session-Id: local-session",
      ),
    ).checksPass,
    false,
  );
});

test("reports do not print prompt or credential values and incomplete bodies cannot pass", () => {
  const report = compareClientSurface(
    capture(),
    capture(body, "Authorization: private-credential"),
  );
  for (const content of [
    "CLI instructions",
    "private-credential",
    "native tool context",
  ])
    assert.ok(!JSON.stringify(report).includes(content));
  assert.throws(
    () => compareClientSurface(capture(), { body }),
    /Full raw request/,
  );
});
