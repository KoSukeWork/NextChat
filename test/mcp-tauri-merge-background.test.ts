import { jest } from "@jest/globals";

let resolveClient!: (client: any) => void;
const deferred = new Promise<any>((resolve) => {
  resolveClient = resolve;
});
const createRemoteClient = jest.fn(async () => deferred);
jest.unstable_mockModule("@/app/mcp/remote", () => ({
  createRemoteClient,
  nativeMcpFetch: jest.fn(),
  safeRemoteError: () => "connection failed",
}));
const actions = await import("../app/mcp/actions-tauri");

test("desktop merge waits for approval but not the queued connection", async () => {
  let config: any = { mcpServers: {} };
  let decline = true;
  const invoke = jest.fn(async (command: string, args?: any) => {
    if (command === "mcp_read_config")
      return JSON.parse(JSON.stringify(config));
    if (command === "mcp_write_config") {
      if (decline) throw new Error("not approved");
      config = JSON.parse(JSON.stringify(args.config));
    }
  });
  window.__TAURI__ = { invoke } as unknown as NonNullable<Window["__TAURI__"]>;
  const incoming = {
    mcpServers: { remote: { url: "https://example.test/mcp" } },
  };
  const client = {
    listTools: async () => ({ tools: [] }),
    close: jest.fn(async () => {}),
  };
  try {
    await expect(actions.mergeMcpServers(incoming, "")).rejects.toThrow(
      "not approved",
    );
    expect(config).toEqual({ mcpServers: {} });
    expect(createRemoteClient).not.toHaveBeenCalled();
    decline = false;
    await expect(
      Promise.race([
        actions.mergeMcpServers(incoming, ""),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("merge blocked on connection")),
            1000,
          ),
        ),
      ]),
    ).resolves.toEqual(incoming);
    expect(config).toEqual(incoming);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await actions.getClientsStatus("")).remote.status).toBe(
      "initializing",
    );
    resolveClient(client);
    await actions.pauseMcpServer("remote", "");
    expect((await actions.getClientsStatus("")).remote.status).toBe("paused");
    expect(client.close).toHaveBeenCalled();
  } finally {
    resolveClient(client);
    delete window.__TAURI__;
  }
});
