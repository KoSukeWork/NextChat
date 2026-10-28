import { jest } from "@jest/globals";
import { TauriStdioTransport } from "../app/mcp/tauri-transport";
import { invoke, isTauri } from "../app/mcp/tauri-api";

type Handler = (event: { payload: any }) => void;
let listeners: Map<string, Handler>;
let unlisteners: ReturnType<typeof jest.fn>[];
let nativeInvoke: ReturnType<
  typeof jest.fn<(command: string, args?: any) => Promise<any>>
>;

function emit(event: string, payload: object) {
  listeners.get(event)?.({
    payload: { id: "test", runId: 7, code: null, line: null, ...payload },
  });
}

beforeEach(() => {
  listeners = new Map();
  unlisteners = [];
  nativeInvoke = jest.fn(async (command: string) =>
    command === "mcp_spawn" ? 7 : undefined,
  );
  window.__TAURI__ = {
    invoke: nativeInvoke,
    event: {
      listen: async (event: string, handler: Handler) => {
        listeners.set(event, handler);
        const unlisten = jest.fn(() => {
          listeners.delete(event);
        });
        unlisteners.push(unlisten);
        return unlisten;
      },
    },
  } as unknown as NonNullable<Window["__TAURI__"]>;
});
afterEach(() => {
  delete window.__TAURI__;
});

test("browser fallback is disabled and native error strings become Errors", async () => {
  expect(isTauri()).toBe(true);
  nativeInvoke.mockRejectedValueOnce("user declined");
  await expect(invoke("mcp_write_config")).rejects.toThrow("user declined");
  delete window.__TAURI__;
  expect(isTauri()).toBe(false);
  await expect(new TauriStdioTransport("test").start()).rejects.toThrow(
    "requires the Tauri app",
  );
});

test("listens before spawning, filters generations, parses and sends protocol messages", async () => {
  const transport = new TauriStdioTransport("test");
  transport.onmessage = jest.fn();
  transport.onerror = jest.fn();
  nativeInvoke.mockImplementation(async (command) => {
    if (command === "mcp_spawn") {
      expect(listeners.size).toBe(3);
      emit("mcp://message", { line: '{"jsonrpc":"2.0","id":1,"result":{}}' });
      return 7;
    }
  });
  await transport.start();
  expect(transport.onmessage).toHaveBeenCalledTimes(1);
  emit("mcp://message", { id: "other", line: "invalid" });
  emit("mcp://message", { runId: 6, line: "invalid" });
  expect(transport.onerror).not.toHaveBeenCalled();
  emit("mcp://message", { line: "invalid" });
  emit("mcp://message", { line: '{"invalid":"schema"}' });
  expect(transport.onerror).toHaveBeenCalledTimes(2);
  await transport.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  expect(nativeInvoke).toHaveBeenCalledWith("mcp_send", {
    id: "test",
    runId: 7,
    line: '{"jsonrpc":"2.0","id":9,"method":"tools/list"}',
  });
  await transport.close();
  await transport.close();
  expect(
    nativeInvoke.mock.calls.filter(([command]) => command === "mcp_kill"),
  ).toHaveLength(1);
  expect(listeners.size).toBe(0);
  for (const unlisten of unlisteners) expect(unlisten).toHaveBeenCalledTimes(1);
  await expect(
    transport.send({ jsonrpc: "2.0", method: "ping" }),
  ).rejects.toThrow("closed");
});

test.each([0, 1, null])(
  "exit code %s closes exactly once and releases listeners",
  async (code) => {
    const transport = new TauriStdioTransport("test");
    transport.onclose = jest.fn();
    transport.onerror = jest.fn();
    await transport.start();
    emit("mcp://exit", { code });
    await transport.close();
    expect(transport.onclose).toHaveBeenCalledTimes(1);
    expect(transport.onerror).toHaveBeenCalledTimes(code === 0 ? 0 : 1);
    expect(listeners.size).toBe(0);
  },
);

test("spawn failure cleans up listeners", async () => {
  nativeInvoke.mockRejectedValueOnce("executable missing");
  const transport = new TauriStdioTransport("test");
  await expect(transport.start()).rejects.toThrow("executable missing");
  await transport.close();
  expect(listeners.size).toBe(0);
});

test("close while spawn is pending kills the returned generation", async () => {
  let spawned!: (run: number) => void;
  let notifySpawn!: () => void;
  const spawning = new Promise<void>((resolve) => {
    notifySpawn = resolve;
  });
  nativeInvoke.mockImplementation(async (command) => {
    if (command === "mcp_spawn") {
      notifySpawn();
      return new Promise<number>((resolve) => {
        spawned = resolve;
      });
    }
  });
  const transport = new TauriStdioTransport("test");
  const opening = transport.start();
  await spawning;
  const closing = transport.close();
  spawned(7);
  await Promise.all([opening, closing]);
  expect(nativeInvoke).toHaveBeenCalledWith("mcp_kill", {
    id: "test",
    runId: 7,
  });
  expect(listeners.size).toBe(0);
});

test("close during listener registration never spawns or leaks listeners", async () => {
  const transport = new TauriStdioTransport("test");
  const opening = transport.start();
  await transport.close();
  await opening;
  expect(nativeInvoke).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
});
