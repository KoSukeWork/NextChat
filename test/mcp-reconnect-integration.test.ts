/** @jest-environment node */
import { createServer } from "node:net";
import { jest } from "@jest/globals";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeFetch } from "../jest.setup";
import { z } from "zod";
import { McpConnectionError, McpRequestNotSent } from "../app/mcp/reconnect";
import { fetch as nativeBridgeFetch } from "../app/utils/stream";
import { createMock } from "./fixtures/mcp-reconnect-mock.cjs";

globalThis.fetch = nativeFetch;
process.env.ENABLE_MCP = "true";
process.env.CODE = "synthetic-test-code";
process.env.NEXTCHAT_MCP_CONFIG_DIR = await mkdtemp(path.join(os.tmpdir(), "reconnect-web-"));
const actions = await import("../app/mcp/actions");
const { createRemoteClient, nativeMcpFetch } = await import("../app/mcp/remote");
const code = "synthetic-test-code";
let nextId = 0;
let id: string;
let port: number;
let mock: ReturnType<typeof createMock>;
let started: boolean;

async function unusedPort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const result = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return result;
}

beforeEach(async () => {
  id = `synthetic-${++nextId}`;
  port = await unusedPort();
  mock = createMock();
  started = false;
  await actions.addMcpServer(id, { url: `http://127.0.0.1:${port}/mcp` }, code);
  expect((await actions.getClientsStatus(code))[id].status).toBe("error");
});

afterEach(async () => {
  await actions.removeMcpServer(id, code);
  if (started) await mock.close();
});

async function startMock() {
  await mock.start(port);
  started = true;
}

const call = { method: "tools/call", params: { name: "echo", arguments: {} } };

test("a server started later reconnects once for concurrent tool discovery", async () => {
  await startMock();
  expect(mock.stats.initialize).toBe(0);
  const [a, b] = await Promise.all([actions.getAllTools(code), actions.getAllTools(code)]);
  expect(a.find((item) => item.clientId === id)?.tools.tools).toHaveLength(1);
  expect(b.find((item) => item.clientId === id)?.tools.tools).toHaveLength(1);
  expect(mock.stats.initialize).toBe(1);
  expect((await actions.getClientsStatus(code))[id].status).toBe("active");
});

test("a restarted server rejects the expired session and the tool executes once", async () => {
  await startMock();
  await actions.getAllTools(code);
  await mock.close();
  started = false;
  await startMock();
  mock.invalidateSession();
  const result = await actions.executeMcpAction(id, call, code);
  expect(result).toMatchObject({ content: [{ text: "synthetic result" }] });
  expect(mock.stats.rejectedSessions).toBe(1);
  expect(mock.stats.initialize).toBe(2);
  expect(mock.stats.calls).toBe(1);
});

test("concurrent calls rejected by an expired session share a reconnect", async () => {
  await startMock();
  await actions.getAllTools(code);
  mock.invalidateSession();
  const results = await Promise.all([
    actions.executeMcpAction(id, call, code),
    actions.executeMcpAction(id, call, code),
  ]);
  expect(results).toHaveLength(2);
  expect(mock.stats.initialize).toBe(2);
  expect(mock.stats.calls).toBe(2);
});

test("a disconnect after the server receives a tool call is never replayed", async () => {
  await startMock();
  await actions.getAllTools(code);
  mock.setToolMode("disconnect");
  await expect(actions.executeMcpAction(id, call, code)).rejects.toThrow();
  expect(mock.stats.calls).toBe(1);
  expect(mock.stats.initialize).toBe(1);
  expect((await actions.getClientsStatus(code))[id].status).toBe("error");
});

test("a response body disconnect marks the connection failed without replay", async () => {
  await startMock();
  await actions.getAllTools(code);
  mock.setToolMode("body-disconnect");
  await expect(actions.executeMcpAction(id, call, code)).rejects.toThrow();
  expect(mock.stats.calls).toBe(1);
  expect(mock.stats.initialize).toBe(1);
  expect((await actions.getClientsStatus(code))[id].status).toBe("error");
});

test("a tool-level error is returned without replay and keeps the server active", async () => {
  await startMock();
  await actions.getAllTools(code);
  mock.setToolMode("error");
  expect(await actions.executeMcpAction(id, call, code)).toMatchObject({ isError: true });
  expect(mock.stats.calls).toBe(1);
  expect(mock.stats.initialize).toBe(1);
  expect((await actions.getClientsStatus(code))[id].status).toBe("active");
  mock.setToolMode("ok");
  await actions.executeMcpAction(id, call, code);
  expect(mock.stats.calls).toBe(2);
  expect(mock.stats.initialize).toBe(1);
});

test.each(["invalid", "rpc-closed"])("a JSON-RPC %s error does not close or reconnect the server", async (mode) => {
  await startMock();
  await actions.getAllTools(code);
  mock.setToolMode(mode);
  await expect(actions.executeMcpAction(id, call, code)).rejects.toThrow();
  expect((await actions.getClientsStatus(code))[id].status).toBe("active");
  mock.setToolMode("ok");
  await actions.executeMcpAction(id, call, code);
  expect(mock.stats.calls).toBe(2);
  expect(mock.stats.initialize).toBe(1);
});

test("an HTTP 5xx marks the connection as failed without replay", async () => {
  await startMock();
  await actions.getAllTools(code);
  mock.setToolMode("http-500");
  await expect(actions.executeMcpAction(id, call, code)).rejects.toThrow();
  expect(mock.stats.calls).toBe(1);
  expect((await actions.getClientsStatus(code))[id].status).toBe("error");
});

test("a new OAuth challenge becomes login-required and is not retried automatically", async () => {
  await startMock();
  await actions.getAllTools(code);
  mock.requireLogin();
  await expect(actions.executeMcpAction(id, call, code)).rejects.toThrow();
  expect((await actions.getClientsStatus(code))[id].status).toBe("login-required");
  await actions.getAllTools(code);
  expect(mock.stats.initialize).toBe(1);
  expect(mock.stats.calls).toBe(0);
});

test("a pause while reconnecting wins over the late connection", async () => {
  await startMock();
  const gate = mock.holdInitialize();
  const reconnecting = actions.getAllTools(code);
  try {
    await gate.started;
    await Promise.race([
      actions.pauseMcpServer(id, code),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pause was blocked")), 1000)),
    ]);
    await Promise.race([
      gate.closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cancelled connection stayed open")), 1000)),
    ]);
  } finally {
    gate.release();
  }
  expect((await reconnecting).some((item) => item.clientId === id)).toBe(false);
  expect((await actions.getClientsStatus(code))[id].status).toBe("paused");
});

test("a five-second reconnect continues after the caller's deadline and is shared", async () => {
  await startMock();
  const gate = mock.holdInitialize();
  const startedAt = performance.now();
  try {
    const tools = await actions.getAllTools(code);
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThan(2500);
    expect(elapsed).toBeLessThan(4500);
    expect(tools.some((item) => item.clientId === id)).toBe(false);
    expect((await actions.getClientsStatus(code))[id].status).toBe("initializing");
    const secondStarted = performance.now();
    const again = await actions.getAllTools(code);
    expect(performance.now() - secondStarted).toBeLessThan(500);
    expect(again.some((item) => item.clientId === id)).toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    expect(mock.stats.initialize).toBe(1);
    gate.release();
    await actions.reconnectMcpErrors(code);
    expect((await actions.getAllTools(code)).find((item) => item.clientId === id)?.tools.tools).toHaveLength(1);
    expect((await actions.getClientsStatus(code))[id].status).toBe("active");
    expect(mock.stats.initialize).toBe(1);
  } finally {
    gate.release();
  }
}, 10000);

test.each(["refused", "forged-599", "redirect-refused"]) (
  "classifies %s only when no earlier dispatch could have executed",
  async (mode) => {
    await startMock();
    const url = `http://127.0.0.1:${port}/mcp`;
    let calls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (body.method === "tools/call") {
        calls++;
        if (mode === "forged-599") return new Response("NETWORK_REFUSED", { status: 599 });
        if (mode === "redirect-refused" && calls === 1)
          return new Response(null, { status: 307, headers: { location: "/redirected" } });
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("synthetic"), { code: "ECONNREFUSED" }),
        });
      }
      return nativeFetch(input, init);
    };
    const client = await createRemoteClient(id, { url }, fetchImpl);
    try {
      const request = client.request as (message: unknown, schema: unknown) => Promise<unknown>;
      const error = await request.call(client, call, z.any()).catch((value) => value);
      expect(error instanceof McpRequestNotSent).toBe(mode === "refused");
      expect(calls).toBe(mode === "redirect-refused" ? 2 : 1);
    } finally {
      await client.close();
    }
  },
);

test("a real Streamable HTTP initialization refusal does not attempt SSE", async () => {
  const methods: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    methods.push(init?.method ?? "GET");
    throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("synthetic"), { code: "ECONNREFUSED" }),
    });
  };
  await expect(createRemoteClient(id, { url: `http://127.0.0.1:${port}/mcp` }, fetchImpl))
    .rejects.toBeInstanceOf(McpRequestNotSent);
  expect(methods).toEqual(["POST"]);
});

test("a trusted native initialization refusal does not attempt SSE", async () => {
  const invoke = jest.fn(async (command: string, _args?: Record<string, unknown>) => command === "stream_fetch" ? {
    request_id: 124, status: 599, status_text: "Error", headers: {}, network_error: "NETWORK_REFUSED", request_not_sent: true,
  } : undefined);
  Object.assign(globalThis, {
    window: { __TAURI__: { invoke, event: { listen: async () => () => {} } } },
    navigator: { userAgent: "synthetic" },
  });
  try {
    await expect(createRemoteClient(id, { url: `http://127.0.0.1:${port}/mcp` }, nativeMcpFetch))
      .rejects.toBeInstanceOf(McpRequestNotSent);
    const requests = invoke.mock.calls.filter(([command]) => command === "stream_fetch");
    expect(requests).toHaveLength(1);
    expect((requests[0][1] as any).redirect).toBe("manual");
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "navigator");
  }
});

test.each([true, false, undefined])("native refusal requires explicit unsent evidence (%s)", async (unsent) => {
  await startMock();
  const url = `http://127.0.0.1:${port}/mcp`;
  const invoke = jest.fn(async (command: string) => command === "stream_fetch" ? {
    request_id: 123, status: 599, status_text: "Error", headers: {}, network_error: "NETWORK_REFUSED",
    ...(unsent === undefined ? {} : { request_not_sent: unsent }),
  } : undefined);
  Object.assign(globalThis, {
    window: { __TAURI__: { invoke, event: { listen: async () => () => {} } } },
    navigator: { userAgent: "synthetic" },
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (body.method === "tools/call") return nativeBridgeFetch(String(input), init);
    return nativeFetch(input, init);
  };
  try {
    const client = await createRemoteClient(id, { url }, fetchImpl);
    try {
      const request = client.request as (message: unknown, schema: unknown) => Promise<unknown>;
      const error = await request.call(client, call, z.any()).catch((value) => value);
      if (unsent) {
        expect(error).toBeInstanceOf(McpRequestNotSent);
        expect((error as McpRequestNotSent).reason).toBe("refused");
      } else {
        expect(error).toBeInstanceOf(McpConnectionError);
      }
    } finally {
      await client.close();
    }
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "navigator");
  }
});
