import { endpointUrl, resolveEndpointModel } from "../app/utils/endpoints";
import type { Endpoint } from "../app/utils/endpoints";

const endpoints: Endpoint[] = [
  {
    id: "a",
    name: "First",
    protocol: "openai-chat",
    baseUrl: "https://one.example",
    apiKey: "",
    models: [{ name: "shared" }, { name: "default" }],
  },
  {
    id: "b",
    name: "Second",
    protocol: "gemini",
    baseUrl: "https://two.example",
    apiKey: "",
    models: [{ name: "shared" }],
  },
];

test.each([
  [
    "openai-chat",
    "https://api.openai.com",
    "chat",
    "https://api.openai.com/v1/chat/completions",
  ],
  [
    "openai-responses",
    "https://api.example/v1/",
    "chat",
    "https://api.example/v1/responses",
  ],
  [
    "anthropic",
    "https://api.example/proxy",
    "chat",
    "https://api.example/proxy/v1/messages",
  ],
  [
    "openai-chat",
    "https://example.test/api/paas/v4",
    "chat",
    "https://example.test/api/paas/v4/chat/completions",
  ],
  [
    "gemini",
    "https://example.test/v1beta/",
    "models",
    "https://example.test/v1beta/models",
  ],
  [
    "openai-chat",
    "https://example.test/v3?key=token",
    "models",
    "https://example.test/v3/models?key=token",
  ],
])("joins %s %s %s", (protocol, baseUrl, operation, expected) => {
  expect(
    endpointUrl(
      { protocol: protocol as Endpoint["protocol"], baseUrl },
      operation as "chat" | "models",
    ),
  ).toBe(expected);
});

test("Gemini streaming and nonstreaming paths escape the model name", () => {
  const endpoint = {
    protocol: "gemini" as const,
    baseUrl: "https://host.example",
  };
  expect(endpointUrl(endpoint, "chat", "models/model one")).toBe(
    "https://host.example/v1beta/models/model%20one:streamGenerateContent?alt=sse",
  );
  expect(endpointUrl(endpoint, "chat", "model one", false)).toBe(
    "https://host.example/v1beta/models/model%20one:generateContent",
  );
});

test("rejects invalid schemes", () => {
  expect(() =>
    endpointUrl(
      { protocol: "openai-chat", baseUrl: "file:///tmp/test" },
      "models",
    ),
  ).toThrow();
});

test("resolves exact, same name on another endpoint, fallback, then no match", () => {
  const fallback = { model: "default", endpointId: "a" };
  expect(
    resolveEndpointModel(
      endpoints,
      { model: "shared", endpointId: "b" },
      fallback,
    ),
  ).toEqual({ model: "shared", endpointId: "b", match: "exact" });
  expect(
    resolveEndpointModel(
      endpoints,
      { model: "shared", endpointId: "old" },
      fallback,
    ),
  ).toEqual({ model: "shared", endpointId: "a", match: "name" });
  expect(
    resolveEndpointModel(
      endpoints,
      { model: "unknown", endpointId: "old" },
      fallback,
    ),
  ).toEqual({ model: "default", endpointId: "a", match: "default" });
  expect(
    resolveEndpointModel(
      endpoints,
      { model: "unknown" },
      { model: "missing", endpointId: "a" },
    ),
  ).toBeUndefined();
});
