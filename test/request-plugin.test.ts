/** @jest-environment node */
import { jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { SourceTextModule } from "node:vm";
import {
  installPlugin,
  parsePluginPackage,
} from "../app/request-plugins/schema";
import { pluginSessionId } from "../app/request-plugins/identity";
import type { PluginRequest } from "../app/request-plugins/sdk";
import type { Endpoint } from "../app/utils/endpoints";

const hook = jest.fn(
  async (_source: string, method: string, args: unknown[]) =>
    method === "prepareRequest" ? args[0] : null,
);
jest.unstable_mockModule("@/app/request-plugins/worker", () => ({
  callPlugin: hook,
}));
const { useAppConfig } = await import("../app/store/config");
const { resolveRequestPlugin, createPluginSession } = await import(
  "../app/request-plugins/host"
);
const { runEndpointChat } = await import("../app/client/endpoint-stream");
const { consumeDriverResponse } = await import("../app/request-plugins/driver");
const { fetchEndpointModels } = await import("../app/client/endpoint-models");

const pkg = parsePluginPackage(
  JSON.parse(
    readFileSync(
      "public/request-plugins/nextchat.claude-code-1.0.0.json",
      "utf8",
    ),
  ),
);
const endpoint: Endpoint = {
  id: "ep",
  name: "plugin",
  protocol: "anthropic",
  baseUrl: "https://gateway.test",
  apiKey: "dummy",
  models: [],
  requestPlugin: {
    id: pkg.manifest.id,
    version: pkg.manifest.version,
    config: { mode: "simulate" },
  },
};

const httpPackage = parsePluginPackage(
  JSON.parse(
    readFileSync(
      "public/request-plugins/nextchat.claude-code-2.0.0.json",
      "utf8",
    ),
  ),
);
const httpModule = new SourceTextModule(httpPackage.source);
await httpModule.link(() => {
  throw new Error("The installed plugin must be self-contained");
});
await httpModule.evaluate();
const httpPlugin = httpModule.namespace as {
  prepareRequest: (request: PluginRequest, context: any) => PluginRequest;
};
const httpEndpoint = {
  ...endpoint,
  requestPlugin: {
    id: httpPackage.manifest.id,
    version: httpPackage.manifest.version,
    config: {},
  },
};

const wirePackage = parsePluginPackage(
  JSON.parse(
    readFileSync(
      "public/request-plugins/nextchat.claude-code-3.0.0-beta.2.json",
      "utf8",
    ),
  ),
);
const wireModule = new SourceTextModule(wirePackage.source);
await wireModule.link(() => {
  throw new Error("Wire plugin must be self-contained");
});
await wireModule.evaluate();
const wirePlugin = wireModule.namespace as typeof httpPlugin;
const wireEndpoint: Endpoint = {
  ...endpoint,
  requestPlugin: {
    id: wirePackage.manifest.id,
    version: wirePackage.manifest.version,
    config: {
      transportUrl: "http://127.0.0.1:8789",
      transportToken: "fixture-wire-secret-token",
    },
  },
};

beforeEach(() => {
  useAppConfig.setState({ requestPlugins: installPlugin([], pkg) });
  hook.mockReset();
  hook.mockImplementation(async (_source, method, args) =>
    method === "prepareRequest" ? args[0] : null,
  );
});

test("packages have an SDK contract and immutable versions; endpoint versions remain pinned", () => {
  expect(() =>
    parsePluginPackage({
      ...pkg,
      manifest: { ...pkg.manifest, sdkVersion: 99 },
    }),
  ).toThrow();
  expect(() =>
    installPlugin(installPlugin([], pkg), { ...pkg, source: "changed" }),
  ).toThrow(/different contents/);
  const upgraded = { ...pkg, manifest: { ...pkg.manifest, version: "2.0.0" } };
  useAppConfig.setState({
    requestPlugins: installPlugin(installPlugin([], pkg), upgraded),
  });
  expect(resolveRequestPlugin(endpoint)?.manifest.version).toBe("1.0.0");
  useAppConfig.setState({ requestPlugins: [{ ...pkg, enabled: false }] });
  expect(() => resolveRequestPlugin(endpoint)).toThrow(/disabled/);
  useAppConfig.setState({ requestPlugins: [] });
  expect(() => resolveRequestPlugin(endpoint)).toThrow(/missing/);
  expect(
    resolveRequestPlugin({ ...endpoint, requestPlugin: undefined }),
  ).toBeUndefined();
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

test("hooks cannot silently reroute credentials to an unrelated origin", async () => {
  hook.mockResolvedValue({ url: "https://unexpected.test", headers: {} });
  const session = createPluginSession(endpoint, "chat", "chat")!;
  await expect(
    session.request({ url: endpoint.baseUrl, headers: {} }),
  ).rejects.toThrow(/destination/);
});

test("SDK 2 transports preserve the upstream envelope and never silently fall back", async () => {
  expect(() =>
    parsePluginPackage({
      ...wirePackage,
      manifest: { ...wirePackage.manifest, sdkVersion: 1 },
    }),
  ).toThrow(/SDK 2/);
  useAppConfig.setState({ requestPlugins: installPlugin([], wirePackage) });
  hook.mockImplementation(async (_source, _method, args) =>
    wirePlugin.prepareRequest(args[0] as PluginRequest, args[1]),
  );
  const extension = createPluginSession(wireEndpoint, "wire-chat", "chat")!;
  const original = {
    url: "https://gateway.test/v1/messages",
    headers: { "x-api-key": "dummy" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "你好" }],
      stream: true,
    },
  };
  const wire = await extension.request(original);
  const send = jest.fn(async (url: string, options?: RequestInit) => {
    expect(url).toBe("http://127.0.0.1:8789/v1/requests");
    expect(new Headers(options?.headers).get("authorization")).toBe(
      "Bearer fixture-wire-secret-token",
    );
    const envelope = JSON.parse(String(options?.body));
    expect(envelope.url).toBe("https://gateway.test/v1/messages?beta=true");
    expect(envelope.headers).toContainEqual(["X-Stainless-OS", "Windows"]);
    expect(envelope.body).toBe(JSON.stringify(wire.body));
    expect(envelope.profile).toBe("bun-1.4.4-38afee6c8-win32-x64");
    expect(options?.redirect).toBe("manual");
    throw new Error("relay unavailable");
  });
  await expect(extension.fetch(wire, "POST", send)).rejects.toThrow(
    "relay unavailable",
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(original.headers).toEqual({ "x-api-key": "dummy" });
});

test("wire plugin runs through tool rounds and model operations", async () => {
  useAppConfig.setState({ requestPlugins: installPlugin([], wirePackage) });
  hook.mockImplementation(async (_source, _method, args) =>
    wirePlugin.prepareRequest(args[0] as PluginRequest, args[1]),
  );
  const onError = jest.fn(),
    onFinish = jest.fn();
  let round = 0;
  const sse = (events: unknown[]) =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  const send = jest.fn(async (url: string, options?: RequestInit) => {
    expect(url).toBe("http://127.0.0.1:8789/v1/requests");
    const envelope = JSON.parse(String(options?.body));
    const body = JSON.parse(envelope.body);
    expect(envelope.method).toBe("POST");
    expect(body.system).toHaveLength(3);
    if (++round === 1)
      return sse([
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "thinking",
            thinking: "t",
            signature: "keep-signed",
          },
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "lookup",
            input: {},
          },
        },
        { type: "message_stop" },
      ]);
    expect(body.messages.at(-2).content[0].signature).toBe("keep-signed");
    expect(body.messages.at(-1).content[0].tool_use_id).toBe("tool-1");
    return sse([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "done" },
      },
      { type: "message_stop" },
    ]);
  });
  await runEndpointChat(
    wireEndpoint,
    {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "lookup" }],
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
  const models = {
    ...wireEndpoint,
    requestPlugin: {
      ...wireEndpoint.requestPlugin!,
      config: { ...wireEndpoint.requestPlugin!.config, modelList: "standard" },
    },
  };
  await fetchEndpointModels(models, async (_url, options) => {
    const envelope = JSON.parse(String(options?.body));
    expect(envelope.method).toBe("GET");
    expect(envelope.body).toBeUndefined();
    return Response.json({ data: [{ id: "claude" }], has_more: false });
  });
});

test.each(["fixture", "interactive-http"])(
  "%s tool continuations apply hooks to fresh wire copies and retain signed blocks",
  async (kind) => {
    const actual = kind === "interactive-http";
    if (actual)
      useAppConfig.setState({ requestPlugins: installPlugin([], httpPackage) });
    hook.mockImplementation(async (_source, _method, args) => {
      const request = args[0] as PluginRequest;
      if (actual) return httpPlugin.prepareRequest(request, args[1]);
      (request.body!.system as unknown[]) ??= [];
      (request.body!.system as unknown[]).push({
        type: "text",
        text: "one marker",
      });
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
      expect(body.system).toHaveLength(actual ? 3 : 1);
      if (actual) {
        expect(body.system[0].text).toContain("cc_entrypoint=cli;");
        expect(new Headers(init?.headers).get("user-agent")).toBe(
          "claude-cli/2.1.322 (external, cli)",
        );
        expect(JSON.parse(body.metadata.user_id).session_id).toBe(
          new Headers(init?.headers).get("x-claude-code-session-id"),
        );
      } else expect(new Headers(init?.headers).get("x-plugin")).toBe("active");
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
      expect(body.messages.at(-1).content[0].type).toBe("tool_result");
      return sse(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "done" },
        },
        { type: "message_stop" },
      );
    });
    const finish = jest.fn(),
      error = jest.fn();
    await runEndpointChat(
      actual ? httpEndpoint : endpoint,
      {
        model: "model",
        messages: [{ role: "user", content: "test" }],
        stream: true,
        tools: [
          { type: "function", function: { name: "lookup", parameters: {} } },
        ],
      },
      { onFinish: finish, onError: error },
      { lookup: async () => "result" },
      send,
    );
    expect(error).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
  },
);

test("HTTP-only package handles auxiliary requests and rejects manual model discovery without sending", async () => {
  useAppConfig.setState({ requestPlugins: installPlugin([], httpPackage) });
  hook.mockImplementation(async (_source, _method, args) =>
    httpPlugin.prepareRequest(args[0] as PluginRequest, args[1]),
  );
  const session = createPluginSession(httpEndpoint, "auxiliary", "chat")!;
  expect(
    await session.chat({ messages: [], model: "m", enableTools: false }),
  ).toBeNull();
  expect(hook).not.toHaveBeenCalled();
  const send = jest.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(body.stream).toBe(false);
    expect(body.system[0].text).toContain("cc_entrypoint=cli;");
    return Response.json({
      content: [{ type: "text", text: "A title" }],
      stop_reason: "end_turn",
    });
  });
  const onError = jest.fn(),
    onFinish = jest.fn();
  await runEndpointChat(
    httpEndpoint,
    {
      model: "model",
      messages: [{ role: "user", content: "Make a title" }],
      stream: false,
    },
    { onFinish, onError },
    {},
    send,
  );
  expect(onError).not.toHaveBeenCalled();
  expect(onFinish.mock.calls[0][0]).toBe("A title");
  send.mockClear();
  await expect(fetchEndpointModels(httpEndpoint, send)).rejects.toThrow(
    /Add models manually/,
  );
  expect(send).not.toHaveBeenCalled();
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
  const cancelled = jest.fn(() => {});
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
