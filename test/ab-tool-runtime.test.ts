import { jest } from "@jest/globals";
import {
  createToolRegistry,
  formatMcpResult,
  geminiSchema,
} from "../app/mcp/tool-runtime";
import {
  cleanMcpHistory,
  findMcpCall,
  parseLegacyMcpResponse,
  splitLegacyMcpCalls,
} from "../app/mcp/utils";

test("tool names are safe and unique across servers, plugins, Unicode and long names", async () => {
  const execute = jest.fn(async (server, name, args) => ({
    content: [
      { type: "text", text: `${server}:${name}:${JSON.stringify(args)}` },
    ],
  }));
  const plugin = jest.fn(async () => "plugin");
  const groups = ["中文服务 / one", "中文服务 / two", "x".repeat(100)].map(
    (clientId) => ({
      clientId,
      tools: {
        tools: [{ name: "same tool!", inputSchema: { type: "object" } }],
      },
    }),
  );
  const registry = createToolRegistry(
    groups,
    [
      {
        id: "x".repeat(100),
        name: "Plugin",
        tools: [
          {
            type: "function",
            function: { name: "same tool!", parameters: {} },
          },
        ],
        funcs: { "same tool!": plugin },
      },
    ],
    execute,
  );
  const names = registry.tools.map((tool) => tool.function.name);
  expect(new Set(names).size).toBe(4);
  expect(names.every((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))).toBe(true);
  expect(registry.display[names[0]]).toMatchObject({
    server: "中文服务 / one",
    name: "same tool!",
  });
  await registry.funcs[names[0]]({ x: 1 });
  expect(execute).toHaveBeenCalledWith("中文服务 / one", "same tool!", {
    x: 1,
  });
  await registry.funcs[names[3]]({});
  expect(plugin).toHaveBeenCalled();
});

test("missing schema becomes an object and Gemini removes unsupported keywords while resolving local refs", () => {
  const registry = createToolRegistry(
    [{ clientId: "s", tools: { tools: [{ name: "x" }] } }],
    [],
    async () => ({}),
  );
  expect(registry.tools[0].function.parameters).toEqual({
    type: "object",
    properties: {},
  });
  expect(
    geminiSchema({
      $schema: "x",
      type: "object",
      additionalProperties: false,
      $defs: { value: { type: "string", description: "text" } },
      properties: { a: { $ref: "#/$defs/value" } },
      required: ["a"],
    }),
  ).toEqual({
    type: "object",
    properties: { a: { type: "string", description: "text" } },
    required: ["a"],
  });
});

test("Gemini converts nullable type arrays and preserves documented format values", () => {
  expect(
    geminiSchema({
      type: "object",
      properties: {
        url: { type: ["string", "null"], format: "uri" },
        date: { type: "string", format: "date-time" },
      },
    }),
  ).toEqual({
    type: "object",
    properties: {
      url: { type: "string", nullable: true, format: "uri" },
      date: { type: "string", format: "date-time" },
    },
  });
});

test("MCP error and non-text metadata survive without binary payload", () => {
  const result = formatMcpResult({
    isError: true,
    content: [
      { type: "text", text: "bad" },
      { type: "image", mimeType: "image/png", data: "YWJj" },
      { type: "resource_link", uri: "file:///sample", name: "example" },
    ],
  });
  expect(result.isError).toBe(true);
  expect(result.content).toContain("bad");
  expect(result.content).toContain("image/png");
  expect(result.content).toContain("file:///sample");
  expect(result.content).not.toContain("YWJj");
});

test("legacy history is cleaned only in the outbound copy and remains renderable", () => {
  const call =
    'before\n```json:mcp:中文 服务\n{"method":"tools/call","params":{"name":"lookup"}}\n```\nafter';
  const messages: any[] = [
    { role: "assistant", content: call },
    {
      role: "user",
      isMcpResponse: true,
      content: '```json:mcp-response:中文 服务\n{"result":1}\n```',
    },
    { role: "user", content: "next" },
  ];
  const before = JSON.stringify(messages);
  expect(cleanMcpHistory(messages)).toEqual([
    { role: "assistant", content: "before\n\nafter" },
    { role: "user", content: "next" },
  ]);
  expect(JSON.stringify(messages)).toBe(before);
  expect(findMcpCall(call)?.clientId).toBe("中文 服务");
  expect(splitLegacyMcpCalls(call).map((part) => part.type)).toEqual([
    "text",
    "call",
    "text",
  ]);
  expect(parseLegacyMcpResponse(messages[1].content)).toEqual({
    clientId: "中文 服务",
    content: '{"result":1}',
  });
});
