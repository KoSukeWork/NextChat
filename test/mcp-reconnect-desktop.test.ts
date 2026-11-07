import { jest } from "@jest/globals";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { McpConnectionError, McpRequestNotSent } from "../app/mcp/reconnect";

// JSDOM's AbortSignal predates the browser's built-in one-shot timeout API.
if (!AbortSignal.timeout) {
  Object.defineProperty(AbortSignal, "timeout", {
    value: (ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    },
  });
}

const { OAuthLoginNeeded, OAuthPreRegisteredClientRequired } = await import("../app/mcp/oauth");
type Mode = "error" | "ready" | "login" | "unsupported" | "gate";
const modes = new Map<string, Mode>();
const attempts = new Map<string, number>();
const connectionUrls = new Map<string, string[]>();
const connectedClients = new Map<string, any>();
let nativeCommands: string[] = [];
let gate: Promise<void> = Promise.resolve();
let notifyStarted: (id: string) => void = () => {};
let callMode: "ok" | "timeout" | "rpc" | "is-error" | "safe-once" = "ok";
let timeoutError: McpError;
let calls = 0;
let received = 0;
let closed = 0;
const createRemoteClient = jest.fn(async (id: string, server: { url: string }) => {
  attempts.set(id, (attempts.get(id) ?? 0) + 1);
  connectionUrls.set(id, [...(connectionUrls.get(id) ?? []), server.url]);
  const mode = modes.get(id);
  if (mode === "error") throw new Error("NETWORK_REFUSED");
  if (mode === "login") throw new OAuthLoginNeeded();
  if (mode === "unsupported") throw new OAuthPreRegisteredClientRequired();
  if (mode === "gate") { notifyStarted(id); await gate; }
  const client: any = {
    listTools: async () => ({ tools: [{ name: "echo", inputSchema: {} }] }),
    close: async () => { closed++; client.onclose?.(); },
    request: async () => {
      calls++;
      if (callMode === "timeout") { received++; throw timeoutError; }
      if (callMode === "rpc") { received++; throw new McpError(ErrorCode.InvalidParams, "Invalid params"); }
      if (callMode === "is-error") { received++; return { isError: true, content: [{ type: "text", text: "missing" }] }; }
      if (callMode === "safe-once" && calls === 1) {
        const error = new McpRequestNotSent("closed");
        client.onerror?.(error);
        throw error;
      }
      received++;
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  connectedClients.set(id, client);
  return client;
});
jest.unstable_mockModule("@/app/mcp/remote", () => ({
  createRemoteClient,
  nativeMcpFetch: async () => new Response(),
  safeRemoteError: (error: unknown) => error instanceof Error ? error.message : String(error),
}));
const actions = await import("../app/mcp/actions-tauri");
let config: { mcpServers: Record<string, any> };
let created: string[];

beforeEach(() => {
  config = { mcpServers: {} };
  created = [];
  modes.clear();
  attempts.clear();
  connectionUrls.clear();
  connectedClients.clear();
  nativeCommands = [];
  calls = 0;
  received = 0;
  closed = 0;
  callMode = "ok";
  timeoutError = new McpError(ErrorCode.RequestTimeout, "Request timed out", { timeout: 60000 });
  window.__TAURI__ = {
    invoke: async (command: string, args?: any) => {
      nativeCommands.push(command);
      if (command === "mcp_read_config") return JSON.parse(JSON.stringify(config));
      if (command === "mcp_write_config") { config = JSON.parse(JSON.stringify(args.config)); return; }
      if (command === "mcp_oauth_read") return null;
      if (["mcp_kill", "mcp_oauth_remove", "mcp_oauth_cancel"].includes(command)) return;
      throw new Error(`Unexpected native command: ${command}`);
    },
  } as unknown as NonNullable<Window["__TAURI__"]>;
});
afterEach(async () => {
  for (const id of created) await actions.removeMcpServer(id, "");
  delete window.__TAURI__;
});

async function add(id: string, mode: Mode, paused = false) {
  created.push(id);
  modes.set(id, mode);
  await actions.addMcpServer(id, {
    url: "http://127.0.0.1:45670/mcp",
    ...(paused ? { status: "paused" as const } : {}),
  }, "");
}

test("only error states are retried; concurrent discovery shares one attempt", async () => {
  await add("paused", "ready", true);
  await add("login", "login");
  await add("unsupported", "unsupported");
  await add("failed", "error");
  modes.set("failed", "gate");
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  notifyStarted = () => started();
  const first = actions.getAllTools("");
  const second = actions.getAllTools("");
  await startedPromise;
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(a.map((item) => item.clientId)).toEqual(["failed"]);
  expect(b.map((item) => item.clientId)).toEqual(["failed"]);
  expect(attempts.get("failed")).toBe(2);
  expect(attempts.get("paused")).toBeUndefined();
  expect(attempts.get("login")).toBe(1);
  expect(attempts.get("unsupported")).toBe(1);
});

test("different desktop servers reconnect in parallel", async () => {
  await add("parallel-a", "error");
  await add("parallel-b", "error");
  modes.set("parallel-a", "gate");
  modes.set("parallel-b", "gate");
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  const seen = new Set<string>();
  let started!: () => void;
  const bothStarted = new Promise<void>((resolve) => { started = resolve; });
  notifyStarted = (id) => { seen.add(id); if (seen.size === 2) started(); };
  const reconnecting = actions.getAllTools("");
  try {
    await Promise.race([bothStarted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("not parallel")), 1000))]);
  } finally {
    release();
  }
  expect((await reconnecting).map((item) => item.clientId).sort()).toEqual(["parallel-a", "parallel-b"]);
});

test("a later discovery joins the active batch without serializing another server", async () => {
  await add("overlap-a", "error");
  await add("overlap-b", "error");
  modes.set("overlap-a", "gate");
  modes.set("overlap-b", "gate");
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  let firstStarted!: () => void;
  let bothStarted!: () => void;
  const first = new Promise<void>((resolve) => { firstStarted = resolve; });
  const both = new Promise<void>((resolve) => { bothStarted = resolve; });
  const seen = new Set<string>();
  notifyStarted = (id) => { seen.add(id); if (id === "overlap-a") firstStarted(); if (seen.size === 2) bothStarted(); };
  const calling = actions.executeMcpAction("overlap-a", { method: "tools/call" }, "");
  await first;
  const discovering = actions.getAllTools("");
  try {
    await Promise.race([both, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("overlap was serialized")), 1000))]);
  } finally {
    release();
  }
  const [, tools] = await Promise.all([calling, discovering]);
  expect(tools.map((item) => item.clientId).sort()).toEqual(["overlap-a", "overlap-b"]);
  expect(attempts.get("overlap-a")).toBe(2);
  expect(attempts.get("overlap-b")).toBe(2);
});

test("a manually initializing server is not restarted by discovery", async () => {
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  notifyStarted = () => started();
  const adding = add("manual-init", "gate");
  await startedPromise;
  expect(await actions.getAllTools("")).toEqual([]);
  expect(attempts.get("manual-init")).toBe(1);
  release();
  await adding;
});

test("a definitely unsent call is reconnected and executed once", async () => {
  await add("safe", "ready");
  callMode = "safe-once";
  expect(await actions.executeMcpAction("safe", { method: "tools/call" }, "")).toMatchObject({ content: [{ text: "ok" }] });
  expect(attempts.get("safe")).toBe(2);
  expect(calls).toBe(2);
  expect(received).toBe(1);
});

test("an asynchronous transport failure marks a desktop connection as failed", async () => {
  await add("transport-error", "ready");
  connectedClients.get("transport-error").onerror(new McpConnectionError("network unavailable"));
  expect((await actions.getClientsStatus(""))["transport-error"].status).toBe("error");
  await actions.getAllTools("");
  expect(attempts.get("transport-error")).toBe(2);
  expect((await actions.getClientsStatus(""))["transport-error"].status).toBe("active");
});

test.each(["timeout", "rpc", "is-error"] as const)("%s leaves the desktop connection active and reusable", async (mode) => {
  await add("tool-error", "ready");
  callMode = mode;
  const failing = actions.executeMcpAction("tool-error", { method: "tools/call" }, "");
  if (mode === "timeout") await expect(failing).rejects.toBe(timeoutError);
  else if (mode === "rpc") await expect(failing).rejects.toThrow("Invalid params");
  else await expect(failing).resolves.toMatchObject({ isError: true });
  expect(calls).toBe(1);
  expect(received).toBe(1);
  expect(attempts.get("tool-error")).toBe(1);
  expect((await actions.getClientsStatus(""))["tool-error"].status).toBe("active");
  expect(closed).toBe(0);
  callMode = "ok";
  await actions.executeMcpAction("tool-error", { method: "tools/call" }, "");
  expect(attempts.get("tool-error")).toBe(1);
  expect(calls).toBe(2);
});

test("a pause preempts a pending reconnect without waiting for it", async () => {
  await add("pause-race", "error");
  modes.set("pause-race", "gate");
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  notifyStarted = () => started();
  const reconnecting = actions.getAllTools("");
  await startedPromise;
  const pausing = actions.pauseMcpServer("pause-race", "");
  try {
    await Promise.race([pausing, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pause was blocked")), 1000))]);
    expect((await actions.getClientsStatus(""))["pause-race"].status).toBe("paused");
  } finally {
    release();
  }
  await reconnecting;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect((await actions.getClientsStatus(""))["pause-race"].status).toBe("paused");
  expect(closed).toBeGreaterThan(0);
  expect(await actions.getAllTools("")).toEqual([]);
});

test("an edit queued during reconnect replaces the old connection", async () => {
  await add("edit-race", "error");
  modes.set("edit-race", "gate");
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  notifyStarted = () => started();
  const reconnecting = actions.getAllTools("");
  await startedPromise;
  modes.set("edit-race", "ready");
  const newUrl = "http://127.0.0.1:45671/mcp";
  const editing = actions.addMcpServer("edit-race", { url: newUrl }, "");
  try {
    await Promise.race([editing, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("edit was blocked")), 1000))]);
  } finally {
    release();
  }
  await reconnecting;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect((await actions.getMcpConfigFromFile("")).mcpServers["edit-race"]).toMatchObject({ url: newUrl });
  expect(connectionUrls.get("edit-race")?.at(-1)).toBe(newUrl);
  expect((await actions.getClientsStatus(""))["edit-race"].status).toBe("active");
  expect(closed).toBeGreaterThan(0);
});

test("logout queued during reconnect removes credentials and replaces the old connection", async () => {
  await add("logout-race", "error");
  modes.set("logout-race", "gate");
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  notifyStarted = () => started();
  const reconnecting = actions.getAllTools("");
  await startedPromise;
  modes.set("logout-race", "ready");
  const loggingOut = actions.logoutMcpOAuth("logout-race", "");
  try {
    await Promise.race([loggingOut, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("logout was blocked")), 1000))]);
  } finally {
    release();
  }
  await reconnecting;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(nativeCommands.filter((command) => command === "mcp_oauth_remove")).toHaveLength(1);
  expect(attempts.get("logout-race")).toBe(3);
  expect((await actions.getClientsStatus(""))["logout-race"].status).toBe("active");
  expect(closed).toBeGreaterThan(0);
});

test("closing after an unsupported OAuth challenge preserves that status", async () => {
  await add("unsupported-close", "ready");
  const client = connectedClients.get("unsupported-close");
  client.onerror(new OAuthPreRegisteredClientRequired());
  client.onclose();
  expect((await actions.getClientsStatus(""))["unsupported-close"].status).toBe("oauth-unsupported");
  await actions.getAllTools("");
  expect(attempts.get("unsupported-close")).toBe(1);
});

test("a slow desktop reconnect continues after the three-second wait", async () => {
  await add("stalled", "error");
  modes.set("stalled", "gate");
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  notifyStarted = () => started();
  const begin = performance.now();
  const reconnecting = actions.getAllTools("");
  await startedPromise;
  await reconnecting;
  expect(performance.now() - begin).toBeLessThan(4500);
  expect((await actions.getClientsStatus(""))["stalled"].status).toBe("initializing");
  expect(closed).toBe(0);
  const second = actions.getAllTools("");
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    expect(attempts.get("stalled")).toBe(2);
  } finally {
    release();
  }
  expect((await second).map((item) => item.clientId)).toEqual(["stalled"]);
  expect(attempts.get("stalled")).toBe(2);
  expect((await actions.getClientsStatus(""))["stalled"].status).toBe("active");
}, 10000);
