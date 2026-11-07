/** @jest-environment node */
import { jest } from "@jest/globals";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "reconnect-stdio-"));
const eventsFile = path.join(directory, "events.txt");
const readyFile = path.join(directory, "ready.txt");
process.env.ENABLE_MCP = "true";
process.env.CODE = "synthetic-test-code";
process.env.NEXTCHAT_MCP_CONFIG_DIR = directory;
const actions = await import("../app/mcp/actions");
const code = "synthetic-test-code";
const id = "slow-stdio";
const call = (name: string) => ({ method: "tools/call", params: { name, arguments: {} } });
const events = async () => (await readFile(eventsFile, "utf8")).trim().split("\n");

test("slow stdio startup continues once and tool errors reuse its process", async () => {
  try {
    await actions.addMcpServer(id, {
      command: process.execPath,
      args: [path.resolve("test/fixtures/mcp-reconnect-stdio.cjs"), eventsFile, readyFile],
    }, code);
    expect((await actions.getClientsStatus(code))[id].status).toBe("error");
    await writeFile(readyFile, "ready");

    const startedAt = performance.now();
    const first = await actions.getAllTools(code);
    expect(performance.now() - startedAt).toBeGreaterThan(2500);
    expect(performance.now() - startedAt).toBeLessThan(4500);
    expect(first).toEqual([]);
    expect((await actions.getClientsStatus(code))[id].status).toBe("initializing");
    expect((await events()).filter((event) => event === "spawn")).toHaveLength(2);

    const second = await actions.getAllTools(code);
    expect(second.find((item) => item.clientId === id)?.tools.tools).toHaveLength(1);
    expect((await events()).filter((event) => event === "spawn")).toHaveLength(2);

    expect(await actions.executeMcpAction(id, call("error"), code)).toMatchObject({ isError: true });
    await expect(actions.executeMcpAction(id, call("invalid"), code)).rejects.toThrow("Invalid params");
    expect((await actions.getClientsStatus(code))[id].status).toBe("active");

    // Shorten the SDK's request timeout for this test without changing app code.
    const nativeSetTimeout = globalThis.setTimeout;
    const timerSpy = jest.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
      nativeSetTimeout(callback, delay === 60000 ? 100 : delay, ...args)) as typeof setTimeout);
    try {
      const error = await actions.executeMcpAction(id, call("slow"), code).catch((value) => value);
      expect(error).toBeInstanceOf(McpError);
      expect(error.code).toBe(ErrorCode.RequestTimeout);
    } finally {
      timerSpy.mockRestore();
    }
    expect((await actions.getClientsStatus(code))[id].status).toBe("active");
    expect(await actions.executeMcpAction(id, call("ok"), code)).toMatchObject({ content: [{ text: "ok" }] });
    expect((await events()).filter((event) => event === "spawn")).toHaveLength(2);
    expect((await events()).filter((event) => event === "call:slow")).toHaveLength(1);
  } finally {
    await actions.removeMcpServer(id, code);
  }
}, 15000);
