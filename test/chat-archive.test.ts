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
const toast = jest.fn();
jest.unstable_mockModule("@/app/components/ui-lib", () => ({
  showToast: toast,
}));
await import("../app/client/api");
const { EndpointClient } = await import("../app/client/endpoint-client");
jest.spyOn(EndpointClient.prototype, "chat").mockImplementation(async () => {});
const { useAppConfig, useChatStore } = await import(
  "../app/store"
);
const { createEmptyMask } = await import("../app/store/mask");
const { StoreKey } = await import("../app/constant");
const { mergeAppState, mergeCloudAppState, getLocalAppState } = await import(
  "../app/utils/sync"
);

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
const load = (sessions: any[], currentSessionIndex = 0) =>
  useChatStore.setState({ sessions, currentSessionIndex });
const store = () => useChatStore.getState();
const current = () => store().currentSession().id;
const ids = () => store().sessions.map((s) => s.id);

beforeEach(() => {
  toast.mockClear();
  useChatStore.setState({ deletedSessions: {} });
  useAppConfig.setState({
    endpoints: [{ id: "home-endpoint", name: "Home", protocol: "openai-chat", baseUrl: "https://example.test", apiKey: "", models: [{ name: "home" }] }],
    modelConfig: {
      ...useAppConfig.getState().modelConfig,
      model: "home",
      endpointId: "home-endpoint",
    },
  });
});

describe("archiving", () => {
  test("archiving the current session moves to the next visible one", () => {
    load([session("a"), session("b", { archived: true }), session("c")]);
    store().archiveSession("a");
    expect(store().sessions[0].archived).toBe(true);
    expect(current()).toBe("c");
  });

  test("archiving another session keeps the current one and the order", () => {
    load([session("a"), session("b"), session("c")], 2);
    store().archiveSession("a");
    expect(current()).toBe("c");
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  test("archiving the last visible session opens a new empty one", () => {
    load([session("a"), session("b", { archived: true })]);
    store().archiveSession("a");
    expect(store().sessions).toHaveLength(3);
    expect(store().currentSessionIndex).toBe(0);
    expect(store().currentSession().messages).toEqual([]);
    expect(store().currentSession().archived).toBeFalsy();
  });

  test("the last visible session can be archived while viewing an archived one", () => {
    load([session("a"), session("b", { archived: true })], 1);
    store().archiveSession("a");
    expect(current()).toBe("b");
    expect(store().sessions[0].messages).toEqual([]);
  });

  test("empty, unknown and already archived sessions are left alone", () => {
    load([session("a", { messages: [] }), session("b", { archived: true })]);
    const before = store().sessions[1].archiveUpdatedAt;
    store().archiveSession("a");
    store().archiveSession("b");
    store().archiveSession("missing");
    expect(store().sessions[0].archived).toBeFalsy();
    expect(store().sessions[1].archiveUpdatedAt).toBe(before);
    expect(toast).not.toHaveBeenCalled();
  });

  test("undo restores only the archive state and reselects the session", () => {
    load([session("a"), session("b")]);
    store().archiveSession("a");
    expect(current()).toBe("b");
    // Anything that happens in the undo window must survive the undo.
    store().newSession();
    const created = current();
    const action = toast.mock.calls[0][1] as { onClick: () => void };
    action.onClick();
    expect(current()).toBe("a");
    expect(store().sessions.find((s) => s.id === "a")?.archived).toBe(false);
    expect(ids()).toContain(created);
  });

  test("a new timestamp always beats an older one from a fast clock", () => {
    const future = Date.now() + 1_000_000;
    load([session("a", { archived: true, archiveUpdatedAt: future })]);
    store().unarchiveSession("a");
    expect(store().sessions[0].archiveUpdatedAt).toBe(future + 1);
  });

  test("restoring a session that is not archived changes nothing", () => {
    load([session("a")]);
    store().unarchiveSession("a");
    expect(store().sessions[0].archiveUpdatedAt).toBeUndefined();
  });

  test("forks of an archived session are not archived", () => {
    load([session("a", { archived: true, archiveUpdatedAt: 5 }), session("b")]);
    store().forkSession();
    expect(store().currentSession().archived).toBeFalsy();
    expect(store().currentSession().archiveUpdatedAt).toBeUndefined();
  });
});

describe("list navigation with hidden sessions", () => {
  test("next and previous skip archived sessions and wrap around", () => {
    load([
      session("a"),
      session("b", { archived: true }),
      session("c"),
      session("d", { archived: true }),
    ]);
    store().nextSession(1);
    expect(current()).toBe("c");
    store().nextSession(1);
    expect(current()).toBe("a");
    store().nextSession(-1);
    expect(current()).toBe("c");
  });

  test.each([
    [1, "c"],
    [-1, "a"],
  ])("from an archived session, delta %i goes to %s", (delta, expected) => {
    load([session("a"), session("b", { archived: true }), session("c")], 1);
    store().nextSession(delta);
    expect(current()).toBe(expected);
  });

  test.each([
    [1, "a"],
    [-1, "c"],
  ])("from the archived end, delta %i wraps to %s", (delta, expected) => {
    load([session("a"), session("c"), session("z", { archived: true })], 2);
    store().nextSession(delta);
    expect(current()).toBe(expected);
  });

  test("nothing happens when every session is archived", () => {
    load([session("a", { archived: true }), session("b", { archived: true })]);
    store().nextSession(1);
    expect(store().currentSessionIndex).toBe(0);
  });

  test("moving between real indexes keeps the current session with hidden rows", () => {
    load(
      [
        session("a"),
        session("x", { archived: true }),
        session("b"),
        session("c"),
      ],
      3,
    );
    store().moveSession(0, 3);
    expect(ids()).toEqual(["x", "b", "c", "a"]);
    expect(current()).toBe("c");
  });
});

describe("deleting with hidden sessions", () => {
  test("deleting the current session never lands on an archived one", () => {
    load([session("a"), session("b", { archived: true }), session("c")]);
    store().deleteSession(0);
    expect(current()).toBe("c");
  });

  test("deleting the last visible session opens a new empty one", () => {
    load([session("a"), session("b", { archived: true })]);
    store().deleteSession(0);
    expect(store().currentSession().messages).toEqual([]);
    expect(store().sessions).toHaveLength(2);
  });

  test("deleting an archived session from its page keeps the current one", () => {
    load([session("a", { archived: true }), session("b"), session("c")], 2);
    store().deleteSession(0);
    expect(current()).toBe("c");
  });

  test("deleting the only session still leaves one", () => {
    load([session("a")]);
    store().deleteSession(0);
    expect(store().sessions).toHaveLength(1);
    expect(store().currentSession().messages).toEqual([]);
  });

  test("deleting an open archived session goes back to the list", () => {
    load([session("a", { archived: true }), session("b")], 0);
    store().deleteSession(0);
    expect(current()).toBe("b");
  });
});

describe("sending from an archived session", () => {
  test("a user message restores it", async () => {
    load([session("a", { archived: true, archiveUpdatedAt: 5 })]);
    await store().onUserInput("hello");
    expect(store().sessions[0].archived).toBe(false);
    expect(store().sessions[0].archiveUpdatedAt).toBeGreaterThan(5);
  });

  test("a tool response does not", async () => {
    load([session("a", { archived: true, archiveUpdatedAt: 5 })]);
    await store().onUserInput("tool", [], true);
    expect(store().sessions[0].archived).toBe(true);
  });
});

describe("starting the app", () => {
  const merge = (useChatStore as any).persist.getOptions().merge;
  const start = (sessions: any[], currentSessionIndex: number) =>
    merge({ sessions, currentSessionIndex }, store());

  test("an archived current session is replaced by a visible one", () => {
    const state = start([session("a", { archived: true }), session("b")], 0);
    expect(state.sessions[state.currentSessionIndex].id).toBe("b");
  });

  test("with nothing visible a new empty session is opened", () => {
    const state = start([session("a", { archived: true })], 0);
    expect(state.sessions).toHaveLength(2);
    expect(state.currentSessionIndex).toBe(0);
    expect(state.sessions[0].messages).toEqual([]);
  });

  test("a normal current session is untouched", () => {
    const sessions = [session("a"), session("b")];
    const state = start(sessions, 1);
    expect(state.currentSessionIndex).toBe(1);
    expect(state.sessions).toBe(sessions);
  });
});

describe("syncing", () => {
  const chat = (sessions: any[], currentSessionIndex = 0) => ({
    sessions,
    currentSessionIndex,
  });
  const merged = (local: any, remote: any) =>
    (
      mergeCloudAppState(
        { [StoreKey.Chat]: local } as any,
        { [StoreKey.Chat]: remote } as any,
      ) as any
    )[StoreKey.Chat];

  test("a newer archive on the other device applies here", () => {
    const result = merged(
      chat([session("a", { archived: false, archiveUpdatedAt: 5 })]),
      chat([session("a", { archived: true, archiveUpdatedAt: 9 })]),
    );
    expect(result.sessions[0].archived).toBe(true);
    expect(result.sessions[0].archiveUpdatedAt).toBe(9);
  });

  test("a newer restore on the other device applies here", () => {
    const result = merged(
      chat([session("a", { archived: true, archiveUpdatedAt: 5 })]),
      chat([session("a", { archived: false, archiveUpdatedAt: 9 })]),
    );
    expect(result.sessions[0].archived).toBe(false);
  });

  test("newer archive state is merged even if the remote chat is empty", () => {
    const result = merged(
      chat([session("a", { archived: false, archiveUpdatedAt: 5 })]),
      chat([
        session("a", { messages: [], archived: true, archiveUpdatedAt: 9 }),
      ]),
    );
    expect(result.sessions[0].archived).toBe(true);
    expect(result.sessions[0].archiveUpdatedAt).toBe(9);
    expect(result.sessions[0].messages).toHaveLength(1);
  });

  test("an older state from the other device is ignored", () => {
    const result = merged(
      chat([session("a", { archived: true, archiveUpdatedAt: 9 })]),
      chat([session("a", { archived: false, archiveUpdatedAt: 5 })]),
    );
    expect(result.sessions[0].archived).toBe(true);
    expect(result.sessions[0].archiveUpdatedAt).toBe(9);
  });

  test("the local state wins a tie", () => {
    const result = merged(
      chat([session("a", { archived: true, archiveUpdatedAt: 5 })]),
      chat([session("a", { archived: false, archiveUpdatedAt: 5 })]),
    );
    expect(result.sessions[0].archived).toBe(true);
  });

  test("a backup from before this feature does not restore anything", () => {
    const result = merged(
      chat([session("a", { archived: true, archiveUpdatedAt: 5 })]),
      chat([session("a")]),
    );
    expect(result.sessions[0].archived).toBe(true);
  });

  test("a bad timestamp in a backup counts as no timestamp", () => {
    const result = merged(
      chat([session("a", { archived: true, archiveUpdatedAt: 5 })]),
      chat([session("a", { archived: false, archiveUpdatedAt: "9" })]),
    );
    expect(result.sessions[0].archived).toBe(true);
  });

  test("new remote sessions keep their archive state and merging keeps messages", () => {
    const result = merged(
      chat([session("a")]),
      chat([
        session("b", { archived: true, archiveUpdatedAt: 3, lastUpdate: 0 }),
        session("a", {
          messages: [
            { id: "remote", role: "user", content: "x", date: "2026/1/2" },
          ],
        }),
      ]),
    );
    const byId = Object.fromEntries(
      result.sessions.map((s: any) => [s.id, s]),
    ) as any;
    expect(byId.b.archived).toBe(true);
    expect(byId.a.messages.map((m: any) => m.id)).toEqual(["a-m", "remote"]);
  });

  test("the open session stays open after merging reorders the list", () => {
    const result = merged(
      chat(
        [session("old", { lastUpdate: 1 }), session("open", { lastUpdate: 2 })],
        1,
      ),
      chat([session("new", { lastUpdate: 3 })]),
    );
    expect(result.sessions.map((s: any) => s.id)).toEqual([
      "new",
      "open",
      "old",
    ]);
    expect(result.currentSessionIndex).toBe(1);
  });

  test("file import follows the same rules", () => {
    load([session("a", { archived: false, archiveUpdatedAt: 5 })]);
    const local = JSON.parse(JSON.stringify(getLocalAppState()));
    const remote = JSON.parse(JSON.stringify(getLocalAppState()));
    remote[StoreKey.Chat].sessions[0].archived = true;
    remote[StoreKey.Chat].sessions[0].archiveUpdatedAt = 9;
    const result = mergeAppState(local, remote);
    expect(result[StoreKey.Chat].sessions[0].archived).toBe(true);
  });
});
