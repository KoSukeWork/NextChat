import React from "react";
import { jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
jest.mocked(global.fetch).mockImplementation(
  async (input) =>
    ({
      json: async () =>
        String(input).includes("prompts.json")
          ? { en: [], cn: [], tw: [] }
          : [],
    }) as Response,
);
const toast = jest.fn();
jest.unstable_mockModule("@/app/components/ui-lib", () => ({
  showToast: toast,
  showConfirm: async () => true,
  Modal: ({ title, children, actions }: any) => (
    <div role="dialog" aria-label={title}>
      {children}
      {actions}
    </div>
  ),
}));
for (const icon of ["archive", "delete", "folder-move", "pin-upright"])
  jest.unstable_mockModule(`@/app/icons/${icon}.svg`, () => ({
    default: () => <svg />,
  }));
jest.unstable_mockModule("@/app/components/mask", () => ({
  MaskAvatar: () => <span />,
}));
let onDragEnd: (result: unknown) => void;
let onDragStart: (result: unknown) => void;
jest.unstable_mockModule("@hello-pangea/dnd", () => ({
  DragDropContext: (props: any) => {
    onDragEnd = props.onDragEnd;
    onDragStart = props.onDragStart;
    return props.children;
  },
  Droppable: (props: any) =>
    props.children({
      innerRef: () => {},
      droppableProps:
        props.droppableId === "chat-list"
          ? { "data-drop-disabled": String(!!props.isDropDisabled) }
          : {},
    }),
  Draggable: (props: any) =>
    props.children({
      innerRef: () => {},
      draggableProps: {
        "data-position": props.index,
        "data-chat-id": props.draggableId,
      },
      dragHandleProps: {},
    }),
}));
await import("../app/client/api");
const { useChatStore } = await import("../app/store");
const { useChatFolderUI } = await import("../app/store/chat-folder-ui");
const { createEmptyMask } = await import("../app/store/mask");
const { ChatList } = await import("../app/components/chat-list");
const Locale = (await import("../app/locales")).default;

const session = (id: string, extra = {}) => ({
  id,
  topic: id,
  memoryPrompt: "",
  messages: [
    { id: `${id}-m`, role: "user" as const, content: id, date: "2026/1/1" },
  ],
  stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
  lastUpdate: 1,
  lastSummarizeIndex: 0,
  mask: createEmptyMask(),
  ...extra,
});

function setup(sessions: any[], currentSessionIndex = 0) {
  useChatStore.setState({ sessions, currentSessionIndex });
  render(
    <MemoryRouter>
      <ChatList />
    </MemoryRouter>,
  );
}
const ids = () => useChatStore.getState().sessions.map((s) => s.id);
const current = () => useChatStore.getState().currentSession().id;

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  useChatFolderUI.getState().selectFolder(null);
  useChatFolderUI.getState().setNarrow(false);
  useChatStore.setState({ folders: [], deletedFolders: {} });
});
afterEach(cleanup);

test("folder tabs filter the global activity order and unpinned drag does not reorder", () => {
  useChatStore.setState({
    folders: [{ id: "f", name: "Work", order: 0, updatedAt: 1 }],
  });
  setup([
    session("a", { folderId: "f", lastUpdate: 10 }),
    session("outside", { lastUpdate: 20 }),
    session("p", { folderId: "f", pinned: true }),
    session("b", { folderId: "f", lastUpdate: 30 }),
  ]);
  expect(screen.getByRole("button", { name: "Work" })).toBeInTheDocument();
  expect(screen.getAllByText(/messages · Work/)).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "Work" }));
  expect(screen.queryByText("outside")).toBeNull();
  expect(screen.getByText("p").closest("[data-position]")).toHaveAttribute(
    "data-position",
    "0",
  );
  expect(screen.getByText("b").closest("[data-position]")).toHaveAttribute(
    "data-position",
    "1",
  );
  act(() => onDragStart({ source: { droppableId: "chat-list", index: 1 } }));
  expect(document.querySelector("[data-drop-disabled]")).toHaveAttribute(
    "data-drop-disabled",
    "true",
  );
  act(() =>
    onDragEnd({
      source: { droppableId: "chat-list", index: 1 },
      destination: { droppableId: "chat-list", index: 2 },
    }),
  );
  expect(ids()).toEqual(["a", "outside", "p", "b"]);
  expect(document.querySelector("[data-drop-disabled]")).toHaveAttribute(
    "data-drop-disabled",
    "false",
  );
  fireEvent.click(screen.getByRole("button", { name: Locale.Folder.All }));
  expect(screen.getByText("outside")).toBeInTheDocument();
  expect(screen.getByText("b").closest("[data-position]")).toHaveAttribute(
    "data-position",
    "1",
  );
});

test("dragging a chat onto a folder and reordering folder tabs retain chat times", () => {
  useChatStore.setState({
    folders: [
      { id: "f", name: "Work", order: 0, updatedAt: 1 },
      { id: "g", name: "Study", order: 1, updatedAt: 1 },
    ],
  });
  setup([session("a"), session("b")]);
  act(() =>
    onDragEnd({
      source: { droppableId: "chat-list", index: 0 },
      destination: { droppableId: "folder-drop:f", index: 0 },
    }),
  );
  expect(useChatStore.getState().sessions[0]).toMatchObject({
    id: "a",
    folderId: "f",
    lastUpdate: 1,
  });
  act(() =>
    onDragEnd({
      source: { droppableId: "folder-tabs", index: 0 },
      destination: { droppableId: "folder-tabs", index: 1 },
    }),
  );
  expect(useChatStore.getState().folders.map((item) => item.name)).toEqual([
    "Study",
    "Work",
  ]);
  expect(ids()).toEqual(["a", "b"]);
});

test("a chat moved during a drag is identified by ID even if activity reorders the list", () => {
  useChatStore.setState({
    folders: [{ id: "f", name: "Work", order: 0, updatedAt: 1 }],
  });
  setup([session("a", { lastUpdate: 20 }), session("b", { lastUpdate: 10 })]);
  act(() =>
    onDragStart({
      draggableId: "a",
      source: { droppableId: "chat-list", index: 0 },
    }),
  );
  act(() =>
    useChatStore.setState((state) => ({
      sessions: state.sessions.map((item) =>
        item.id === "b" ? { ...item, lastUpdate: 30 } : item,
      ),
    })),
  );
  expect(document.querySelector('[data-chat-id="b"]')).toHaveAttribute(
    "data-position",
    "0",
  );
  act(() =>
    onDragEnd({
      draggableId: "a",
      source: { droppableId: "chat-list", index: 0 },
      destination: { droppableId: "folder-drop:f", index: 0 },
    }),
  );
  expect(
    useChatStore.getState().sessions.find((item) => item.id === "a")?.folderId,
  ).toBe("f");
  expect(
    useChatStore.getState().sessions.find((item) => item.id === "b")?.folderId,
  ).toBeUndefined();
});

test("a wide dragged chat uses the pointer position when folder drop zones overlap", () => {
  useChatStore.setState({
    folders: [
      { id: "f", name: "Work", order: 0, updatedAt: 1 },
      { id: "g", name: "Study", order: 1, updatedAt: 1 },
    ],
  });
  setup([session("a"), session("b")]);
  const rect = (left: number, right: number) => ({
    left,
    right,
    top: 10,
    bottom: 40,
    x: left,
    y: 10,
    width: right - left,
    height: 30,
    toJSON: () => ({}),
  });
  const bar = document.querySelector<HTMLElement>("[data-folder-bar]")!;
  const work = document.querySelector<HTMLElement>(
    '[data-chat-folder-drop="f"]',
  )!;
  const study = document.querySelector<HTMLElement>(
    '[data-chat-folder-drop="g"]',
  )!;
  jest.spyOn(bar, "getBoundingClientRect").mockReturnValue(rect(0, 200));
  jest.spyOn(work, "getBoundingClientRect").mockReturnValue(rect(0, 90));
  jest.spyOn(study, "getBoundingClientRect").mockReturnValue(rect(100, 190));
  fireEvent.mouseUp(window, { clientX: 150, clientY: 20 });
  const announce = jest.fn();
  act(() =>
    (onDragEnd as any)(
      {
        reason: "DROP",
        source: { droppableId: "chat-list", index: 0 },
        destination: { droppableId: "folder-drop:f", index: 0 },
      },
      { announce },
    ),
  );
  expect(useChatStore.getState().sessions[0].folderId).toBe("g");
  expect(announce).toHaveBeenCalledWith(Locale.Folder.MovedTo("Study"));
  fireEvent.mouseUp(window, { clientX: 250, clientY: 20 });
  act(() =>
    (onDragEnd as any)(
      {
        reason: "DROP",
        source: { droppableId: "chat-list", index: 0 },
        destination: { droppableId: "folder-drop:f", index: 0 },
      },
      { announce },
    ),
  );
  expect(useChatStore.getState().sessions[0].folderId).toBe("g");
  expect(announce).toHaveBeenLastCalledWith(Locale.Folder.MoveCancelled);
});

test("folder options offer a three-way confirmation with archived count", () => {
  useChatStore.setState({
    folders: [{ id: "f", name: "Work", order: 0, updatedAt: 1 }],
  });
  setup([
    session("a", { folderId: "f" }),
    session("hidden", { folderId: "f", archived: true }),
    session("b"),
  ]);
  fireEvent.click(
    screen.getByRole("button", { name: Locale.Folder.Options("Work") }),
  );
  fireEvent.click(screen.getByRole("button", { name: Locale.Folder.Delete }));
  expect(
    screen.getByText(Locale.Folder.DeleteQuestion("Work", 2, 1)),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: Locale.UI.Cancel }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: Locale.Folder.DeleteFolderOnly }),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: Locale.Folder.DeleteFolderOnly }),
  );
  expect(useChatStore.getState().sessions.map((s) => s.folderId)).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
});

test("the move action marks the current location and can create a destination", () => {
  useChatStore.setState({
    folders: [{ id: "f", name: "Work", order: 0, updatedAt: 1 }],
  });
  setup([session("a"), session("b")]);
  fireEvent.click(
    screen.getAllByRole("button", { name: Locale.Folder.MoveChat })[0],
  );
  expect(
    screen.getByRole("button", {
      name: Locale.Folder.Current(Locale.Folder.Ungrouped),
    }),
  ).toBeInTheDocument();
  const before = useChatStore.getState().sessions[0];
  fireEvent.click(
    screen.getByRole("button", {
      name: Locale.Folder.Current(Locale.Folder.Ungrouped),
    }),
  );
  expect(useChatStore.getState().sessions[0]).toBe(before);
  fireEvent.click(
    screen.getAllByRole("button", { name: Locale.Folder.MoveChat })[0],
  );
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: Locale.Folder.Create,
    }),
  );
  const input = screen.getByRole("textbox", { name: Locale.Folder.Name });
  fireEvent.change(input, { target: { value: "New folder" } });
  fireEvent.keyDown(input, { key: "Enter" });
  const created = useChatStore
    .getState()
    .folders.find((item) => item.name === "New folder")!;
  expect(useChatStore.getState().sessions[0].folderId).toBe(created.id);
  fireEvent.click(
    screen.getAllByRole("button", { name: Locale.Folder.MoveChat })[0],
  );
  const selected = screen.getByRole("button", {
    name: Locale.Folder.Current("New folder"),
  });
  const after = useChatStore.getState().sessions[0];
  fireEvent.click(selected);
  expect(useChatStore.getState().sessions[0]).toBe(after);
});

test("folder input preserves invalid names and handles IME, Enter and Escape", () => {
  useChatStore.setState({
    folders: [{ id: "f", name: "Work", order: 0, updatedAt: 1 }],
  });
  setup([session("a")]);
  fireEvent.click(screen.getByRole("button", { name: Locale.Folder.Create }));
  const input = screen.getByRole("textbox", { name: Locale.Folder.Name });
  expect(input.tagName).toBe("INPUT");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("alert")).toHaveTextContent(Locale.Folder.EmptyName);
  fireEvent.change(input, { target: { value: " work " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("alert")).toHaveTextContent(
    Locale.Folder.DuplicateName,
  );
  expect(input).toHaveValue(" work ");
  fireEvent.change(input, { target: { value: "Study" } });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(useChatStore.getState().folders).toHaveLength(1);
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(useChatStore.getState().folders.map((folder) => folder.name)).toEqual([
    "Work",
    "Study",
  ]);
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: Locale.Folder.Options("Work") }),
  );
  expect(
    screen.getByRole("dialog", { name: Locale.Folder.Options("Work") }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: Locale.Folder.Rename }));
  const rename = screen.getByRole("textbox", { name: Locale.Folder.Name });
  expect(rename).toHaveValue("Work");
  fireEvent.change(rename, { target: { value: "Study" } });
  fireEvent.keyDown(rename, { key: "Enter" });
  expect(screen.getByRole("alert")).toHaveTextContent(
    Locale.Folder.DuplicateName,
  );
  fireEvent.keyDown(rename, { key: "Escape" });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(useChatStore.getState().folders[0].name).toBe("Work");
});

test("empty folder shows help and deletion omits the zero archive count", () => {
  useChatStore.setState({
    folders: [{ id: "f", name: "Work", order: 0, updatedAt: 1 }],
  });
  setup([session("outside")]);
  fireEvent.click(screen.getByRole("button", { name: "Work" }));
  expect(screen.getByText(Locale.Folder.Empty)).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: Locale.Folder.Options("Work") }),
  );
  fireEvent.click(screen.getByRole("button", { name: Locale.Folder.Delete }));
  expect(
    screen.getByText(Locale.Folder.DeleteQuestion("Work", 0, 0)),
  ).toBeInTheDocument();
  expect(Locale.Folder.DeleteQuestion("Work", 0, 0)).not.toContain("archived");
});

test("narrow view hides folder tabs and shows every unarchived chat", () => {
  useChatStore.setState({
    folders: [{ id: "f", name: "Work", order: 0, updatedAt: 1 }],
    sessions: [
      session("a", { folderId: "f", lastUpdate: 10 }),
      session("b", { lastUpdate: 20 }),
    ],
    currentSessionIndex: 0,
  });
  useChatFolderUI.getState().selectFolder("f");
  render(
    <MemoryRouter>
      <ChatList narrow />
    </MemoryRouter>,
  );
  expect(screen.queryByRole("button", { name: Locale.Folder.All })).toBeNull();
  expect(screen.getAllByLabelText(Locale.Folder.MoveChat)).toHaveLength(2);
  expect(document.querySelector('[data-chat-id="b"]')).toHaveAttribute(
    "data-position",
    "0",
  );
});

test("archived sessions are hidden and rows use positions in the visible list", () => {
  setup([session("a"), session("x", { archived: true }), session("b")]);
  expect(screen.getByText("a")).toBeInTheDocument();
  expect(screen.queryByText("x")).toBeNull();
  expect(screen.getByText("b").closest("[data-position]")).toHaveAttribute(
    "data-position",
    "1",
  );
});

test.each([
  [0, 2],
  [2, 0],
  [0, 1],
])("dragging unpinned %i to %i leaves storage order alone", (from, to) => {
  setup([
    session("a"),
    session("x", { archived: true }),
    session("b"),
    session("y", { archived: true }),
    session("c"),
  ]);
  act(() =>
    onDragEnd({
      source: { droppableId: "chat-list", index: from },
      destination: { droppableId: "chat-list", index: to },
    }),
  );
  expect(ids()).toEqual(["a", "x", "b", "y", "c"]);
});

test("clicking a row selects the real session behind hidden rows", () => {
  setup([session("x", { archived: true }), session("a"), session("b")], 1);
  fireEvent.click(screen.getByText("b"));
  expect(current()).toBe("b");
});

test("the delete button removes the real session behind hidden rows", async () => {
  setup([session("x", { archived: true }), session("a"), session("b")], 1);
  const row = screen.getByText("b").closest("[data-position]")!;
  const buttons = row.querySelectorAll("svg");
  await act(async () => {
    fireEvent.click(buttons[buttons.length - 1].parentElement!);
  });
  expect(ids()).toEqual(["x", "a"]);
});

test("the archive button hides the row without opening it", () => {
  setup([session("a"), session("b")]);
  fireEvent.click(
    screen
      .getAllByTitle(Locale.Archive.Action)
      .find((button) => button.closest("[data-position='1']"))!,
  );
  expect(useChatStore.getState().sessions[1].archived).toBe(true);
  expect(current()).toBe("a");
  expect(screen.queryByText("b")).toBeNull();
});

test("empty sessions have no archive button", () => {
  setup([session("a", { messages: [] })]);
  expect(screen.queryByTitle(Locale.Archive.Action)).toBeNull();
});

test("pinning a row leaves the underlying order alone and marks it", () => {
  setup([session("a"), session("b")]);
  const row = screen.getByText("b").closest("[data-position]")!;
  fireEvent.click(row.querySelector(`[aria-label="${Locale.Pin.Action}"]`)!);
  expect(ids()).toEqual(["a", "b"]);
  expect(screen.getByText("b").closest("[data-position]")).toHaveAttribute(
    "data-position",
    "0",
  );
  expect(screen.getByTitle(Locale.Pin.Pinned)).toBeInTheDocument();
  expect(screen.getByLabelText(Locale.Pin.Undo)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(current()).toBe("a");
});

test("an empty session has no pin action", () => {
  setup([session("a", { messages: [] })]);
  expect(screen.queryByLabelText(Locale.Pin.Action)).toBeNull();
});

test.each([
  [0, 3, ["p2", "p1", "u1", "u2"]],
  [3, 0, ["p1", "p2", "u1", "u2"]],
])("dragging across the groups clamps %i to %i", (from, to, expected) => {
  setup([
    session("u1"),
    session("p1", { pinned: true }),
    session("hidden", { archived: true }),
    session("u2"),
    session("p2", { pinned: true }),
  ]);
  act(() =>
    onDragEnd({
      source: { droppableId: "chat-list", index: from },
      destination: { droppableId: "chat-list", index: to },
    }),
  );
  expect(
    expected.map(
      (id) =>
        screen
          .getByText(id)
          .closest("[data-position]")
          ?.getAttribute("data-position"),
    ),
  ).toEqual(["0", "1", "2", "3"]);
  expect(
    useChatStore.getState().sessions.find((s) => s.id === "hidden")?.archived,
  ).toBe(true);
  expect(
    useChatStore
      .getState()
      .sessions.filter((s) => s.pinned)
      .map((s) => s.id)
      .sort(),
  ).toEqual(["p1", "p2"]);
});

test("pinned chats in a folder can still be dragged relative to each other", () => {
  useChatStore.setState({
    folders: [{ id: "f", name: "Work", order: 0, updatedAt: 1 }],
  });
  setup([
    session("p1", { pinned: true, folderId: "f" }),
    session("outside", { pinned: true }),
    session("p2", { pinned: true, folderId: "f" }),
    session("u", { folderId: "f" }),
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Work" }));
  act(() => onDragStart({ source: { droppableId: "chat-list", index: 1 } }));
  expect(document.querySelector("[data-drop-disabled]")).toHaveAttribute(
    "data-drop-disabled",
    "false",
  );
  act(() =>
    onDragEnd({
      source: { droppableId: "chat-list", index: 1 },
      destination: { droppableId: "chat-list", index: 0 },
    }),
  );
  expect(ids()).toEqual(["p2", "p1", "outside", "u"]);
});

test("pinned chats remain marked in the narrow list", () => {
  useChatStore.setState({
    sessions: [session("a", { pinned: true })],
    currentSessionIndex: 0,
  });
  render(
    <MemoryRouter>
      <ChatList narrow />
    </MemoryRouter>,
  );
  expect(screen.getByTitle(Locale.Pin.Pinned)).toBeInTheDocument();
  expect(screen.getByLabelText(Locale.Pin.Undo)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
