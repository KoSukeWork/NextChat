/** @jest-environment node */
import { jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { SourceTextModule } from "node:vm";
import {
  installPlugin,
  parsePluginPackage,
} from "../app/request-plugins/schema";
import type { Endpoint } from "../app/utils/endpoints";

const hook = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule("@/app/request-plugins/worker", () => ({
  callPlugin: hook,
}));
jest.unstable_mockModule("@/app/request-plugins/local-services", () => ({
  supportsLocalServices: () => true,
}));
const { useAppConfig } = await import("../app/store/config");
const { createPluginSession } = await import("../app/request-plugins/host");
const { fetchEndpointModels } = await import("../app/client/endpoint-models");
const pkg = parsePluginPackage(
  JSON.parse(
    readFileSync(
      "public/request-plugins/nextchat.antigravity-1.0.0.json",
      "utf8",
    ),
  ),
);
const module = new SourceTextModule(pkg.source);
await module.link(() => {
  throw new Error("Unexpected plugin import");
});
await module.evaluate();
const hooks = module.namespace as Record<string, (...args: any[]) => any>;

beforeEach(() => {
  useAppConfig.setState({ requestPlugins: installPlugin([], pkg) });
  hook.mockImplementation(
    async (_source, method, args) => hooks[method]?.(...args) ?? null,
  );
});

const endpoint: Endpoint = {
  id: "agy",
  name: "agy",
  protocol: "anthropic",
  baseUrl: "https://gateway.invalid",
  apiKey: "private-gateway-secret",
  models: [],
  requestPlugin: {
    id: "nextchat.antigravity",
    version: "1.0.0",
    config: {
      connection: "external",
      bridgeUrl: "https://bridge.example",
      bridgeToken: "test-bridge-token-123",
      nativeCliVersion: "1.5.11",
    },
  },
};

test("external ACP chat and model discovery never forward the endpoint gateway credentials", async () => {
  const session = createPluginSession(endpoint, "chat", "chat")!;
  const result = await session.chat({
    model: "model-low",
    messages: [{ role: "user", content: "hello" }],
    enableTools: true,
  });
  expect(result).toMatchObject({
    url: "https://bridge.example/v1/drivers/antigravity/chat",
    body: { cliVersion: "1.5.11", model: "model-low" },
  });
  expect(JSON.stringify(result)).not.toContain(endpoint.apiKey);
  expect(JSON.stringify(result)).not.toContain(endpoint.baseUrl);
  const fetcher = jest.fn<typeof fetch>(async (url) => {
    expect(String(url)).toBe(
      "https://bridge.example/v1/drivers/antigravity/models?version=1.5.11",
    );
    return Response.json({
      data: [{ id: "model-low", display_name: "Model (Low)" }],
    });
  });
  expect(await fetchEndpointModels(endpoint, fetcher)).toEqual([
    { name: "model-low", displayName: "Model (Low)" },
  ]);
});

test("built-in driver is registered by the host and receives no gateway fields", async () => {
  const session = createPluginSession(
    {
      ...endpoint,
      requestPlugin: {
        ...endpoint.requestPlugin!,
        config: { connection: "builtin", nativeEffort: "low" },
      },
    },
    "chat",
    "chat",
  )!;
  const result = await session.chat({
    model: "model-low",
    messages: [{ role: "user", content: "hello" }],
    enableTools: false,
  });
  expect(result).toMatchObject({
    hostDriver: "antigravity",
    input: { model: "model-low", reasoningEffort: "low" },
  });
  expect(JSON.stringify(result)).not.toContain(endpoint.apiKey);
  expect(JSON.stringify(result)).not.toContain(endpoint.baseUrl);
  expect(await session.models()).toEqual({ hostDriver: "antigravity" });
});
