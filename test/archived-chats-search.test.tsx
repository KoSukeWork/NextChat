import React from "react";
import { jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

for (const icon of ["close", "delete", "eye", "return"])
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
jest.unstable_mockModule("@/app/components/ui-lib", () => ({
  showToast: jest.fn(),
  showConfirm: jest.fn(async () => true),
}));
await import("../app/client/api");
const { useChatStore } = await import("../app/store");
const { useSearchJump } = await import("../app/store/search-jump");
const { createEmptyMask } = await import("../app/store/mask");
const { ArchivedChatsPage } = await import("../app/components/archived-chats");
const Locale = (await import("../app/locales")).default;
const text = Locale.Archive;
let location: ReturnType<typeof useLocation>;
function Probe() {
  location = useLocation();
  return null;
}
const message = (id: string, content: any, role = "user", extra = {}) => ({
  id,
  content,
  role,
  date: "2026/11/4 10:00:00",
  ...extra,
});
const session = (
  id: string,
  topic: string,
  messages: any[],
  archived: boolean,
  time: number,
) => ({
  id,
  topic,
  messages,
  archived,
  archiveUpdatedAt: time,
  lastUpdate: time,
  memoryPrompt: "",
  stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
  lastSummarizeIndex: 0,
  mask: createEmptyMask(),
});
const input = () => screen.getByRole("textbox", { name: text.Page.Search });
const flush = (ms = 160) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });
const search = (query: string) => {
  fireEvent.change(input(), { target: { value: query } });
  flush();
};
const setup = () =>
  render(
    <MemoryRouter>
      <ArchivedChatsPage />
      <Probe />
    </MemoryRouter>,
  );

beforeEach(() => {
  jest.useFakeTimers();
  useSearchJump.setState({ request: null });
  useChatStore.setState({
    folders: [],
    deletedFolders: {},
    currentSessionIndex: 2,
    sessions: [
      session(
        "a",
        "Design archive",
        [
          message("a1", [
            { type: "text", text: "Docker build" },
            { type: "image_url", image_url: { url: "ignored" } },
            { type: "text", text: "ERROR details" },
          ]),
        ],
        true,
        20,
      ),
      session(
        "b",
        "Python notes",
        [
          message(
            "b1",
            "<think>hidden-secret</think>Visible Fallback",
            "assistant",
          ),
          message("tool", "private-tool", "user", { isMcpResponse: true }),
        ],
        true,
        10,
      ),
      session(
        "c",
        "Live Docker",
        [message("c1", "Docker error visible fallback")],
        false,
        30,
      ),
    ] as any,
  });
});

test("archived chats show their folder and restoring preserves it", () => {
  const sessions = useChatStore
    .getState()
    .sessions.map((item) =>
      item.id === "a" ? { ...item, folderId: "f", folderUpdatedAt: 5 } : item,
    );
  useChatStore.setState({
    sessions,
    folders: [{ id: "f", name: "Work", order: 0, updatedAt: 1 }],
  });
  setup();
  expect(screen.getByText(/Work/)).toBeInTheDocument();
  fireEvent.click(
    screen.getAllByRole("button", {
      name: `${text.Restore} ${text.Restore}`,
    })[0],
  );
  const restored = useChatStore
    .getState()
    .sessions.find((item) => item.id === "a")!;
  expect(restored.archived).toBe(false);
  expect(restored.folderId).toBe("f");
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

test("empty query lists only archived sessions in archive order", () => {
  setup();
  const design = screen.getByText("Design archive");
  const python = screen.getByText("Python notes");
  expect(
    design.compareDocumentPosition(python) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByText("Live Docker")).toBeNull();
});

test("the archive page shows its empty state when no chats are archived", () => {
  useChatStore.setState({
    sessions: [session("c", "Live chat", [], false, 30)] as any,
  });
  setup();
  expect(screen.getByText(text.Page.Empty)).toBeInTheDocument();
});

test("search matches multiple keywords across message text parts and highlights the snippet", () => {
  setup();
  fireEvent.change(input(), { target: { value: "docker ERROR" } });
  flush(100);
  expect(screen.getByText("Python notes")).toBeInTheDocument();
  flush(60);
  expect(screen.getByText("Design archive")).toBeInTheDocument();
  expect(screen.queryByText("Python notes")).toBeNull();
  expect(screen.queryByText("Live Docker")).toBeNull();
  expect(
    Array.from(document.querySelectorAll("mark")).map((m) => m.textContent),
  ).toEqual(["Docker", "ERROR"]);
});

test.each(["hidden-secret", "private-tool"])(
  "excludes hidden thinking and tool text %s",
  (query) => {
    setup();
    search(query);
    expect(screen.getByText(text.Page.NoResult)).toBeInTheDocument();
    expect(screen.queryByText("Python notes")).toBeNull();
  },
);

test("IME composition does not search until composition ends", () => {
  setup();
  fireEvent.compositionStart(input());
  fireEvent.change(input(), { target: { value: "fallback" } });
  flush(1000);
  expect(screen.getByText("Design archive")).toBeInTheDocument();
  expect(document.querySelector("mark")).toBeNull();
  fireEvent.compositionEnd(input());
  flush();
  expect(screen.queryByText("Design archive")).toBeNull();
  expect(document.querySelector("mark")?.textContent).toBe("Fallback");
});

test("viewing a message match requests a jump and keeps the saved chat archived", () => {
  setup();
  search("visible fallback");
  fireEvent.click(screen.getByRole("button", { name: new RegExp(text.View) }));
  expect(location.pathname).toBe("/chat");
  expect(useSearchJump.getState().request).toEqual({
    sessionId: "b",
    messageId: "b1",
  });
  expect(useChatStore.getState().currentSession().archived).toBe(true);
});

test("title-only results are highlighted and open without a message jump", () => {
  setup();
  search("python");
  expect(document.querySelector("mark")?.textContent).toBe("Python");
  fireEvent.click(screen.getByRole("button", { name: new RegExp(text.View) }));
  expect(useChatStore.getState().currentSession().id).toBe("b");
  expect(useSearchJump.getState().request).toBeNull();
});

test("restore works during search and removes the row without touching other archived chats", () => {
  setup();
  search("docker error");
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(text.Restore) }),
  );
  expect(screen.queryByText("Design archive")).toBeNull();
  expect(
    useChatStore.getState().sessions.find((s) => s.id === "a")?.archived,
  ).toBe(false);
  expect(
    useChatStore.getState().sessions.find((s) => s.id === "b")?.archived,
  ).toBe(true);
  search("");
  expect(screen.getByText("Python notes")).toBeInTheDocument();
});
