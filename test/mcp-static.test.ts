import * as actions from "../app/mcp/actions-static";

test("desktop builds always report MCP disabled", async () => {
  await expect(actions.isMcpEnabled()).resolves.toBe(false);
});

test("desktop MCP operations reject without a server", async () => {
  await expect(actions.executeMcpAction("test", {} as any, "")).rejects.toThrow(
    "unavailable in the desktop app",
  );
});
