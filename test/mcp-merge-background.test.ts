import { jest } from "@jest/globals";

let file = JSON.stringify({ mcpServers: {} });
let resolveClient!: (client: any) => void;
const deferred = new Promise<any>((resolve) => {
  resolveClient = resolve;
});
const createClient = jest.fn(async () => deferred);
const removeClient = jest.fn(async (_client: any) => {});
const listTools = jest.fn(async (_client: any) => ({ tools: [] }));
jest.unstable_mockModule("fs/promises", () => ({
  default: {
    readFile: async () => file,
    writeFile: async (_path: string, data: string) => {
      file = data;
    },
    mkdir: async () => {},
  },
}));
jest.unstable_mockModule("@/app/mcp/client", () => ({
  createClient,
  removeClient,
  listTools,
  executeRequest: jest.fn(),
}));
const actions = await import("../app/mcp/actions");

test("web merge returns after saving and a later pause supersedes a pending connection", async () => {
  const oldEnable = process.env.ENABLE_MCP;
  const oldCode = process.env.CODE;
  process.env.ENABLE_MCP = "true";
  process.env.CODE = "test-code";
  const incoming = {
    mcpServers: { remote: { url: "https://example.test/mcp" } },
  };
  const client = { close: jest.fn() };
  try {
    const result = await Promise.race([
      actions.mergeMcpServers(incoming, "test-code"),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("merge blocked on connection")),
          1000,
        ),
      ),
    ]);
    expect(result).toEqual(incoming);
    expect(JSON.parse(file)).toEqual(incoming);
    expect((await actions.getClientsStatus("test-code")).remote.status).toBe(
      "initializing",
    );
    expect(await actions.getAvailableClientsCount("test-code")).toBe(0);
    expect(await actions.getAllTools("test-code")).toEqual([]);
    await actions.pauseMcpServer("remote", "test-code");
    resolveClient(client);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removeClient).toHaveBeenCalledWith(client);
    expect(listTools).not.toHaveBeenCalled();
    expect((await actions.getClientsStatus("test-code")).remote.status).toBe(
      "paused",
    );
  } finally {
    if (oldEnable === undefined) delete process.env.ENABLE_MCP;
    else process.env.ENABLE_MCP = oldEnable;
    if (oldCode === undefined) delete process.env.CODE;
    else process.env.CODE = oldCode;
  }
});
