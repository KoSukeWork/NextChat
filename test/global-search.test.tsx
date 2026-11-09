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
}));
await import("../app/client/api");
const { useChatStore } = await import("../app/store");
const { useChatFolderUI } = await import("../app/store/chat-folder-ui");
const { useSearchJump } = await import("../app/store/search-jump");
const { createEmptyMask } = await import("../app/store/mask");
const { GlobalSearch, useGlobalSearch } = await import(
  "../app/components/global-search"
);
const Locale = (await import("../app/locales")).default;
const text = Locale.SearchChat;

const message = (id: string, content: string, role = "user") => ({
  id,
  role,
  content,
  date: "2026/11/4 10:00:00",
});
const session = (id: string, topic: string, messages: any[], extra = {}) => ({
  id,
  topic,
  memoryPrompt: "",
  messages,
  stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
  lastUpdate: 1,
  lastSummarizeIndex: 0,
  mask: createEmptyMask(),
  ...extra,
});

let location: ReturnType<typeof useLocation>;
function Probe() {
  location = useLocation();
  return null;
}

function setup() {
  render(
    <MemoryRouter>
      <GlobalSearch />
      <Probe />
    </MemoryRouter>,
  );
}

const open = () =>
  act(() => {
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  });
const input = () =>
  screen.getByRole("dialog").querySelector("input") as HTMLInputElement;
const flush = () =>
  act(() => {
    jest.advanceTimersByTime(200);
  });
function search(value: string) {
  fireEvent.change(input(), { target: { value } });
  flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  useGlobalSearch.setState({ open: false });
  useSearchJump.setState({ request: null });
  useChatFolderUI.getState().selectFolder(null);
  useChatFolderUI.getState().setNarrow(false);
  useChatStore.setState({
    folders: [],
    deletedFolders: {},
    sessions: [
      session("first", "第一个对话", [message("m1", "没有关键词")]),
      session(
        "second",
        "第二个对话",
        [message("m2", "Docker needle here"), message("m3", "another needle")],
        { lastUpdate: 2 },
      ),
      session("hidden", "归档的对话", [message("m4", "needle archived")], {
        archived: true,
        lastUpdate: 3,
      }),
    ] as any,
    currentSessionIndex: 0,
  });
});

test("folder search defaults to all, labels results, filters without changing time order, and switches tabs on open", () => {
  useChatStore.setState({
    folders: [
      { id: "f", name: "Work", order: 0, updatedAt: 1 },
      { id: "g", name: "Study", order: 1, updatedAt: 1 },
    ],
    sessions: [
      session("a", "older needle", [], { folderId: "f", lastUpdate: 1 }),
      session("b", "newer needle", [], { folderId: "g", lastUpdate: 3 }),
      session("c", "middle needle", [], { folderId: "f", lastUpdate: 2 }),
      session("d", "ungrouped needle", [], { lastUpdate: 4 }),
    ] as any,
  });
  useChatFolderUI.getState().selectFolder("f");
  setup();
  open();
  search("needle");
  expect(
    screen.getByRole("button", { name: Locale.Folder.SearchAll }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("Study")).toBeInTheDocument();
  const textContent = screen.getByRole("dialog").textContent!;
  expect(textContent.indexOf("ungrouped needle")).toBeLessThan(
    textContent.indexOf("newer needle"),
  );
  expect(textContent.indexOf("newer needle")).toBeLessThan(
    textContent.indexOf("middle needle"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: Locale.Folder.SearchCurrent("Work") }),
  );
  expect(screen.getByRole("dialog").textContent).not.toContain("newer needle");
  expect(screen.getByRole("dialog").textContent).not.toContain(
    "ungrouped needle",
  );
  expect(screen.getByRole("dialog").textContent).toContain("middle needle");
  fireEvent.click(
    screen.getByRole("button", { name: Locale.Folder.SearchAll }),
  );
  fireEvent.click(
    screen.getByText((_, element) => element?.textContent === "newer needle"),
  );
  expect(useChatStore.getState().currentSession().id).toBe("b");
  expect(useChatFolderUI.getState().selectedFolderId).toBe("g");
});

test("opening an ungrouped search result from a folder returns the sidebar to all", () => {
  useChatStore.setState({
    folders: [{ id: "f", name: "Work", order: 0, updatedAt: 1 }],
    sessions: [
      session("a", "needle", [], { folderId: "f" }),
      session("b", "other needle", [], { lastUpdate: 2 }),
    ] as any,
  });
  useChatFolderUI.getState().selectFolder("f");
  setup();
  open();
  search("needle");
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(useChatStore.getState().currentSession().id).toBe("b");
  expect(useChatFolderUI.getState().selectedFolderId).toBeNull();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

test("Ctrl+K and Cmd+K toggle the panel from anywhere", () => {
  setup();
  expect(screen.queryByRole("dialog")).toBeNull();
  open();
  expect(input()).toHaveFocus();
  act(() => {
    fireEvent.keyDown(window, { key: "K", metaKey: true });
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  // Other shortcuts built on the same letter stay free.
  act(() => {
    fireEvent.keyDown(window, { key: "k", ctrlKey: true, shiftKey: true });
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the sidebar button opens the panel through the shared state", () => {
  setup();
  act(() => useGlobalSearch.getState().setOpen(true));
  expect(input()).toBeInTheDocument();
});

test("results are highlighted, labelled and ordered newest first", () => {
  setup();
  open();
  expect(screen.getByText(text.Hint)).toBeInTheDocument();
  search("needle");
  const marks = document.querySelectorAll("mark");
  expect(marks.length).toBe(2);
  expect(marks[0].textContent).toBe("needle");
  expect(screen.getByText(text.MatchCount(2))).toBeInTheDocument();
  expect(screen.queryByText("归档的对话")).toBeNull();
});

test("message markup is shown as text, not rendered", () => {
  useChatStore.setState({
    sessions: [
      session("x", "t", [message("m", "<img src=x onerror=alert(1)> needle")]),
    ] as any,
  });
  setup();
  open();
  search("needle");
  expect(document.querySelector("img")).toBeNull();
  expect(document.body.textContent).toContain("<img src=x");
});

test("no match shows the empty state", () => {
  setup();
  open();
  search("absent-word");
  expect(screen.getByText(text.Page.NoResult)).toBeInTheDocument();
});

test("nothing is searched during an IME composition", () => {
  setup();
  open();
  fireEvent.compositionStart(input());
  fireEvent.change(input(), { target: { value: "needle" } });
  flush();
  expect(document.querySelector("mark")).toBeNull();
  // Enter confirms the composition; it must not open a result.
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(input()).toBeInTheDocument();

  fireEvent.compositionEnd(input());
  flush();
  expect(document.querySelector("mark")).not.toBeNull();
});

test("keyboard selection opens the exact message of the right session", () => {
  setup();
  open();
  search("docker");
  fireEvent.keyDown(input(), { key: "ArrowDown" });
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(useChatStore.getState().currentSession().id).toBe("second");
  expect(useSearchJump.getState().request).toEqual({
    sessionId: "second",
    messageId: "m2",
  });
  expect(location.state).toBeNull();
});

test("arrow keys wrap around the results", () => {
  setup();
  open();
  search("docker");
  fireEvent.keyDown(input(), { key: "ArrowUp" });
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(useSearchJump.getState().request).toEqual({
    sessionId: "second",
    messageId: "m2",
  });
});

test("a session row opens the session without a jump", () => {
  setup();
  open();
  search("第二个");
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(useChatStore.getState().currentSession().id).toBe("second");
  expect(location.state).toBeNull();
  expect(useSearchJump.getState().request).toBeNull();
});

test.each(["archived", "归档的对话"])(
  "archived message or title %s is excluded",
  (query) => {
    setup();
    open();
    search(query);
    expect(screen.getByText(text.Page.NoResult)).toBeInTheDocument();
    expect(
      useChatStore.getState().sessions.find((s) => s.id === "hidden")?.archived,
    ).toBe(true);
  },
);

test("a session deleted meanwhile just closes the panel", () => {
  setup();
  open();
  search("docker");
  useChatStore.setState({ sessions: [session("first", "t", [])] as any });
  fireEvent.keyDown(input(), { key: "ArrowDown" });
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(useChatStore.getState().currentSession().id).toBe("first");
  expect(location.state).toBeNull();
  expect(useSearchJump.getState().request).toBeNull();
});

test("jump requests are one-shot and cannot clear a newer request", () => {
  const old = { sessionId: "second", messageId: "m2" };
  const newer = { sessionId: "second", messageId: "m3" };
  useSearchJump.getState().setRequest(old);
  useSearchJump.getState().setRequest(newer);
  useSearchJump.getState().consume(old);
  expect(useSearchJump.getState().request).toBe(newer);
  useSearchJump.getState().consume(newer);
  expect(useSearchJump.getState().request).toBeNull();
});

test("long sessions collapse and expand with the keyboard", () => {
  useChatStore.setState({
    sessions: [
      session(
        "many",
        "t",
        Array.from({ length: 8 }, (_, i) => message(`m${i}`, `needle ${i}`)),
      ),
    ] as any,
  });
  setup();
  open();
  search("needle");
  expect(document.querySelectorAll("mark")).toHaveLength(5);
  const more = screen.getByText(text.More(3));
  fireEvent.click(more);
  expect(document.querySelectorAll("mark")).toHaveLength(8);
  expect(input()).toBeInTheDocument();
});

test("Escape closes only the panel and clicking outside closes it too", () => {
  const pageListener = jest.fn();
  document.addEventListener("keydown", pageListener);
  setup();
  open();
  pageListener.mockClear();
  act(() => {
    fireEvent.keyDown(input(), { key: "Escape" });
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(pageListener).not.toHaveBeenCalled();
  document.removeEventListener("keydown", pageListener);

  open();
  fireEvent.click(input().closest(".modal-mask")!);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("focus returns to where the user was typing", () => {
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  textarea.focus();
  setup();
  open();
  expect(input()).toHaveFocus();
  act(() => {
    fireEvent.keyDown(input(), { key: "Escape" });
  });
  expect(textarea).toHaveFocus();
  textarea.remove();
});

test("a reply arriving while the panel is open does not search again", () => {
  setup();
  open();
  search("needle");
  const before = document.querySelectorAll("mark").length;
  act(() => {
    const [first] = useChatStore.getState().sessions;
    useChatStore.getState().updateTargetSession(first, (target) => {
      target.messages = [message("new", "needle new")] as any;
    });
  });
  flush();
  expect(document.querySelectorAll("mark")).toHaveLength(before);
});
