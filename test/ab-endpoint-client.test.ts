import { jest } from "@jest/globals";
import type { EndpointChatInput } from "../app/client/endpoint-protocol";

const run = jest.fn(
  async (
    _endpoint: unknown,
    _input: EndpointChatInput,
    _callbacks: unknown,
    _funcs: Record<string, Function>,
  ) => {},
);
const enabled = jest.fn(async () => true);
const getTools = jest.fn<() => Promise<any[]>>(async () => []);
const execute = jest.fn(
  async (_client: string, _request: unknown, _code: string) => ({
    content: [{ type: "text", text: "ok" }],
  }),
);
jest.unstable_mockModule("@/app/client/endpoint-stream", () => ({
  runEndpointChat: run,
}));
jest.unstable_mockModule("@/app/mcp/actions", () => ({
  isMcpEnabled: enabled,
  getAllTools: getTools,
  executeMcpAction: execute,
}));
const { EndpointClient } = await import("../app/client/endpoint-client");
const { useAppConfig } = await import("../app/store/config");
const { useAccessStore } = await import("../app/store/access");

beforeEach(() => {
  run.mockClear();
  enabled.mockClear();
  getTools.mockReset();
  getTools.mockResolvedValue([]);
  execute.mockClear();
});

test("title and summary requests do not inherit tools or optional model settings", async () => {
  useAppConfig.setState({
    modelConfig: {
      ...useAppConfig.getState().modelConfig,
      enableTemperature: true,
      enableTopP: true,
      enableMaxTokens: true,
      enablePresencePenalty: true,
      enableFrequencyPenalty: true,
      enableReasoningSummary: true,
      reasoningEffort: "high",
    },
  });
  const client = new EndpointClient({
    id: "ep",
    name: "EP",
    protocol: "openai-responses",
    baseUrl: "https://example.test",
    apiKey: "",
    models: [],
  });
  for (const stream of [false, true])
    await client.chat({
      messages: [{ role: "user", content: "test" }],
      config: { model: "m", stream },
      pluginIds: ["ignored"],
      onFinish: jest.fn(),
    });
  expect(enabled).not.toHaveBeenCalled();
  expect(getTools).not.toHaveBeenCalled();
  for (const [, input] of run.mock.calls)
    expect(input).toMatchObject({
      tools: [],
      enableTemperature: false,
      enableTopP: false,
      enableMaxTokens: false,
      enablePresencePenalty: false,
      enableFrequencyPenalty: false,
      enableReasoningSummary: false,
      reasoningEffort: undefined,
    });
});

test("main conversation connects MCP tools with the current access code", async () => {
  useAccessStore.setState({ accessCode: "synthetic-access" });
  getTools.mockResolvedValue([
    {
      clientId: "中文服务",
      tools: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] },
    },
  ]);
  const client = new EndpointClient({
    id: "ep",
    name: "EP",
    protocol: "openai-chat",
    baseUrl: "https://example.test",
    apiKey: "",
    models: [],
  });
  await client.chat({
    messages: [{ role: "user", content: "test" }],
    config: { model: "m", stream: true },
    enableTools: true,
    onFinish: jest.fn(),
  });
  expect(getTools).toHaveBeenCalledWith("synthetic-access", undefined);
  const [, config, , funcs] = run.mock.calls[0];
  const wire = config.tools![0].function.name;
  expect(config.toolDisplay![wire]).toMatchObject({
    server: "中文服务",
    name: "lookup",
  });
  await funcs[wire]({ q: 1 });
  expect(execute).toHaveBeenCalledWith(
    "中文服务",
    { method: "tools/call", params: { name: "lookup", arguments: { q: 1 } } },
    "synthetic-access",
  );
});

test("old session settings missing new flags use their own defaults", async () => {
  useAppConfig.setState({
    modelConfig: {
      ...useAppConfig.getState().modelConfig,
      enableTemperature: true,
      enableReasoningSummary: false,
      reasoningEffort: "high",
    },
  });
  const client = new EndpointClient({
    id: "ep",
    name: "EP",
    protocol: "openai-responses",
    baseUrl: "https://example.test",
    apiKey: "",
    models: [],
  });
  await client.chat({
    messages: [{ role: "user", content: "test" }],
    config: { model: "old", stream: true },
    enableTools: true,
    onFinish: jest.fn(),
  });
  expect(run.mock.calls[0][1]).toMatchObject({
    enableTemperature: false,
    enableReasoningSummary: true,
    reasoningEffort: undefined,
  });
});

test("conversation exclusions filter native tools, text descriptions and text calls", async () => {
  useAccessStore.setState({ accessCode: "synthetic-access" });
  const servers = ["enabled", "disabled"].map((clientId) => ({
    clientId,
    tools: { tools: [{ name: "lookup", description: `tool-${clientId}` }] },
  }));
  // Exercise the client's own boundary even if an action returns too much.
  getTools.mockResolvedValue(servers);
  const client = new EndpointClient({
    id: "ep", name: "EP", protocol: "openai-chat",
    baseUrl: "https://example.test", apiKey: "", models: [], toolCalling: "text",
  });
  const options = {
    messages: [{ role: "user" as const, content: "test" }],
    config: { model: "m" }, enableTools: true, onFinish: jest.fn(),
  };
  await client.chat(options);
  expect(run.mock.calls[0][1].tools).toHaveLength(2);
  expect(run.mock.calls[0][1].textToolPrompt).toContain("tool-disabled");

  await client.chat({ ...options, mcpDisabled: ["disabled"] });
  expect(getTools).toHaveBeenLastCalledWith("synthetic-access", ["disabled"]);
  const [, input, , funcs] = run.mock.calls[1];
  expect(input.tools).toHaveLength(1);
  expect(input.textToolPrompt).toContain("tool-enabled");
  expect(input.textToolPrompt).not.toContain("tool-disabled");
  const call = { method: "tools/call", params: { name: "lookup", arguments: {} } };
  await expect(input.executeTextTool!("disabled", call)).rejects.toThrow("not registered");
  await expect(input.executeTextTool!("enabled", { ...call, params: { name: "other" } })).rejects.toThrow("not registered");
  expect(execute).not.toHaveBeenCalled();
  await input.executeTextTool!("enabled", call);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(Object.keys(funcs)).toHaveLength(1);
  expect(Object.values(input.toolDisplay ?? {}).map((entry) => entry.server)).toEqual(["enabled"]);

  await client.chat({ ...options, mcpDisabled: ["enabled", "disabled"] });
  const allDisabled = run.mock.calls[2][1];
  expect(allDisabled.tools).toEqual([]);
  expect(allDisabled.textToolPrompt).toBe("");
  await expect(allDisabled.executeTextTool!("enabled", call)).rejects.toThrow("not registered");
  expect(execute).toHaveBeenCalledTimes(1);
});
