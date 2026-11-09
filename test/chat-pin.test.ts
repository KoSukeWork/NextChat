import { jest } from "@jest/globals";

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
const { createEmptyMask } = await import("../app/store/mask");
const { orderedVisibleSessions } = await import("../app/utils/chat-order");
const { mergeCloudAppState } = await import("../app/utils/sync");
const { StoreKey } = await import("../app/constant");

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  topic: id,
  memoryPrompt: "",
  messages: [{ id: `${id}-m`, role: "user", content: id, date: "2026/1/1" }],
  stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
  lastUpdate: 1,
  lastSummarizeIndex: 0,
  mask: createEmptyMask(),
  ...extra,
});
const store = () => useChatStore.getState();
const load = (sessions: any[], currentSessionIndex = 0) =>
  useChatStore.setState({ sessions, currentSessionIndex, deletedSessions: {} });
const displayed = (sessions: any[]) =>
  orderedVisibleSessions(sessions).map(({ session }) => session.id);
const merge = (local: any[], remote: any[]) =>
  (
    mergeCloudAppState(
      { [StoreKey.Chat]: { sessions: local, currentSessionIndex: 0 } } as any,
      { [StoreKey.Chat]: { sessions: remote, currentSessionIndex: 0 } } as any,
    ) as any
  )[StoreKey.Chat];

test("visible pin groups keep their relative order without changing the array", () => {
  const sessions = [
    session("u1"),
    session("p1", { pinned: true }),
    session("hidden", { pinned: true, archived: true }),
    session("u2"),
    session("p2", { pinned: true }),
  ];
  expect(displayed(sessions)).toEqual(["p1", "p2", "u1", "u2"]);
  expect(sessions.map((s) => s.id)).toEqual(["u1", "p1", "hidden", "u2", "p2"]);
});

test("navigation follows the displayed groups and wraps in both directions", () => {
  load(
    [
      session("u1"),
      session("p1", { pinned: true }),
      session("hidden", { archived: true }),
      session("u2"),
      session("p2", { pinned: true }),
    ],
    1,
  );
  const selected: string[] = [];
  for (let i = 0; i < 5; i++) {
    selected.push(store().currentSession().id);
    store().nextSession(1);
  }
  expect(selected).toEqual(["p1", "p2", "u1", "u2", "p1"]);
  store().nextSession(-1);
  expect(store().currentSession().id).toBe("p1");
  store().nextSession(-1);
  expect(store().currentSession().id).toBe("u2");
});

test("an open archived pinned session navigates from its place within the pinned group", () => {
  load(
    [
      session("u"),
      session("p1", { pinned: true }),
      session("hidden", { pinned: true, archived: true }),
      session("p2", { pinned: true }),
    ],
    2,
  );
  store().nextSession(1);
  expect(store().currentSession().id).toBe("p2");
  store().selectSessionById("hidden");
  store().nextSession(-1);
  expect(store().currentSession().id).toBe("p1");
});

test("empty chats cannot be pinned and pin updates stay ahead of fast clocks", () => {
  const future = Date.now() + 1000000;
  load([
    session("empty", { messages: [] }),
    session("chat", { pinUpdatedAt: future }),
  ]);
  store().togglePinSession("empty");
  expect(store().sessions[0].pinned).toBeUndefined();
  store().togglePinSession("chat");
  expect(store().sessions[1].pinned).toBe(true);
  expect(store().sessions[1].pinUpdatedAt).toBe(future + 1);
  store().togglePinSession("chat");
  expect(store().sessions[1].pinned).toBe(false);
  expect(store().sessions[1].pinUpdatedAt).toBe(future + 2);
});

test("archive and restore preserve the pin; forks do not inherit it", () => {
  load([session("a", { pinned: true, pinUpdatedAt: 5 }), session("b")]);
  store().archiveSession("a");
  expect(displayed(store().sessions)).toEqual(["b"]);
  store().unarchiveSession("a");
  expect(displayed(store().sessions)).toEqual(["a", "b"]);
  expect(store().sessions[0].pinUpdatedAt).toBe(5);
  store().selectSessionById("a");
  store().forkSession();
  expect(store().currentSession().pinned).toBeUndefined();
  expect(store().currentSession().pinUpdatedAt).toBeUndefined();
});

test.each([
  [5, false, 9, true, true, 9],
  [5, true, 9, false, false, 9],
  [9, true, 5, false, true, 9],
  [5, true, 5, false, true, 5],
  [undefined, false, 9, true, true, 9],
  [5, true, undefined, false, true, 5],
  [undefined, true, undefined, false, true, undefined],
])(
  "pin sync resolves timestamps %s and %s",
  (localTime, localPinned, remoteTime, remotePinned, expected, timestamp) => {
    const result = merge(
      [session("a", { pinned: localPinned, pinUpdatedAt: localTime })],
      [session("a", { pinned: remotePinned, pinUpdatedAt: remoteTime })],
    );
    expect(result.sessions[0].pinned).toBe(expected);
    expect(result.sessions[0].pinUpdatedAt).toBe(timestamp);
  },
);

test("sync may reorder stored sessions but a pinned chat remains first on screen", () => {
  const result = merge(
    [session("pin", { pinned: true, pinUpdatedAt: 2, lastUpdate: 1 })],
    [session("new", { lastUpdate: 100 })],
  );
  expect(result.sessions.map((s: any) => s.id)).toEqual(["new", "pin"]);
  expect(displayed(result.sessions)).toEqual(["pin", "new"]);
});

test("sync keeps local pin order and inserts newly pinned chats by activity", () => {
  const local = [
    session("first", { pinned: true, pinUpdatedAt: 2, lastUpdate: 100 }),
    session("u-old", { lastUpdate: 5 }),
    session("second", { pinned: true, pinUpdatedAt: 2, lastUpdate: 10 }),
    session("u-new", { lastUpdate: 80 }),
  ];
  const remote = [
    session("second", { pinned: true, pinUpdatedAt: 2, lastUpdate: 200 }),
    session("first", { pinned: true, pinUpdatedAt: 2, lastUpdate: 100 }),
    session("remote-pin", { pinned: true, pinUpdatedAt: 3, lastUpdate: 50 }),
  ];
  const result = merge(local, remote);
  expect(displayed(result.sessions)).toEqual([
    "first",
    "second",
    "remote-pin",
    "u-new",
    "u-old",
  ]);
  const again = merge(result.sessions, remote);
  expect(displayed(again.sessions)).toEqual([
    "first",
    "second",
    "remote-pin",
    "u-new",
    "u-old",
  ]);

  const sortedLocal = [
    session("high", { pinned: true, lastUpdate: 100 }),
    session("low", { pinned: true, lastUpdate: 10 }),
  ];
  expect(
    displayed(
      merge(sortedLocal, [session("middle", { pinned: true, lastUpdate: 50 })])
        .sessions,
    ),
  ).toEqual(["high", "middle", "low"]);
});
