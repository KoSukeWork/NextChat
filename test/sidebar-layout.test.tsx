import React from "react";
import { jest } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

for (const icon of [
  "settings",
  "github",
  "logo",
  "add",
  "delete",
  "mask",
  "mcp",
  "drag",
  "discovery",
  "archive",
  "search",
])
  jest.unstable_mockModule(`@/app/icons/${icon}.svg`, () => ({
    default: () => <svg />,
  }));
jest.unstable_mockModule("next/dynamic", () => ({ default: () => () => null }));
jest.unstable_mockModule("@/app/components/ui-lib", () => ({
  Selector: () => null,
  showConfirm: jest.fn(),
  showToast: jest.fn(),
}));
jest
  .mocked(global.fetch)
  .mockImplementation(
    async (input) =>
      ({
        json: async () =>
          String(input).includes("prompts.json")
            ? { en: [], cn: [], tw: [] }
            : [],
      }) as Response,
  );
await import("../app/client/api");
const { useAppConfig, useChatStore } = await import("../app/store");
const { SideBar } = await import("../app/components/sidebar");
const Locale = (await import("../app/locales")).default;
const { Path } = await import("../app/constant");
let location: ReturnType<typeof useLocation>;
function Probe() {
  location = useLocation();
  return null;
}
function setup() {
  render(
    <MemoryRouter>
      <SideBar />
      <Probe />
    </MemoryRouter>,
  );
}
const item = (id: string, archived: boolean) => ({
  id,
  archived,
  messages: [],
});
beforeEach(() => {
  useAppConfig.setState({ sidebarWidth: 300 });
  useChatStore.setState({
    sessions: [item("a", false)] as any,
    currentSessionIndex: 0,
  });
});
afterEach(cleanup);

test("archive is available with zero chats and appears between settings and GitHub", () => {
  setup();
  const settings = screen.getByRole("button", { name: Locale.Settings.Title });
  const archive = screen.getByRole("button", { name: Locale.Archive.Entry(0) });
  const github = screen.getByRole("button", {
    name: Locale.Export.MessageFromChatGPT,
  });
  expect(archive).toHaveAttribute("title", Locale.Archive.Entry(0));
  expect(archive.textContent).toBe("");
  expect(
    settings.compareDocumentPosition(archive) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    archive.compareDocumentPosition(github) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByText("Build your own AI assistant.")).toBeNull();
  fireEvent.click(archive);
  expect(location.pathname).toBe(Path.Archived);
});

test("archive tooltip and accessible name include the live count", () => {
  useChatStore.setState({
    sessions: [item("a", false), item("b", true), item("c", true)] as any,
  });
  setup();
  const archive = screen.getByRole("button", { name: Locale.Archive.Entry(2) });
  expect(archive).toHaveAttribute("title", Locale.Archive.Entry(2));
  expect(archive.textContent).toBe("");
});

test("at minimum desktop width new chat becomes an accessible icon button", () => {
  useAppConfig.setState({ sidebarWidth: 230 });
  setup();
  const add = screen.getByRole("button", { name: Locale.Home.NewChat });
  expect(add).toHaveAttribute("title", Locale.Home.NewChat);
  expect(add.textContent).toBe("");
});
