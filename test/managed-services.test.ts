/** @jest-environment node */
import { jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { SourceTextModule } from "node:vm";
import {
  installPlugin,
  parsePluginPackage,
  pluginDefaults,
} from "../app/request-plugins/schema";
import type { Endpoint } from "../app/utils/endpoints";
import type { LocalServiceStatus } from "../app/request-plugins/local-services";

const action =
  jest.fn<(action: string, service: string) => Promise<LocalServiceStatus>>();
let desktop = true;
jest.unstable_mockModule("@/app/request-plugins/local-services", () => ({
  supportsLocalServices: () => desktop,
  localServiceAction: action,
}));
const pkg = parsePluginPackage(
  JSON.parse(
    readFileSync(
      "public/request-plugins/nextchat.claude-code-3.2.0-beta.1.json",
      "utf8",
    ),
  ),
);
const module = new SourceTextModule(pkg.source);
await module.link(() => {
  throw new Error("Package must be self-contained");
});
await module.evaluate();
const hooks = module.namespace as any;
jest.unstable_mockModule("@/app/request-plugins/worker", () => ({
  callPlugin: async (_source: string, method: string, args: any[]) =>
    hooks[method](...args),
}));
const send =
  jest.fn<(url: string, options?: RequestInit) => Promise<Response>>();
jest.unstable_mockModule("@/app/utils/endpoint-transport", () => ({
  endpointFetch: send,
}));
const { useAppConfig } = await import("../app/store/config");
const {
  managedServices,
  initializeManagedServices,
  reconcileManagedServices,
  serviceConnectionMode,
} = await import("../app/request-plugins/managed-services");
const { createPluginSession } = await import("../app/request-plugins/host");
const { runEndpointChat } = await import("../app/client/endpoint-stream");
const { runPluginDriver } = await import("../app/request-plugins/driver");
const { fetchEndpointModels } = await import("../app/client/endpoint-models");

const live = new Map<string, LocalServiceStatus>();
let serial = 0;
let unsubscribe = () => {};
const endpoint = (mode = "http", id = "managed"): Endpoint => ({
  id,
  name: "Managed",
  protocol: "anthropic",
  baseUrl: "https://gateway.test",
  apiKey: "dummy",
  models: [{ name: "claude-sonnet-4-6" }],
  requestPlugin: {
    id: pkg.manifest.id,
    version: pkg.manifest.version,
    config: { ...pluginDefaults(pkg), mode },
  },
});
async function settled(check: () => boolean) {
  for (let round = 0; round < 100; round++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Lifecycle did not settle");
}
beforeEach(async () => {
  desktop = true;
  action.mockImplementation(async (method, service) => {
    if (method === "stop") live.delete(service);
    else if (!live.has(service))
      live.set(service, {
        service,
        running: true,
        available: true,
        executablePath: "C:/Tools/claude.exe",
        canSelectExecutable: service === "claude-cli",
        connection: {
          url: `http://127.0.0.1:${52000 + ++serial}`,
          token: `${++serial}`.padStart(64, "0"),
          cliVersion: "2.1.400",
        },
      });
    return (
      live.get(service) ?? {
        service,
        running: false,
        available: true,
        executablePath: "",
        canSelectExecutable: false,
      }
    );
  });
  await managedServices.reconcile(new Set());
  live.clear();
  action.mockClear();
  send.mockReset();
  useAppConfig.setState({
    endpoints: [],
    requestPlugins: installPlugin([], pkg),
    _hasHydrated: true,
  });
});
afterEach(async () => {
  unsubscribe();
  unsubscribe = () => {};
  desktop = true;
  await managedServices.reconcile(new Set());
});

test("saved CLI configuration is ready after hydration without opening settings; a crash refreshes credentials", async () => {
  const saved = endpoint("cli");
  useAppConfig.setState({ endpoints: [saved], _hasHydrated: false });
  unsubscribe = initializeManagedServices();
  expect(action).not.toHaveBeenCalled();
  useAppConfig.setState({ _hasHydrated: true });
  await settled(
    () =>
      !!useAppConfig.getState().endpoints[0].requestPlugin?.config.bridgeToken,
  );
  const old = useAppConfig.getState().endpoints[0];
  expect(old.requestPlugin!.config.nativeCliVersion).toBe("2.1.400");
  live.delete("claude-cli");
  const session = createPluginSession(old, "restart", "chat")!;
  try {
    const request = await session.chat({
      messages: [{ role: "user", content: "hi" }],
      model: "claude-sonnet-4-6",
      enableTools: false,
    });
    const current = live.get("claude-cli")!.connection!;
    expect(request!.url).toBe(`${current.url}/v1/drivers/claude-code/chat`);
    expect(request!.headers.authorization).toBe(`Bearer ${current.token}`);
    expect(current.token).not.toBe(old.requestPlugin!.config.bridgeToken);
    expect(
      useAppConfig.getState().endpoints[0].requestPlugin!.localServices,
    ).toEqual({ "claude-cli": "managed" });
  } finally {
    await session.dispose();
  }
});

test.each(["finish", "cancel"])(
  "HTTP stream retains its old mode until %s, then stops automatically",
  async (end) => {
    const saved = endpoint();
    useAppConfig.setState({ endpoints: [saved] });
    unsubscribe = initializeManagedServices();
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    let controller!: AbortController;
    send.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(value) {
            writer = value;
          },
        }),
      ),
    );
    const errors = jest.fn();
    const chat = runEndpointChat(
      saved,
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      {
        onFinish: jest.fn(),
        onError: errors,
        onController: (value) => (controller = value),
      },
      {},
      send,
    );
    await settled(() => send.mock.calls.length > 0);
    expect(send.mock.calls[0][0]).toBe(
      `${live.get("wire")!.connection!.url}/v1/requests`,
    );
    useAppConfig.setState({ endpoints: [endpoint("cli")] });
    await settled(() => live.has("claude-cli"));
    expect(live.has("wire")).toBe(true);
    if (end === "cancel") controller.abort();
    else {
      writer.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      writer.close();
    }
    await chat;
    expect(errors).not.toHaveBeenCalled();
    expect(live.has("wire")).toBe(false);
  },
);

test("CLI NDJSON keeps a service lease through consumption and releases it on error", async () => {
  const saved = endpoint("cli");
  useAppConfig.setState({ endpoints: [saved] });
  unsubscribe = initializeManagedServices();
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  send.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(value) {
          writer = value;
        },
      }),
    ),
  );
  const chat = runPluginDriver(saved, [{ role: "user", content: "hi" }], {
    messages: [],
    config: { model: "claude-sonnet-4-6" },
    onFinish: jest.fn(),
  });
  const expected = expect(chat).rejects.toThrow("fixture-error");
  await settled(() => send.mock.calls.length > 0);
  useAppConfig.setState({ endpoints: [endpoint("http")] });
  await settled(() => live.has("wire"));
  expect(live.has("claude-cli")).toBe(true);
  writer.enqueue(
    new TextEncoder().encode('{"type":"error","message":"fixture-error"}\n'),
  );
  await expected;
  expect(live.has("claude-cli")).toBe(false);
});

test("another endpoint retains its service; disabling the plugin removes all idle helpers", async () => {
  useAppConfig.setState({
    endpoints: [endpoint("http", "one"), endpoint("cli", "two")],
  });
  unsubscribe = initializeManagedServices();
  await settled(() => live.size === 2);
  useAppConfig.setState({
    endpoints: [endpoint("cli", "one"), endpoint("http", "two")],
  });
  await reconcileManagedServices();
  expect(live.size).toBe(2);
  useAppConfig.setState({ requestPlugins: [{ ...pkg, enabled: false }] });
  await settled(() => live.size === 0);
});

test("saving an idle mode switch starts the selected service and stops the old one", async () => {
  useAppConfig.setState({ endpoints: [endpoint("http")] });
  unsubscribe = initializeManagedServices();
  await settled(() => live.has("wire"));
  useAppConfig.setState({ endpoints: [endpoint("cli")] });
  await settled(() => live.has("claude-cli") && !live.has("wire"));
  expect(
    useAppConfig.getState().endpoints[0].requestPlugin!.config.bridgeToken,
  ).toBeTruthy();
  useAppConfig.setState({ endpoints: [] });
  await settled(() => live.size === 0);
});

test("model discovery retains the service until its response body has been read", async () => {
  const saved = endpoint("http");
  saved.requestPlugin!.config.modelList = "standard";
  useAppConfig.setState({ endpoints: [saved] });
  unsubscribe = initializeManagedServices();
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  send.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(value) {
          writer = value;
        },
      }),
    ),
  );
  const models = fetchEndpointModels(saved, send);
  await settled(() => send.mock.calls.length > 0);
  useAppConfig.setState({ endpoints: [] });
  await reconcileManagedServices();
  expect(live.has("wire")).toBe(true);
  writer.enqueue(new TextEncoder().encode('{"data":[{"id":"test-model"}]}'));
  writer.close();
  await expect(models).resolves.toEqual([{ name: "test-model" }]);
  expect(live.size).toBe(0);
});

test("external URLs, explicit external localhost, and web builds never acquire local helpers", async () => {
  for (const [url, external] of [
    ["https://bridge.test", false],
    ["http://127.0.0.1:54000", true],
  ] as const) {
    const saved = endpoint("cli");
    saved.requestPlugin!.config.bridgeUrl = url;
    saved.requestPlugin!.config.bridgeToken = "a".repeat(64);
    if (external)
      saved.requestPlugin!.localServices = { "claude-cli": "external" };
    const session = createPluginSession(saved, "external", "chat")!;
    await session.chat({ messages: [], model: "m", enableTools: false });
    await session.dispose();
  }
  desktop = false;
  const web = endpoint("cli");
  web.requestPlugin!.config.bridgeToken = "web-manual-token";
  const session = createPluginSession(web, "web", "chat")!;
  await session.chat({ messages: [], model: "m", enableTools: false });
  await session.dispose();
  expect(action).not.toHaveBeenCalled();
});

test("preview never launches a helper; old desktop generated settings migrate without a new setup step", async () => {
  const saved = endpoint("cli");
  const service = pkg.manifest.localServices!.find(
    (service) => service.id === "claude-cli",
  )!;
  saved.requestPlugin!.config.bridgeUrl = "http://127.0.0.1:55000";
  saved.requestPlugin!.config.bridgeToken = "b".repeat(64);
  expect(serviceConnectionMode(saved.requestPlugin!, service, pkg)).toBe(
    "managed",
  );
  const session = createPluginSession(saved, "preview", "chat", {
    preview: true,
  })!;
  const request = await session.chat({
    messages: [],
    model: "m",
    enableTools: false,
  });
  await session.dispose();
  expect(request!.headers.authorization).toContain("placeholder");
  expect(action).not.toHaveBeenCalled();
  saved.requestPlugin!.config.bridgeUrl = "http://127.0.0.1:8788";
  expect(serviceConnectionMode(saved.requestPlugin!, service, pkg)).toBe(
    "external",
  );
});
