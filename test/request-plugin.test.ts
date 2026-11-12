/** @jest-environment node */
import { jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { SourceTextModule } from "node:vm";
import {
  installPlugin,
  parsePluginPackage,
} from "../app/request-plugins/schema";
import { pluginSessionId } from "../app/request-plugins/identity";
import type { Endpoint } from "../app/utils/endpoints";

const hook = jest.fn(
  async (_source: string, method: string, args: unknown[]) =>
    method === "prepareRequest" ? args[0] : null,
);
jest.unstable_mockModule("@/app/request-plugins/worker", () => ({
  callPlugin: hook,
}));
jest.unstable_mockModule("@/app/request-plugins/local-services", () => ({
  supportsLocalServices: () => true,
}));
const { useAppConfig } = await import("../app/store/config");
const { resolveRequestPlugin, createPluginSession } = await import(
  "../app/request-plugins/host"
);
const { consumeDriverResponse } = await import("../app/request-plugins/driver");
const { fetchEndpointModels } = await import("../app/client/endpoint-models");
const { runEndpointChat } = await import("../app/client/endpoint-stream");

const pkg = parsePluginPackage({
  manifest: {
    sdkVersion: 1,
    id: "example.generic",
    version: "1.0.0",
    name: "Generic",
    description: "Adapter",
    protocols: ["anthropic"],
    capabilities: ["request"],
    fields: {},
  },
  source: "export const prepareRequest = (request) => request;",
});
const endpoint: Endpoint = {
  id: "ep",
  name: "test",
  protocol: "anthropic",
  baseUrl: "https://gateway.test",
  apiKey: "dummy",
  models: [],
  requestPlugin: {
    id: pkg.manifest.id,
    version: pkg.manifest.version,
    config: {},
  },
};
const claude = parsePluginPackage(
  JSON.parse(
    readFileSync(
      "public/request-plugins/nextchat.claude-code-4.0.0.json",
      "utf8",
    ),
  ),
);
const module = new SourceTextModule(claude.source);
await module.link(() => {
  throw new Error("The installed package must be self-contained");
});
await module.evaluate();
const hooks = module.namespace as {
  prepareChat: (chat: any, context: any) => any;
  prepareRequest: (request: any, context: any) => any;
};

beforeEach(() => {
  useAppConfig.setState({ requestPlugins: installPlugin([], pkg) });
  hook.mockReset();
  hook.mockImplementation(async (_source, method, args) =>
    method === "prepareRequest" ? args[0] : null,
  );
});

test("packages retain immutable versions and bindings require an enabled package", () => {
  expect(() =>
    parsePluginPackage({
      ...pkg,
      manifest: { ...pkg.manifest, sdkVersion: 99 },
    }),
  ).toThrow();
  expect(() =>
    installPlugin(installPlugin([], pkg), { ...pkg, source: "changed" }),
  ).toThrow(/different contents/);
  const newer = { ...pkg, manifest: { ...pkg.manifest, version: "2.0.0" } };
  useAppConfig.setState({
    requestPlugins: installPlugin(installPlugin([], pkg), newer),
  });
  expect(resolveRequestPlugin(endpoint)?.manifest.version).toBe("1.0.0");
  useAppConfig.setState({ requestPlugins: [{ ...pkg, enabled: false }] });
  expect(() => resolveRequestPlugin(endpoint)).toThrow(/disabled/);
});

test("plugin identity is stable per endpoint and conversation", () => {
  expect(pluginSessionId("ep", "chat")).toMatch(
    /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-a[\da-f]{3}-[\da-f]{12}$/,
  );
  expect(pluginSessionId("ep", "chat")).toBe(pluginSessionId("ep", "chat"));
  expect(pluginSessionId("ep2", "chat")).not.toBe(
    pluginSessionId("ep", "chat"),
  );
});

test("hooks cannot redirect endpoint credentials or return a transport extension", async () => {
  hook.mockResolvedValue({ url: "https://unexpected.test", headers: {} });
  const session = createPluginSession(endpoint, "chat", "chat")!;
  await expect(
    session.request({ url: endpoint.baseUrl, headers: {} }),
  ).rejects.toThrow(/destination/);
  hook.mockResolvedValue({
    url: endpoint.baseUrl,
    headers: {},
    transport: { profile: "x" },
  });
  await expect(
    session.request({ url: endpoint.baseUrl, headers: {} }),
  ).rejects.toThrow(/no longer supported/);
  expect(() =>
    parsePluginPackage({
      ...pkg,
      manifest: { ...pkg.manifest, capabilities: ["transport"] },
    }),
  ).toThrow(/no longer supported/);
});

test("Claude 4.0 selects only the registered driver or configured bridge and does not list models", async () => {
  useAppConfig.setState({ requestPlugins: installPlugin([], claude) });
  hook.mockImplementation(async (_source, method, args) =>
    method === "prepareChat"
      ? hooks.prepareChat(args[0], args[1])
      : hooks.prepareRequest(args[0], args[1]),
  );
  const bound: Endpoint = {
    ...endpoint,
    requestPlugin: {
      id: claude.manifest.id,
      version: claude.manifest.version,
      config: {
        connection: "builtin",
        authType: "api-key",
        nativeBeta: "test-beta",
      },
    },
  };
  const session = createPluginSession(bound, "chat", "chat")!;
  const prepared = await session.chat({
    messages: [{ role: "user", content: "hello" }],
    model: "model",
    enableTools: true,
  });
  expect(prepared).toMatchObject({
    hostDriver: "claude-code",
    input: {
      endpoint: { baseUrl: "https://gateway.test", apiKey: "dummy" },
      betas: ["test-beta"],
    },
  });
  await expect(fetchEndpointModels(bound)).rejects.toThrow(
    /Add models manually/,
  );
  const external = createPluginSession(
    {
      ...bound,
      requestPlugin: {
        ...bound.requestPlugin!,
        config: {
          connection: "external",
          authType: "api-key",
          bridgeUrl: "https://bridge.test",
          bridgeToken: "long-token-123456789",
          nativeCliVersion: "2.1.322",
        },
      },
    },
    "chat",
    "chat",
  )!;
  expect(
    await external.chat({
      messages: [{ role: "user", content: "hello" }],
      model: "model",
      enableTools: false,
    }),
  ).toMatchObject({ url: "https://bridge.test/v1/drivers/claude-code/chat" });
  hook.mockResolvedValue({ hostDriver: "arbitrary-executable" });
  await expect(
    session.chat({ messages: [], model: "m", enableTools: false }),
  ).rejects.toThrow();
});

test("generic hooks apply to each tool continuation without losing signed blocks", async () => {
  hook.mockImplementation(async (_source, _method, args) => {
    const request = args[0] as any;
    request.body.system ??= [];
    request.body.system.push({ type: "text", text: "one marker" });
    return {
      ...request,
      headers: { ...request.headers, "x-plugin": "active" },
    };
  });
  let calls = 0;
  const sse = (...events: unknown[]) =>
    new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  const send = jest.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(body.system).toHaveLength(1);
    if (++calls === 1)
      return sse(
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "thinking",
            thinking: "thought",
            signature: "signed",
          },
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "call",
            name: "lookup",
            input: {},
          },
        },
        { type: "message_stop" },
      );
    expect(body.messages.at(-2).content[0].signature).toBe("signed");
    return sse(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "done" },
      },
      { type: "message_stop" },
    );
  });
  const onFinish = jest.fn(),
    onError = jest.fn();
  await runEndpointChat(
    endpoint,
    {
      model: "model",
      messages: [{ role: "user", content: "test" }],
      stream: true,
      tools: [
        { type: "function", function: { name: "lookup", parameters: {} } },
      ],
    },
    { onFinish, onError },
    { lookup: async () => "result" },
    send,
  );
  expect(onError).not.toHaveBeenCalled();
  expect(onFinish).toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(2);
});

test("model discovery passes the models operation without introducing a request body", async () => {
  const send = jest.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.body).toBeUndefined();
    return Response.json({ data: [{ id: "claude" }], has_more: false });
  });
  await fetchEndpointModels(endpoint, send);
  expect((hook.mock.calls[0][2][1] as any).operation).toBe("models");
});

test("driver NDJSON preserves UTF-8 chunks and requires explicit completion", async () => {
  const bytes = new TextEncoder().encode(
    '{"type":"thinking","text":"思考"}\n{"type":"text","text":"你好"}\n{"type":"done"}\n',
  );
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
  );
  const finish = jest.fn(),
    update = jest.fn();
  await consumeDriverResponse(
    response,
    {
      messages: [],
      config: { model: "m" },
      onFinish: finish,
      onUpdate: update,
    },
    new AbortController().signal,
  );
  expect(finish.mock.calls[0][0]).toContain("你好");
  expect(finish.mock.calls[0][0]).toContain("思考");
  expect(update).toHaveBeenCalledTimes(2);
  await expect(
    consumeDriverResponse(
      new Response('{"type":"text","text":"partial"}\n'),
      { messages: [], config: { model: "m" }, onFinish: finish },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/before completion/);
});

test("aborting a stalled driver stream cannot report successful completion", async () => {
  const cancelled = jest.fn<() => void>();
  const controller = new AbortController();
  const finish = jest.fn();
  const work = consumeDriverResponse(
    new Response(new ReadableStream({ cancel: cancelled })),
    { messages: [], config: { model: "m" }, onFinish: finish },
    controller.signal,
  );
  controller.abort();
  await expect(work).rejects.toThrow(/Aborted/);
  expect(cancelled).toHaveBeenCalled();
  expect(finish).not.toHaveBeenCalled();
});
