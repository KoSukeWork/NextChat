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
const pkg = parsePluginPackage(
  JSON.parse(
    readFileSync(
      "public/request-plugins/nextchat.claude-code-4.1.0.json",
      "utf8",
    ),
  ),
);
const module = new SourceTextModule(pkg.source);
await module.link(() => {
  throw new Error("Unexpected import");
});
await module.evaluate();
const hooks = module.namespace as Record<string, (...args: any[]) => any>;
beforeEach(() => {
  useAppConfig.setState({ requestPlugins: installPlugin([], pkg) });
  hook.mockImplementation(
    async (_source, name, args) => hooks[name]?.(...args) ?? null,
  );
});
const endpoint: Endpoint = {
  id: "subscription",
  name: "Claude",
  protocol: "anthropic",
  baseUrl: "https://private-gateway.example",
  apiKey: "private-gateway-key",
  models: [],
  requestPlugin: {
    id: "nextchat.claude-code",
    version: "4.1.0",
    config: {
      connection: "external",
      credentials: "subscription",
      bridgeUrl: "https://bridge.example",
      bridgeToken: "test-bridge-token-123",
      nativeCliVersion: "2.1.328",
      nativeBeta: "must-not-send",
    },
  },
};
const chat = {
  model: "sonnet",
  messages: [{ role: "user", content: "hi" }],
  enableTools: false,
};

test("external subscription request and worker context omit gateway credentials", async () => {
  const prepared = await createPluginSession(endpoint, "chat", "chat")!.chat(
    chat,
  );
  expect(prepared).toMatchObject({
    url: "https://bridge.example/v1/drivers/claude-code/chat",
    body: { credentials: "subscription", model: "sonnet" },
  });
  const sent = JSON.stringify(prepared);
  expect(sent).not.toContain(endpoint.baseUrl);
  expect(sent).not.toContain(endpoint.apiKey);
  expect(sent).not.toContain("must-not-send");
  const context = hook.mock.calls[0][2][1] as any;
  expect(context.endpoint.baseUrl).toBe("");
  expect(context.endpoint.apiKey).toBe("");
});

test("built-in subscription request omits the gateway and API-only flags", async () => {
  const input = {
    ...endpoint,
    requestPlugin: {
      ...endpoint.requestPlugin!,
      config: {
        connection: "builtin",
        credentials: "subscription",
        nativeBeta: "must-not-send",
      },
    },
  };
  const prepared = await createPluginSession(input, "chat", "chat")!.chat(chat);
  expect(prepared).toMatchObject({
    hostDriver: "claude-code",
    input: { credentials: "subscription" },
  });
  expect(JSON.stringify(prepared)).not.toContain(endpoint.baseUrl);
  expect(JSON.stringify(prepared)).not.toContain(endpoint.apiKey);
  expect(JSON.stringify(prepared)).not.toContain("must-not-send");
});

test("gateway mode retains the endpoint, auth type, and beta flags", async () => {
  const input = {
    ...endpoint,
    requestPlugin: {
      ...endpoint.requestPlugin!,
      config: {
        connection: "external",
        credentials: "gateway",
        authType: "bearer",
        bridgeUrl: "https://bridge.example",
        bridgeToken: "test-bridge-token-123",
        nativeCliVersion: "2.1.328",
        nativeBeta: "beta-one",
      },
    },
  };
  const prepared = await createPluginSession(input, "chat", "chat")!.chat(chat);
  expect(prepared).toMatchObject({
    body: {
      credentials: "gateway",
      endpoint: { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey },
      authType: "bearer",
      betas: ["beta-one"],
    },
  });
});
