import { jest } from "@jest/globals";
import type { McpOAuthProvider, OAuthCredentials } from "../app/mcp/oauth";

const providers: Array<McpOAuthProvider | undefined> = [];
jest.unstable_mockModule("@/app/mcp/remote", () => ({
  nativeMcpFetch: async () => new Response(),
  safeRemoteError: () => "Remote MCP network or protocol request failed",
  createRemoteClient: async (
    _id: string,
    _server: unknown,
    _fetch: unknown,
    provider: McpOAuthProvider | undefined,
  ) => {
    providers.push(provider);
    return { close: async () => {}, listTools: async () => ({ tools: [] }) };
  },
}));
const actions = await import("../app/mcp/actions-tauri");

afterEach(() => {
  delete window.__TAURI__;
});

test("a refresh provider created before sign-out cannot rewrite removed credentials", async () => {
  const url = "http://127.0.0.1:45670/mcp";
  const config = { mcpServers: { mock: { url, status: "active" } } };
  let credentials: OAuthCredentials | null = {
    serverUrl: url,
    redirectUri: "http://127.0.0.1:45671/callback",
    client: { client_id: "synthetic" },
    tokens: { access_token: "synthetic", token_type: "Bearer" },
  };
  window.__TAURI__ = {
    invoke: async (command: string, args?: any) => {
      if (command === "mcp_read_config") return config;
      if (command === "mcp_oauth_read")
        return credentials && JSON.parse(JSON.stringify(credentials));
      if (command === "mcp_oauth_write") {
        credentials = args.credentials;
        return;
      }
      if (command === "mcp_oauth_remove") {
        credentials = null;
        return;
      }
      if (command === "mcp_kill") return;
      throw new Error("Unexpected test command");
    },
  } as unknown as NonNullable<Window["__TAURI__"]>;
  await actions.initializeMcpSystem("");
  const stale = providers[0];
  expect(stale).toBeDefined();
  await actions.logoutMcpOAuth("mock", "");
  expect(credentials).toBeNull();
  await expect(
    stale!.saveTokens({ access_token: "stale", token_type: "Bearer" }),
  ).rejects.toThrow("MCP server changed");
  expect(credentials).toBeNull();
});
