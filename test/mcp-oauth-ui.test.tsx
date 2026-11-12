import React from "react";
import { jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

function deferred<T>() {
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((_, no) => {
    reject = no;
  });
  return { promise, reject };
}

const attempts: Array<ReturnType<typeof deferred<{ url: string }>>> = [];
const cancel = jest.fn(async () => {});
const reconnect = jest.fn(async () => {});
const toast = jest.fn();
let status = "login-required";
const config = {
  mcpServers: { example: { url: "http://127.0.0.1:45670/mcp" } },
};
jest.unstable_mockModule("@/app/mcp/actions", () => ({
  isMcpEnabled: async () => true,
  getMcpConfigFromFile: async () => config,
  getClientsStatus: async () => ({ example: { status, errorMsg: null } }),
  reconnectMcpErrors: reconnect,
  beginMcpOAuth: () => {
    const attempt = deferred<{ url: string }>();
    attempts.push(attempt);
    return attempt.promise;
  },
  cancelMcpOAuth: cancel,
  logoutMcpOAuth: async () => {},
  addMcpServer: async () => config,
  getClientTools: async () => null,
  getAllTools: async () => [],
  getAvailableClientsCount: async () => 0,
  executeMcpAction: async () => undefined,
  initializeMcpSystem: async () => config,
  pauseMcpServer: async () => config,
  restartAllClients: async () => config,
  resumeMcpServer: async () => config,
  removeMcpServer: async () => config,
  mergeMcpServers: async () => config,
}));
jest.unstable_mockModule("@/app/mcp/tauri-api", () => ({
  isTauri: () => true,
  invoke: async () => undefined,
  listen: async () => () => {},
}));
jest.unstable_mockModule("@/app/components/error", () => ({
  ErrorBoundary: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}));
jest.unstable_mockModule("@/app/utils/stream", () => ({
  fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }),
  NativeStreamError: class NativeStreamError extends Error {},
}));
jest.unstable_mockModule("@/app/components/ui-lib", () => ({
  List: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ListItem: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Modal: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  showToast: toast,
}));
for (const icon of [
  "edit",
  "add",
  "close",
  "delete",
  "reload",
  "eye",
  "github",
  "play",
  "pause",
])
  jest.unstable_mockModule(`@/app/icons/${icon}.svg`, () => ({
    default: () => <svg />,
  }));

jest.mocked(global.fetch).mockImplementation(
  async (input) =>
    ({
      json: async () =>
        String(input).includes("prompts.json")
          ? { en: [], cn: [], tw: [] }
          : [],
    }) as Response,
);

const { McpMarketPage } = await import("../app/components/mcp-market");
const Locale = (await import("../app/locales")).default;

beforeEach(() => {
  status = "login-required";
  attempts.length = 0;
  cancel.mockClear();
  reconnect.mockClear();
  toast.mockClear();
});
afterEach(cleanup);

function setup() {
  render(
    <MemoryRouter>
      <McpMarketPage />
    </MemoryRouter>,
  );
}

test("cancel restores login immediately; an old rejection cannot hide a newer attempt", async () => {
  setup();
  fireEvent.click(
    await screen.findByRole("button", { name: Locale.Mcp.Login }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: Locale.UI.Cancel }),
  );
  expect(cancel).toHaveBeenCalledWith("example", "");
  fireEvent.click(
    await screen.findByRole("button", { name: Locale.Mcp.Login }),
  );
  expect(
    await screen.findByRole("button", { name: Locale.UI.Cancel }),
  ).toBeEnabled();
  await act(async () => attempts[0].reject(new Error("OAuth login cancelled")));
  expect(screen.getByRole("button", { name: Locale.UI.Cancel })).toBeEnabled();
  expect(toast).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: Locale.UI.Cancel }));
  await act(async () => attempts[1].reject(new Error("OAuth login cancelled")));
});

test.each([
  ["OAuth login timed out", () => Locale.Mcp.OAuthTimeout],
  ["OAuth login could not start", () => Locale.Mcp.OAuthFailed],
])("login error %s shows its localized message", async (message, expected) => {
  setup();
  fireEvent.click(
    await screen.findByRole("button", { name: Locale.Mcp.Login }),
  );
  await act(async () => attempts[0].reject(new Error(message)));
  await waitFor(() => expect(toast).toHaveBeenCalledWith(expected()));
});

test("unsupported sign-in uses a short badge with the full explanation", async () => {
  status = "oauth-unsupported";
  setup();
  const badge = await screen.findByText(Locale.Mcp.OAuthUnsupportedShort);
  expect(badge).toHaveAttribute("title", Locale.Mcp.OAuthUnsupported);
});

test("opening the page retries once; later status polling does not retry", async () => {
  setup();
  await screen.findByRole("button", { name: Locale.Mcp.Login });
  expect(reconnect).toHaveBeenCalledTimes(1);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
  expect(reconnect).toHaveBeenCalledTimes(1);
});
