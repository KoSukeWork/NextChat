import { jest } from "@jest/globals";
import * as actions from "../app/mcp/actions-tauri";
import type { McpConfigData } from "../app/mcp/types";

afterEach(() => {
  delete window.__TAURI__;
});

test("plain static browser does not enable desktop MCP", async () => {
  delete window.__TAURI__;
  await expect(actions.isMcpEnabled()).resolves.toBe(false);
  await expect(actions.initializeMcpSystem("")).rejects.toThrow(
    "requires the Tauri app",
  );
});

test("real SDK handshake, tool pagination/call, approval denial, pause/resume/remove and startup errors", async () => {
  let config: McpConfigData = { mcpServers: {} };
  let decline = false;
  let failSpawn = false;
  let runId = 0;
  const listeners = new Map<string, Set<(event: { payload: any }) => void>>();
  const emit = (id: string, run: number, response: object) => {
    for (const handler of listeners.get("mcp://message") ?? []) {
      handler({
        payload: { id, runId: run, line: JSON.stringify(response), code: null },
      });
    }
  };
  const nativeInvoke = jest.fn(async (command: string, args?: any) => {
    if (command === "mcp_read_config")
      return JSON.parse(JSON.stringify(config));
    if (command === "mcp_write_config") {
      if (decline) throw "MCP configuration was not approved";
      config = JSON.parse(JSON.stringify(args.config));
    }
    if (command === "mcp_spawn") {
      if (failSpawn) throw "executable not found";
      return ++runId;
    }
    if (command === "mcp_send") {
      const request = JSON.parse(args.line);
      if (request.id === undefined) return;
      const result =
        request.method === "initialize"
          ? {
              protocolVersion: request.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "mock", version: "1" },
            }
          : request.method === "tools/list"
          ? {
              tools: [
                {
                  name: request.params?.cursor ? "second" : "echo",
                  inputSchema: { type: "object" },
                },
              ],
              ...(request.params?.cursor ? {} : { nextCursor: "page2" }),
            }
          : {
              content: [{ type: "text", text: request.params.arguments.text }],
            };
      // Respond after send has returned, like real IPC.
      queueMicrotask(() =>
        emit(args.id, args.runId, { jsonrpc: "2.0", id: request.id, result }),
      );
    }
  });
  window.__TAURI__ = {
    invoke: nativeInvoke,
    event: {
      listen: async (
        event: string,
        handler: (event: { payload: any }) => void,
      ) => {
        const group = listeners.get(event) ?? new Set();
        group.add(handler);
        listeners.set(event, group);
        return () => {
          group.delete(handler);
        };
      },
    },
  } as unknown as NonNullable<Window["__TAURI__"]>;
  await expect(actions.isMcpEnabled()).resolves.toBe(true);
  await actions.initializeMcpSystem("ignored");
  expect(
    nativeInvoke.mock.calls.some(([command]) => command === "mcp_spawn"),
  ).toBe(false);
  await actions.addMcpServer("test", { command: "node", args: [] }, "ignored");
  expect((await actions.getClientsStatus(""))["test"].status).toBe("active");
  expect(await actions.getAvailableClientsCount("")).toBe(1);
  expect((await actions.getClientTools("test", ""))?.tools).toHaveLength(2);
  expect(
    await actions.executeMcpAction(
      "test",
      {
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hello" } },
      },
      "",
    ),
  ).toEqual({ content: [{ type: "text", text: "hello" }] });
  const beforeDenied = nativeInvoke.mock.calls.length;
  decline = true;
  await expect(
    actions.addMcpServer("test", { command: "other", args: [] }, ""),
  ).rejects.toThrow("not approved");
  expect(
    nativeInvoke.mock.calls
      .slice(beforeDenied)
      .some(([command]) => command === "mcp_kill" || command === "mcp_spawn"),
  ).toBe(false);
  expect(config.mcpServers.test.command).toBe("node");
  decline = false;
  await actions.pauseMcpServer("test", "");
  expect((await actions.getClientsStatus(""))["test"].status).toBe("paused");
  expect(await actions.getAllTools("")).toEqual([]);
  await expect(
    actions.executeMcpAction("test", { method: "tools/list" }, ""),
  ).rejects.toThrow("not connected");
  await actions.restartAllClients("");
  expect((await actions.getClientsStatus(""))["test"].status).toBe("paused");
  await actions.resumeMcpServer("test", "");
  expect((await actions.getClientsStatus(""))["test"].status).toBe("active");
  await actions.removeMcpServer("test", "");
  expect(config.mcpServers).toEqual({});
  expect(await actions.getAvailableClientsCount("")).toBe(0);
  failSpawn = true;
  await actions.addMcpServer("broken", { command: "missing", args: [] }, "");
  expect((await actions.getClientsStatus(""))["broken"]).toEqual({
    status: "error",
    errorMsg: "executable not found",
  });
  await actions.removeMcpServer("broken", "");
  expect([...listeners.values()].every((group) => group.size === 0)).toBe(true);
});
