/** @jest-environment node */
import { jest } from "@jest/globals";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { McpConnectionError, McpRequestNotSent } from "../app/mcp/reconnect";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { OAuthLoginNeeded, OAuthPreRegisteredClientRequired } = await import("../app/mcp/oauth");
type Mode = "error" | "ready" | "login" | "unsupported" | "gate";
const modes = new Map<string, Mode>();
const attempts = new Map<string, number>();
const removedClients: { id: string; attempt: number }[] = [];
const connectedClients = new Map<string, { id: string; onerror?: (error: Error) => void }>();
let gate: Promise<void> = Promise.resolve();
let notifyStarted: (id: string) => void = () => {};
let callError: Error | undefined;
let callResult: unknown;
let callCount = 0;
let closeBeforeSend: "close" | "error" | undefined;
const createClient = jest.fn(async (id: string, server: { url: string }) => {
  const attempt = (attempts.get(id) ?? 0) + 1;
  attempts.set(id, attempt);
  const mode = modes.get(id);
  if (mode === "login") throw new OAuthLoginNeeded();
  if (mode === "unsupported") throw new OAuthPreRegisteredClientRequired();
  if (mode === "error") throw new Error("synthetic failure");
  if (mode === "gate") {
    notifyStarted(id);
    await gate;
  }
  const client = { id, attempt, url: server.url, close: async () => {} };
  connectedClients.set(id, client);
  return client;
});
jest.unstable_mockModule("@/app/mcp/client", () => ({
  createClient,
  removeClient: async (client: { id: string; attempt: number }) => { removedClients.push(client); },
  listTools: async (client: { url: string; attempt: number }) => ({
    tools: [{ name: "echo", description: `${client.url}#${client.attempt}`, inputSchema: {} }],
  }),
  executeRequest: async (client: { onclose?: () => void; onerror?: (error: Error) => void }) => {
    callCount++;
    if (closeBeforeSend && callCount === 1) {
      const error = new McpRequestNotSent("closed");
      if (closeBeforeSend === "close") client.onclose?.();
      else client.onerror?.(error);
      throw error;
    }
    if (callError) throw callError;
    return callResult ?? { content: [{ type: "text", text: "ok" }] };
  },
}));

process.env.ENABLE_MCP = "true";
process.env.CODE = "synthetic-test-code";
process.env.NEXTCHAT_MCP_CONFIG_DIR = await mkdtemp(path.join(os.tmpdir(), "reconnect-state-"));
const actions = await import("../app/mcp/actions");
const code = "synthetic-test-code";
let created: string[] = [];

async function add(id: string, mode: Mode, paused = false) {
  created.push(id);
  modes.set(id, mode);
  await actions.addMcpServer(id, {
    url: "http://127.0.0.1:45670/mcp",
    ...(paused ? { status: "paused" as const } : {}),
  }, code);
}
afterEach(async () => {
  for (const id of created) await actions.removeMcpServer(id, code);
  created = [];
  modes.clear();
  attempts.clear();
  removedClients.length = 0;
  connectedClients.clear();
  callError = undefined;
  callResult = undefined;
  callCount = 0;
  closeBeforeSend = undefined;
});

test("paused and OAuth-specific states are not reconnected; status reads do not retry", async () => {
  await add("paused", "ready", true);
  await add("login", "login");
  await add("unsupported", "unsupported");
  await add("failed", "error");
  expect((await actions.getClientsStatus(code)).login.status).toBe("login-required");
  expect((await actions.getClientsStatus(code)).unsupported.status).toBe("oauth-unsupported");
  await actions.getClientsStatus(code);
  expect(attempts.get("failed")).toBe(1);
  modes.set("failed", "ready");
  await actions.reconnectMcpErrors(code);
  expect(attempts.get("failed")).toBe(2);
  expect(attempts.get("paused")).toBeUndefined();
  expect(attempts.get("login")).toBe(1);
  expect(attempts.get("unsupported")).toBe(1);
});

test("different failed servers reconnect in parallel", async () => {
  await add("a", "error");
  await add("b", "error");
  modes.set("a", "gate");
  modes.set("b", "gate");
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  const seen = new Set<string>();
  let bothStarted!: () => void;
  const both = new Promise<void>((resolve) => { bothStarted = resolve; });
  notifyStarted = (id) => { seen.add(id); if (seen.size === 2) bothStarted(); };
  const reconnecting = actions.getAllTools(code);
  try {
    await Promise.race([both, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("not parallel")), 1000))]);
  } finally {
    release();
  }
  const tools = await reconnecting;
  expect(tools.map((item) => item.clientId).sort()).toEqual(["a", "b"]);
});

test.each(["timeout", "rpc", "is-error"])("%s leaves the web connection active and reusable", async (mode) => {
  await add("tool-error", "ready");
  if (mode === "timeout") callError = new McpError(ErrorCode.RequestTimeout, "Request timed out", { timeout: 60000 });
  if (mode === "rpc") callError = new McpError(ErrorCode.InvalidParams, "Invalid params");
  if (mode === "is-error") callResult = { isError: true, content: [{ type: "text", text: "missing" }] };
  const failing = actions.executeMcpAction("tool-error", { method: "tools/call" }, code);
  if (mode === "timeout") await expect(failing).rejects.toBe(callError);
  else if (mode === "rpc") await expect(failing).rejects.toThrow();
  else await expect(failing).resolves.toEqual(callResult);
  expect(callCount).toBe(1);
  expect(attempts.get("tool-error")).toBe(1);
  expect((await actions.getClientsStatus(code))["tool-error"].status).toBe("active");
  expect(removedClients).toHaveLength(0);
  callError = undefined;
  callResult = undefined;
  await actions.executeMcpAction("tool-error", { method: "tools/call" }, code);
  expect(attempts.get("tool-error")).toBe(1);
  expect(callCount).toBe(2);
});

test.each(["close", "error"] as const)("transport %s before the write can still safely reconnect and retry", async (mode) => {
  await add("closed-before-send", "ready");
  closeBeforeSend = mode;
  await expect(actions.executeMcpAction("closed-before-send", { method: "tools/call" }, code)).resolves.toMatchObject({ content: [{ text: "ok" }] });
  expect(callCount).toBe(2);
  expect(attempts.get("closed-before-send")).toBe(2);
  expect((await actions.getClientsStatus(code))["closed-before-send"].status).toBe("active");
});

test("an asynchronous transport failure marks a web connection as failed", async () => {
  await add("transport-error", "ready");
  connectedClients.get("transport-error")?.onerror?.(new McpConnectionError("network unavailable"));
  expect((await actions.getClientsStatus(code))["transport-error"].status).toBe("error");
  await actions.getAllTools(code);
  expect(attempts.get("transport-error")).toBe(2);
  expect((await actions.getClientsStatus(code))["transport-error"].status).toBe("active");
});

test("an edit during reconnect keeps the new connection when the old one finishes", async () => {
  await add("edit-race", "error");
  modes.set("edit-race", "gate");
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  notifyStarted = () => started();
  const reconnecting = actions.getAllTools(code);
  await startedPromise;
  modes.set("edit-race", "ready");
  const newUrl = "http://127.0.0.1:45671/mcp";
  await actions.addMcpServer("edit-race", { url: newUrl }, code);
  release();
  await reconnecting;
  expect((await actions.getClientTools("edit-race", code))?.tools[0].description).toBe(`${newUrl}#3`);
  expect(removedClients).toContainEqual(expect.objectContaining({ id: "edit-race", attempt: 2 }));
});

test("logout during reconnect keeps the new connection when the old one finishes", async () => {
  await add("logout-race", "error");
  modes.set("logout-race", "gate");
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  notifyStarted = () => started();
  const reconnecting = actions.getAllTools(code);
  await startedPromise;
  modes.set("logout-race", "ready");
  await actions.logoutMcpOAuth("logout-race", code);
  release();
  await reconnecting;
  expect((await actions.getClientTools("logout-race", code))?.tools[0].description).toBe("http://127.0.0.1:45670/mcp#3");
  expect(removedClients).toContainEqual(expect.objectContaining({ id: "logout-race", attempt: 2 }));
});

test("editing a server as paused invalidates an in-progress reconnect", async () => {
  await add("paused-edit", "error");
  modes.set("paused-edit", "gate");
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  notifyStarted = () => started();
  const reconnecting = actions.getAllTools(code);
  await startedPromise;
  await actions.addMcpServer("paused-edit", { url: "http://127.0.0.1:45671/mcp", status: "paused" }, code);
  release();
  expect(await reconnecting).toEqual([]);
  expect((await actions.getClientsStatus(code))["paused-edit"].status).toBe("paused");
  expect(await actions.getClientTools("paused-edit", code)).toBeNull();
  expect(removedClients).toContainEqual(expect.objectContaining({ id: "paused-edit", attempt: 2 }));
});
