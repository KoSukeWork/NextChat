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
import { MemoryRouter, Route, Routes } from "react-router-dom";

const enabled = jest.fn<() => Promise<boolean>>(async () => true);
const config = jest.fn<(...args: any[]) => Promise<any>>();
const statuses = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule("@/app/mcp/actions", () => ({
  isMcpEnabled: enabled,
  getMcpConfigFromFile: config,
  getClientsStatus: statuses,
  getAllTools: async () => [],
  executeMcpAction: async () => undefined,
  mergeMcpServers: async () => ({}),
}));
jest.unstable_mockModule("@/app/components/emoji", () => ({
  Avatar: () => <span />,
  AvatarPicker: () => <span />,
}));
for (const icon of ["reload", "rename", "plugin", "mcp", "share"])
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

const { useChatMcpSelector } = await import("../app/components/chat-mcp");
const { MobileChatActions } = await import("../app/components/chat");
const { useAccessStore, useChatStore, createEmptySession } = await import(
  "../app/store"
);
const { Path } = await import("../app/constant");
const Locale = (await import("../app/locales")).default;

function SelectorHarness() {
  const mcp = useChatMcpSelector();
  return (
    <>
      {mcp.enabled && <button onClick={() => void mcp.open()}>Open MCP</button>}
      {mcp.selector}
    </>
  );
}
function renderSelector() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<SelectorHarness />} />
        <Route path={Path.McpMarket} element={<div>MCP destination</div>} />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  enabled.mockReset().mockResolvedValue(true);
  config.mockReset();
  statuses.mockReset();
  const session = createEmptySession();
  session.mask.mcpDisabled = ["paused-off", "missing"];
  useChatStore.setState({ sessions: [session], currentSessionIndex: 0 });
  useAccessStore.setState({ accessCode: "test-code" });
});
afterEach(cleanup);

test("paused servers are unselected and cannot alter their saved choices", async () => {
  config.mockResolvedValue({
    mcpServers: {
      active: { url: "https://example.test" },
      "paused-off": { url: "https://example.test", status: "paused" },
      "paused-on": { url: "https://example.test", status: "paused" },
    },
  });
  statuses.mockResolvedValue({
    active: { status: "active", errorMsg: null },
    "paused-off": { status: "paused", errorMsg: null },
    "paused-on": { status: "paused", errorMsg: null },
  });
  const { unmount } = renderSelector();
  fireEvent.click(await screen.findByText("Open MCP"));
  await screen.findByText("paused-off");
  expect(config).toHaveBeenCalledTimes(1);
  expect(statuses).toHaveBeenCalledTimes(1);
  expect(config).toHaveBeenCalledWith("test-code");
  const row = (id: string) =>
    screen.getByText(id).parentElement!.parentElement!.parentElement!;
  expect(
    row("active").querySelector("[style*='border-radius']"),
  ).not.toBeNull();
  expect(
    row("paused-off").querySelector("[style*='border-radius']"),
  ).toBeNull();
  expect(row("paused-on").querySelector("[style*='border-radius']")).toBeNull();
  expect(screen.getAllByText(Locale.Mcp.StoppedForAllChats)).toHaveLength(2);
  fireEvent.click(screen.getByText("paused-off"));
  fireEvent.click(screen.getByText("paused-on"));
  expect(
    row("paused-off").querySelector("[style*='border-radius']"),
  ).toBeNull();
  expect(row("paused-on").querySelector("[style*='border-radius']")).toBeNull();
  expect(useChatStore.getState().currentSession().mask.mcpDisabled).toEqual([
    "paused-off",
    "missing",
  ]);
  fireEvent.click(screen.getByText("active"));
  expect(useChatStore.getState().currentSession().mask.mcpDisabled).toEqual([
    "paused-off",
    "missing",
    "active",
  ]);
  fireEvent.click(screen.getByText("active"));
  expect(useChatStore.getState().currentSession().mask.mcpDisabled).toEqual([
    "paused-off",
    "missing",
  ]);
  unmount();
  config.mockResolvedValue({
    mcpServers: {
      "paused-off": { url: "https://example.test" },
      "paused-on": { url: "https://example.test" },
    },
  });
  statuses.mockResolvedValue({
    "paused-off": { status: "active", errorMsg: null },
    "paused-on": { status: "active", errorMsg: null },
  });
  renderSelector();
  fireEvent.click(await screen.findByText("Open MCP"));
  await screen.findByText("paused-on");
  expect(
    row("paused-off").querySelector("[style*='border-radius']"),
  ).toBeNull();
  expect(
    row("paused-on").querySelector("[style*='border-radius']"),
  ).not.toBeNull();
});

test("an empty configuration opens the MCP page", async () => {
  config.mockResolvedValue({ mcpServers: {} });
  statuses.mockResolvedValue({});
  renderSelector();
  fireEvent.click(await screen.findByText("Open MCP"));
  expect(await screen.findByText("MCP destination")).toBeInTheDocument();
});

test("a delayed load cannot change a different conversation", async () => {
  let finish!: (value: unknown) => void;
  config.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  statuses.mockResolvedValue({});
  const other = createEmptySession();
  act(() =>
    useChatStore.setState((state) => ({
      sessions: [...state.sessions, other],
    })),
  );
  renderSelector();
  fireEvent.click(await screen.findByText("Open MCP"));
  act(() => useChatStore.setState({ currentSessionIndex: 1 }));
  await act(async () => {
    finish({ mcpServers: { server: { url: "https://example.test" } } });
  });
  expect(screen.queryByText("server")).toBeNull();
  expect(
    useChatStore.getState().currentSession().mask.mcpDisabled,
  ).toBeUndefined();
});

test("mobile more menu exposes MCP only when it is enabled", async () => {
  config.mockResolvedValue({ mcpServers: {} });
  statuses.mockResolvedValue({});
  render(
    <MemoryRouter>
      <MobileChatActions
        onRefresh={() => {}}
        onEdit={() => {}}
        onExport={() => {}}
      />
    </MemoryRouter>,
  );
  await waitFor(() => expect(enabled).toHaveBeenCalled());
  fireEvent.click(
    screen.getByRole("button", { name: Locale.Chat.Actions.More }),
  );
  expect(
    await screen.findByRole("menuitem", { name: Locale.Mcp.Name }),
  ).toBeInTheDocument();
});

test("mobile more menu hides MCP when the feature is disabled", async () => {
  enabled.mockResolvedValue(false);
  render(
    <MemoryRouter>
      <MobileChatActions
        onRefresh={() => {}}
        onEdit={() => {}}
        onExport={() => {}}
      />
    </MemoryRouter>,
  );
  await waitFor(() => expect(enabled).toHaveBeenCalled());
  fireEvent.click(
    screen.getByRole("button", { name: Locale.Chat.Actions.More }),
  );
  expect(screen.queryByRole("menuitem", { name: Locale.Mcp.Name })).toBeNull();
});
