import { jest } from "@jest/globals";
import type { McpOAuthProvider } from "../app/mcp/oauth";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let loginError: () => Error;
jest.unstable_mockModule("@/app/mcp/remote", () => ({
  nativeMcpFetch: async () => new Response(),
  safeRemoteError: () => "Remote MCP network or protocol request failed",
  createRemoteClient: async () => {
    throw loginError();
  },
}));
jest.unstable_mockModule("@modelcontextprotocol/sdk/client/auth.js", () => ({
  discoverOAuthServerInfo: async () => ({
    authorizationServerMetadata: {
      authorization_endpoint: "http://127.0.0.1:45670/authorize",
      token_endpoint: "http://127.0.0.1:45670/token",
      registration_endpoint: "http://127.0.0.1:45670/register",
    },
  }),
  auth: async (provider: McpOAuthProvider) => {
    provider.redirectToAuthorization(
      new URL("http://127.0.0.1:45670/authorize"),
    );
    return "REDIRECT";
  },
}));

const { OAuthLoginNeeded } = await import("../app/mcp/oauth");
loginError = () => new OAuthLoginNeeded();
const actions = await import("../app/mcp/actions-tauri");

async function setup(id: string, options?: { delayedListen?: boolean }) {
  const config = {
    mcpServers: {
      [id]: { url: "http://127.0.0.1:45670/mcp", status: "active" },
    },
  };
  const wait = deferred<string>();
  const waiting = deferred<void>();
  const listenStarted = deferred<void>();
  const listener = deferred<{ id: string; redirectUri: string }>();
  const commands: string[] = [];
  window.__TAURI__ = {
    invoke: async (command: string) => {
      commands.push(command);
      if (command === "mcp_read_config") return config;
      if (command === "mcp_oauth_read") return null;
      if (command === "mcp_kill") return;
      if (command === "mcp_oauth_listen") {
        listenStarted.resolve();
        if (options?.delayedListen) return listener.promise;
        return {
          id: `listener-${id}`,
          redirectUri: "http://127.0.0.1:45671/callback",
        };
      }
      if (command === "mcp_oauth_open") return;
      if (command === "mcp_oauth_wait") {
        waiting.resolve();
        return wait.promise;
      }
      if (command === "mcp_oauth_cancel") {
        wait.reject(new Error("OAuth login cancelled"));
        return;
      }
      throw new Error(`Unexpected test command: ${command}`);
    },
  } as unknown as NonNullable<Window["__TAURI__"]>;
  // Some tests cancel before wait is invoked, so consume that unused rejection.
  void wait.promise.catch(() => {});
  await actions.initializeMcpSystem("");
  return { commands, wait, waiting, listener, listenStarted };
}

afterEach(() => {
  delete window.__TAURI__;
});

test("cancelling a pending callback closes it and preserves login-required", async () => {
  const harness = await setup("cancel-wait");
  const attempt = actions.beginMcpOAuth("cancel-wait", "", "");
  const result = expect(attempt).rejects.toThrow("OAuth login cancelled");
  await harness.waiting.promise;
  await actions.cancelMcpOAuth("cancel-wait", "");
  await result;
  expect(harness.commands).toContain("mcp_oauth_cancel");
  expect((await actions.getClientsStatus(""))["cancel-wait"].status).toBe(
    "login-required",
  );
});

test("cancelling while the listener is being created closes it before opening a browser", async () => {
  const harness = await setup("cancel-listen", { delayedListen: true });
  const attempt = actions.beginMcpOAuth("cancel-listen", "", "");
  const result = expect(attempt).rejects.toThrow("OAuth login cancelled");
  await harness.listenStarted.promise;
  await actions.cancelMcpOAuth("cancel-listen", "");
  harness.listener.resolve({
    id: "late-listener",
    redirectUri: "http://127.0.0.1:45671/callback",
  });
  await result;
  expect(harness.commands).toContain("mcp_oauth_cancel");
  expect(harness.commands).not.toContain("mcp_oauth_open");
});

test.each([
  ["timeout", "OAuth login timed out", "OAuth login timed out"],
  [
    "denial",
    "OAuth authorization was not completed",
    "OAuth login could not start",
  ],
])(
  "%s reaches the UI as a safe, distinct result",
  async (id, error, expected) => {
    const harness = await setup(id);
    const attempt = actions.beginMcpOAuth(id, "", "");
    const result = expect(attempt).rejects.toThrow(expected);
    await harness.waiting.promise;
    harness.wait.reject(new Error(error));
    await result;
  },
);
