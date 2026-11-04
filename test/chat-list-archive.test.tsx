import React from "react";
import { jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
}));
for (const icon of ["archive", "delete", "pin-upright"])
  jest.unstable_mockModule(`@/app/icons/${icon}.svg`, () => ({
    default: () => <svg />,
  }));
jest.unstable_mockModule("@/app/components/mask", () => ({
  MaskAvatar: () => <span />,
}));
let onDragEnd: (result: unknown) => void;
jest.unstable_mockModule("@hello-pangea/dnd", () => ({
  DragDropContext: (props: any) => {
    onDragEnd = props.onDragEnd;
    return props.children;
  },
  Droppable: (props: any) =>
    props.children({ innerRef: () => {}, droppableProps: {} }),
  Draggable: (props: any) =>
    props.children({
      innerRef: () => {},
      draggableProps: { "data-position": props.index },
      dragHandleProps: {},
    }),
}));
await import("../app/client/api");
const { useChatStore } = await import("../app/store");
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
afterEach(cleanup);

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
  // visible a b c, hidden x and y between them
  [0, 2, ["x", "b", "y", "c", "a"]],
  [2, 0, ["c", "a", "x", "b", "y"]],
  [0, 1, ["x", "b", "a", "y", "c"]],
])("dragging %i to %i keeps the visible order right", (from, to, expected) => {
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
  expect(ids()).toEqual(expected);
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
  [3, 0, ["p1", "p2", "u2", "u1"]],
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
