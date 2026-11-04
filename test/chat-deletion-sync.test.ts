import { jest } from "@jest/globals";
import { TextDecoder, TextEncoder } from "util";

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
const { useChatStore, useAppConfig } = await import(
  "../app/store"
);
const { createEmptyMask } = await import("../app/store/mask");
const { useSyncStore } = await import("../app/store/sync");
const {
  getLocalAppState,
  getCloudAppState,
  mergeCloudAppState,
  mergeAppState,
} = await import("../app/utils/sync");
const { StoreKey } = await import("../app/constant");
const { ProviderType } = await import("../app/utils/cloud");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  topic: id,
  memoryPrompt: "",
  messages: [{ id: `${id}-m`, role: "user", content: id, date: "2026/1/1" }],
  stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
  lastUpdate: 100,
  lastSummarizeIndex: 0,
  mask: createEmptyMask(),
  ...extra,
});
const chat = (
  sessions: any[],
  deletedSessions?: Record<string, number>,
  currentSessionIndex = 0,
) => ({
  ...clone(getLocalAppState()[StoreKey.Chat]),
  sessions,
  deletedSessions,
  currentSessionIndex,
});
const mergeChat = (local: any, remote: any) =>
  mergeCloudAppState(
    { [StoreKey.Chat]: clone(local) } as any,
    { [StoreKey.Chat]: clone(remote) } as any,
  )[StoreKey.Chat];
const load = (
  sessions: any[],
  currentSessionIndex = 0,
  deletedSessions: Record<string, number> = {},
) => useChatStore.setState({ sessions, currentSessionIndex, deletedSessions });
const originalTauri = Object.getOwnPropertyDescriptor(window, "__TAURI__");
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
afterEach(() => {
  if (originalTauri) Object.defineProperty(window, "__TAURI__", originalTauri);
  else Reflect.deleteProperty(window, "__TAURI__");
});

test("deletion writes a tombstone newer than future edits, archive and pin timestamps; empty chats do not", () => {
  const future = Date.now() + 100_000;
  load([
    session("a", {
      lastUpdate: future,
      archiveUpdatedAt: future + 50,
      pinUpdatedAt: future + 100,
    }),
    session("empty", { messages: [] }),
  ]);
  useChatStore.getState().deleteSession(0);
  expect(useChatStore.getState().deletedSessions.a).toBeGreaterThan(
    future + 100,
  );
  const emptyIndex = useChatStore
    .getState()
    .sessions.findIndex((s) => s.id === "empty");
  useChatStore.getState().deleteSession(emptyIndex);
  expect(useChatStore.getState().deletedSessions).not.toHaveProperty("empty");
});

test("clearSessions records all nonempty sessions and preserves existing tombstones", () => {
  load(
    [
      session("a", { lastUpdate: Date.now() + 5000 }),
      session("b", { archived: true }),
      session("empty", { messages: [] }),
    ],
    0,
    { old: 55 },
  );
  const aTime = useChatStore.getState().sessions[0].lastUpdate;
  useChatStore.getState().clearSessions();
  const state = useChatStore.getState();
  expect(state.deletedSessions.a).toBeGreaterThan(aTime);
  expect(state.deletedSessions.b).toBeGreaterThan(0);
  expect(state.deletedSessions.old).toBe(55);
  expect(state.deletedSessions).not.toHaveProperty("empty");
  expect(state.sessions).toHaveLength(1);
  expect(state.sessions[0].messages).toEqual([]);
});

test("undo removes only its tombstone, preserves later changes and beats an already synced deletion", () => {
  load([session("a"), session("b")]);
  useChatStore.getState().deleteSession(0);
  const tombstone = useChatStore.getState().deletedSessions.a;
  const undo = (toast.mock.calls[0] as any)[1].onClick as () => void;
  useChatStore.setState((state) => ({
    sessions: [...state.sessions, session("c") as any],
    deletedSessions: {
      ...state.deletedSessions,
      a: tombstone + 20,
      unrelated: 3,
    },
  }));
  undo();
  const state = useChatStore.getState();
  expect(state.sessions.map((s) => s.id)).toEqual(["a", "b", "c"]);
  expect(state.deletedSessions).not.toHaveProperty("a");
  expect(state.deletedSessions.unrelated).toBe(3);
  expect(state.sessions[0].lastUpdate).toBeGreaterThan(tombstone + 20);
  const result = mergeChat(
    chat(clone(state.sessions)),
    chat([], { a: tombstone + 20 }),
  );
  expect(result.sessions.some((s) => s.id === "a")).toBe(true);
  expect(result.deletedSessions).not.toHaveProperty("a");
});

test("a remote deletion removes the current chat and selects its nearest visible neighbour", () => {
  const local = chat(
    [
      session("before", { lastUpdate: 10 }),
      session("current", { lastUpdate: 30 }),
      session("hidden", { archived: true, lastUpdate: 40 }),
      session("next", { lastUpdate: 20 }),
    ],
    {},
    1,
  );
  const result = mergeChat(local, chat([], { current: 31 }));
  expect(result.sessions.map((s) => s.id)).not.toContain("current");
  expect(result.sessions[result.currentSessionIndex].id).toBe("next");
});

test("deleting the open chat when only archived ones remain creates a fresh visible session", () => {
  const local = chat([
    session("current"),
    session("hidden", { archived: true }),
  ]);
  const result = mergeChat(local, chat([], { current: 101 }));
  expect(result.sessions.some((s) => s.id === "hidden" && s.archived)).toBe(
    true,
  );
  expect(result.sessions[result.currentSessionIndex].messages).toEqual([]);
  expect(result.sessions[result.currentSessionIndex].archived).not.toBe(true);
});

test.each(["lastUpdate", "archiveUpdatedAt", "pinUpdatedAt"])(
  "a newer %s preserves a continued or restored conversation",
  (field) => {
    const old = session("same", {
      lastUpdate: 50,
      messages: [{ id: "old", role: "user", content: "old", date: "2026/1/1" }],
    });
    const newer = session("same", {
      [field]: 201,
      messages: [{ id: "new", role: "user", content: "new", date: "2026/1/2" }],
    });
    const merged = mergeChat(chat([old], { same: 200 }), chat([newer]));
    const kept = merged.sessions.find((s) => s.id === "same")!;
    expect(kept.messages.map((m) => m.id)).toEqual(["old", "new"]);
    expect(
      Math.max(
        kept.lastUpdate,
        kept.archiveUpdatedAt ?? 0,
        kept.pinUpdatedAt ?? 0,
      ),
    ).toBeGreaterThan(200);
    expect(merged.deletedSessions).not.toHaveProperty("same");
    const again = mergeChat(merged, chat([], { same: 200 }));
    expect(again.sessions.some((s) => s.id === "same")).toBe(true);
  },
);

test("tombstones union by maximum, equality deletes, and old backups cannot resurrect", () => {
  const local = chat([session("same", { lastUpdate: 200 }), session("keep")], {
    same: 100,
    localOnly: 44,
  });
  const remote = chat([session("same", { lastUpdate: 200 })], {
    same: 200,
    remoteOnly: 55,
  });
  const result = mergeChat(local, remote);
  expect(result.sessions.map((s) => s.id)).not.toContain("same");
  expect({ ...result.deletedSessions }).toEqual({
    same: 200,
    localOnly: 44,
    remoteOnly: 55,
  });
  const oldBackup = chat([session("same", { lastUpdate: 199 })]);
  delete oldBackup.deletedSessions;
  const again = mergeChat(result, oldBackup);
  expect(again.sessions.some((s) => s.id === "same")).toBe(false);
  expect(again.deletedSessions.same).toBe(200);
});

test("legacy chat state without tombstones merges and retains the current session id", () => {
  const local = chat(
    [
      session("older", { lastUpdate: 5 }),
      session("current", { lastUpdate: 10 }),
    ],
    undefined,
    1,
  );
  const remote = chat([session("new", { lastUpdate: 20 })]);
  delete local.deletedSessions;
  delete remote.deletedSessions;
  const result = mergeChat(local, remote);
  expect(result.sessions[result.currentSessionIndex].id).toBe("current");
  expect({ ...result.deletedSessions }).toEqual({});
});

test("local import explicitly restores a blocked chat beyond a future tombstone", () => {
  const local = clone(getLocalAppState()),
    remote = clone(local);
  const future = Date.now() + 200_000;
  local[StoreKey.Chat].sessions = [session("other") as any];
  local[StoreKey.Chat].currentSessionIndex = 0;
  local[StoreKey.Chat].deletedSessions = { restore: future };
  remote[StoreKey.Chat].sessions = [
    session("restore", { lastUpdate: 50 }) as any,
  ];
  remote[StoreKey.Chat].deletedSessions = { restore: future + 10 };
  const input = clone(remote);
  const merged = mergeAppState(local, remote, { restoreDeletedSessions: true });
  const restored = merged[StoreKey.Chat].sessions.find(
    (s) => s.id === "restore",
  )!;
  expect(restored.lastUpdate).toBeGreaterThan(future + 10);
  expect(merged[StoreKey.Chat].deletedSessions).not.toHaveProperty("restore");
  expect(remote).toEqual(input);
  const syncAgain = mergeChat(
    merged[StoreKey.Chat],
    chat([], { restore: future + 10 }),
  );
  expect(syncAgain.sessions.some((s) => s.id === "restore")).toBe(true);
});

test("a user message updates the session before the model response finishes", async () => {
  const future = Date.now() + 50_000;
  load([session("a", { lastUpdate: future })]);
  await useChatStore.getState().onUserInput("continuing offline");
  expect(useChatStore.getState().sessions[0].lastUpdate).toBeGreaterThan(
    future,
  );
});

test("deletion and tombstone survive two real store syncs against an old WebDAV backup", async () => {
  Object.assign(global, { TextEncoder, TextDecoder });
  load([session("remove"), session("keep")]);
  let backup = JSON.stringify(getCloudAppState());
  useChatStore.getState().deleteSession(0);
  const deletedAt = useChatStore.getState().deletedSessions.remove;
  const invoke = jest.fn(async (_command: string, args: any) => {
    if (args.request.method === "MKCOL") return { status: 405, body: "" };
    if (args.request.method === "GET") return { status: 200, body: backup };
    backup = args.request.body;
    return { status: 204, body: "" };
  });
  Object.defineProperty(window, "__TAURI__", {
    configurable: true,
    value: { invoke },
  });
  useSyncStore.setState({
    provider: ProviderType.WebDAV,
    webdav: {
      endpoint: "https://dav.example",
      username: "test",
      password: "test",
    },
  });
  await useSyncStore.getState().sync();
  await useSyncStore.getState().sync();
  const uploaded = JSON.parse(backup);
  expect(Object.keys(uploaded).sort()).toEqual(
    [StoreKey.Chat, StoreKey.Mask, StoreKey.Prompt].sort(),
  );
  expect(uploaded[StoreKey.Chat].deletedSessions.remove).toBe(deletedAt);
  expect(
    uploaded[StoreKey.Chat].sessions.some((s: any) => s.id === "remove"),
  ).toBe(false);
  expect(useChatStore.getState().sessions.some((s) => s.id === "remove")).toBe(
    false,
  );
});

test("first cloud upload also contains local tombstones", async () => {
  Object.assign(global, { TextEncoder, TextDecoder });
  load([session("remove"), session("keep")]);
  useChatStore.getState().deleteSession(0);
  const deletedAt = useChatStore.getState().deletedSessions.remove;
  let uploaded = "";
  const invoke = jest.fn(async (_command: string, args: any) => {
    if (args.request.method === "MKCOL") return { status: 201, body: "" };
    if (args.request.method === "GET") return { status: 404, body: "" };
    uploaded = args.request.body;
    return { status: 204, body: "" };
  });
  Object.defineProperty(window, "__TAURI__", {
    configurable: true,
    value: { invoke },
  });
  useSyncStore.setState({
    provider: ProviderType.WebDAV,
    webdav: {
      endpoint: "https://dav.example",
      username: "test",
      password: "test",
    },
  });
  await useSyncStore.getState().sync();
  expect(JSON.parse(uploaded)[StoreKey.Chat].deletedSessions.remove).toBe(
    deletedAt,
  );
});

test("deleting while an upload is in flight survives the completed sync", async () => {
  Object.assign(global, { TextEncoder, TextDecoder });
  load([session("remove"), session("keep")]);
  let backup = JSON.stringify(getCloudAppState());
  let startUpload!: () => void;
  let finishUpload!: () => void;
  const started = new Promise<void>((resolve) => {
    startUpload = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    finishUpload = resolve;
  });
  let firstPut = true;
  const invoke = jest.fn(async (_command: string, args: any) => {
    if (args.request.method === "MKCOL") return { status: 405, body: "" };
    if (args.request.method === "GET") return { status: 200, body: backup };
    if (firstPut) {
      firstPut = false;
      startUpload();
      await finish;
    }
    backup = args.request.body;
    return { status: 204, body: "" };
  });
  Object.defineProperty(window, "__TAURI__", {
    configurable: true,
    value: { invoke },
  });
  useSyncStore.setState({
    provider: ProviderType.WebDAV,
    webdav: {
      endpoint: "https://dav.example",
      username: "test",
      password: "test",
    },
  });
  const syncing = useSyncStore.getState().sync();
  await started;
  useChatStore.getState().deleteSession(0);
  const deletedAt = useChatStore.getState().deletedSessions.remove;
  finishUpload();
  await syncing;
  expect(useChatStore.getState().sessions.some((s) => s.id === "remove")).toBe(
    false,
  );
  expect(useChatStore.getState().deletedSessions.remove).toBe(deletedAt);
  // The following sync publishes the deletion that occurred after the first snapshot.
  await useSyncStore.getState().sync();
  expect(JSON.parse(backup)[StoreKey.Chat].deletedSessions.remove).toBe(
    deletedAt,
  );
  expect(
    JSON.parse(backup)[StoreKey.Chat].sessions.some(
      (s: any) => s.id === "remove",
    ),
  ).toBe(false);
});

test("tombstone keys cannot alter object prototypes", () => {
  const tombstones = JSON.parse('{"__proto__": 200, "constructor": 200}');
  const result = mergeChat(
    chat([session("__proto__"), session("constructor"), session("keep")]),
    chat([], tombstones),
  );
  expect(result.sessions.map((s) => s.id)).toEqual(["keep"]);
  expect(
    Object.prototype.hasOwnProperty.call(result.deletedSessions, "__proto__"),
  ).toBe(true);
  expect(({} as any).polluted).toBeUndefined();
});
