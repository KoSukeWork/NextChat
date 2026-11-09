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
const { useChatStore, createEmptySession, createMessage } = await import(
  "../app/store"
);
const { useChatFolderUI } = await import("../app/store/chat-folder-ui");
const { sessionFolder } = await import("../app/utils/chat-folders");
const { sessionModifiedAt } = await import("../app/utils/chat-deletion");
const { getLocalAppState, mergeCloudAppState } = await import(
  "../app/utils/sync"
);
const { createBackup, restoreBackup } = await import("../app/utils/backup");
const { StoreKey } = await import("../app/constant");

const make = (
  id: string,
  folderId?: string,
  extra: Record<string, unknown> = {},
) => ({
  ...createEmptySession(),
  id,
  topic: id,
  folderId,
  lastUpdate: 10,
  messages: [createMessage({ id: `${id}-m`, content: id })],
  ...extra,
});
const folder = (id: string, name: string, order = 0, updatedAt = 10) => ({
  id,
  name,
  order,
  updatedAt,
});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const state = () => useChatStore.getState();

beforeEach(() => {
  useChatFolderUI.getState().selectFolder(null);
  useChatFolderUI.getState().setNarrow(false);
  useChatStore.setState({
    sessions: [make("a"), make("b"), make("c")],
    currentSessionIndex: 0,
    folders: [],
    deletedFolders: {},
    deletedSessions: {},
    _hasHydrated: true,
  });
  toast.mockClear();
});

test("create, rename, reorder and move preserve conversation times and order", () => {
  expect(state().createFolder("   ").error).toBe("empty");
  const work = state().createFolder(" Work ").folder!;
  const study = state().createFolder("Study").folder!;
  expect(work.name).toBe("Work");
  expect(state().createFolder("work").error).toBe("duplicate");
  expect(state().renameFolder(study.id, " WORK ").error).toBe("duplicate");
  expect(state().renameFolder(study.id, "Learning").folder?.name).toBe(
    "Learning",
  );
  state().reorderFolders(1, 0);
  expect(state().folders.map((item) => item.name)).toEqual([
    "Learning",
    "Work",
  ]);
  expect(state().moveSessionToFolder("b", work.id)).toBe(true);
  expect(state().moveSessionToFolder("b", "missing")).toBe(false);
  expect(state().sessions.map((item) => item.id)).toEqual(["a", "b", "c"]);
  expect(state().sessions.map((item) => item.lastUpdate)).toEqual([10, 10, 10]);
  expect(state().sessions[1].folderId).toBe(work.id);
  expect(state().sessions[1].folderUpdatedAt).toBeGreaterThan(0);
});

test("new chats follow the selected tab; narrow and all create ungrouped", () => {
  const work = state().createFolder("Work").folder!;
  useChatFolderUI.getState().selectFolder(work.id);
  state().newSession();
  expect(state().currentSession().folderId).toBe(work.id);
  state().forkSession();
  expect(state().currentSession().folderId).toBe(work.id);
  useChatFolderUI.getState().setNarrow(true);
  state().newSession();
  expect(state().currentSession().folderId).toBeUndefined();
  useChatFolderUI.getState().setNarrow(false);
  useChatFolderUI.getState().selectFolder(null);
  state().newSession();
  expect(state().currentSession().folderId).toBeUndefined();
});

test("next and previous cycle through the selected folder in global pin order", () => {
  useChatStore.setState({
    folders: [folder("f", "Work")],
    sessions: [
      make("a", "f"),
      make("other"),
      make("pin", "f", { pinned: true }),
      make("archived", "f", { archived: true }),
      make("b", "f"),
    ],
    currentSessionIndex: 0,
  });
  useChatFolderUI.getState().selectFolder("f");
  state().nextSession(1);
  expect(state().currentSession().id).toBe("b");
  state().nextSession(1);
  expect(state().currentSession().id).toBe("pin");
  state().nextSession(-1);
  expect(state().currentSession().id).toBe("b");
});

test("deleting only a folder ungroupes archived and visible chats without changing their time or order", () => {
  useChatStore.setState({
    folders: [folder("f", "Work")],
    sessions: [make("a", "f"), make("b", "f", { archived: true }), make("c")],
  });
  useChatFolderUI.getState().selectFolder("f");
  state().deleteFolder("f", false);
  expect(
    state().sessions.map((item) => [item.id, item.lastUpdate, item.folderId]),
  ).toEqual([
    ["a", 10, undefined],
    ["b", 10, undefined],
    ["c", 10, undefined],
  ]);
  expect(state().sessions[1].archived).toBe(true);
  expect(state().sessions[0].folderUpdatedAt).toBeGreaterThan(0);
  expect(state().deletedFolders.f).toBeGreaterThan(10);
  expect(useChatFolderUI.getState().selectedFolderId).toBeNull();
});

test("one undo restores a deleted folder, its chats, selection, order and clocks", () => {
  useChatStore.setState({
    folders: [folder("f", "Work")],
    sessions: [
      make("before"),
      make("current", "f"),
      make("archived", "f", { archived: true }),
      make("empty", "f", { messages: [], folderUpdatedAt: 25 }),
      make("other"),
    ],
    currentSessionIndex: 1,
  });
  useChatFolderUI.getState().selectFolder("f");
  state().deleteFolder("f", true);
  expect(state().sessions.map((item) => item.id)).toEqual(["before", "other"]);
  expect(state().currentSession().id).toBe("other");
  const folderDeletedAt = state().deletedFolders.f;
  const deleted = clone(state().deletedSessions);
  expect(deleted.current).toBeGreaterThan(0);
  expect(deleted.archived).toBeGreaterThan(0);
  expect(deleted.empty).toBeUndefined();
  expect(toast).toHaveBeenCalledTimes(1);
  const deletionSnapshot = cloud(clone(state().sessions), [], {
    f: folderDeletedAt,
  });
  deletionSnapshot[StoreKey.Chat].deletedSessions = deleted;
  (toast.mock.calls[0] as any)[1].onClick();
  expect(state().sessions.map((item) => item.id)).toEqual([
    "before",
    "current",
    "archived",
    "empty",
    "other",
  ]);
  expect(state().currentSession().id).toBe("current");
  expect(useChatFolderUI.getState().selectedFolderId).toBe("f");
  expect(state().folders[0].updatedAt).toBeGreaterThan(folderDeletedAt);
  expect(state().deletedFolders.f).toBeUndefined();
  expect(state().deletedSessions.current).toBeUndefined();
  expect(state().deletedSessions.archived).toBeUndefined();
  expect(state().sessions[2]).toMatchObject({ folderId: "f", archived: true });
  expect(state().sessions[3].folderId).toBe("f");
  expect(state().sessions[1].lastUpdate).toBeGreaterThan(deleted.current);
  expect(state().sessions[2].lastUpdate).toBeGreaterThan(deleted.archived);
  const restored = cloud(clone(state().sessions), clone(state().folders));
  const merged = mergeCloudAppState(restored, deletionSnapshot)[StoreKey.Chat];
  expect(merged.folders.some((item) => item.id === "f")).toBe(true);
  expect(merged.sessions.some((item) => item.id === "current")).toBe(true);
  expect(merged.deletedFolders.f).toBeUndefined();
  expect(merged.deletedSessions.current).toBeUndefined();
});

test("folder undo preserves intervening edits, new chats and user selection", () => {
  useChatStore.setState({
    folders: [folder("f", "Work"), folder("g", "Other", 1)],
    sessions: [
      make("a", "f"),
      make("b", "f", { archived: true }),
      make("outside"),
    ],
    currentSessionIndex: 0,
  });
  useChatFolderUI.getState().selectFolder("f");
  state().deleteFolder("f", true);
  const folderTime = state().deletedFolders.f;
  const chatTime = state().deletedSessions.a;
  useChatStore.setState((old) => ({
    sessions: [
      ...old.sessions,
      make("a", "g", { topic: "edited" }),
      make("new"),
    ],
    folders: [...old.folders, folder("new-folder", "Work", 2)],
    deletedSessions: {
      ...old.deletedSessions,
      a: chatTime + 10,
      unrelated: 22,
    },
    deletedFolders: { ...old.deletedFolders, f: folderTime + 10 },
    currentSessionIndex: old.sessions.length + 1,
  }));
  useChatFolderUI.getState().selectFolder("g");
  (toast.mock.calls[0] as any)[1].onClick();
  const current = state();
  expect(current.currentSession().id).toBe("new");
  expect(useChatFolderUI.getState().selectedFolderId).toBe("g");
  expect(current.sessions.find((item) => item.id === "a")).toMatchObject({
    topic: "edited",
    folderId: "g",
  });
  expect(
    current.sessions.find((item) => item.id === "a")!.lastUpdate,
  ).toBeGreaterThan(chatTime + 10);
  expect(current.sessions.find((item) => item.id === "b")?.archived).toBe(true);
  expect(current.folders.find((item) => item.id === "f")).toMatchObject({
    name: "Work (2)",
  });
  expect(
    current.folders.find((item) => item.id === "f")!.updatedAt,
  ).toBeGreaterThan(folderTime + 10);
  expect(current.deletedSessions.unrelated).toBe(22);
});

test("folder undo removes only an untouched generated placeholder", () => {
  useChatStore.setState({
    folders: [folder("f", "Work")],
    sessions: [make("a", "f")],
    currentSessionIndex: 0,
  });
  state().deleteFolder("f", true);
  const placeholder = state().currentSession().id;
  (toast.mock.calls[0] as any)[1].onClick();
  expect(state().sessions.map((item) => item.id)).toEqual(["a"]);
  state().deleteFolder("f", true);
  const nextPlaceholder = state().currentSession().id;
  useChatStore.setState((old) => ({
    sessions: old.sessions.map((item) =>
      item.id === nextPlaceholder ? { ...item, topic: "new draft" } : item,
    ),
  }));
  (toast.mock.calls[1] as any)[1].onClick();
  expect(
    state().sessions.find((item) => item.id === nextPlaceholder)?.topic,
  ).toBe("new draft");
  expect(state().currentSession().id).toBe(nextPlaceholder);
  expect(placeholder).not.toBe(nextPlaceholder);
});

test("undo respects an explicit choice of the All tab after automatic fallback", () => {
  useChatStore.setState({
    folders: [folder("f", "Work")],
    sessions: [make("a", "f"), make("other")],
    currentSessionIndex: 0,
  });
  useChatFolderUI.getState().selectFolder("f");
  state().deleteFolder("f", true);
  useChatFolderUI.getState().selectFolder(null);
  (toast.mock.calls[0] as any)[1].onClick();
  expect(useChatFolderUI.getState().selectedFolderId).toBeNull();
});

test("folder updates participate in session deletion clocks", () => {
  const future = Date.now() + 60_000;
  const chat = make("a", undefined, { folderUpdatedAt: future });
  expect(sessionModifiedAt(chat)).toBe(future);
  useChatStore.setState({
    sessions: [chat, make("b")],
    currentSessionIndex: 0,
  });
  state().deleteSession(0);
  expect(state().deletedSessions.a).toBeGreaterThan(future);
});

test("grouped empty chats do not sync or get tombstones; messages enable sync", () => {
  const blank = make("organized-empty", "f", {
    messages: [],
    folderUpdatedAt: 25,
  });
  const local = cloud([make("other")], [folder("f", "Work")]);
  const remote = cloud([blank], [folder("f", "Work")]);
  const synced = mergeCloudAppState(local, remote)[StoreKey.Chat];
  expect(
    synced.sessions.find((item) => item.id === "organized-empty"),
  ).toBeUndefined();
  const withMessage = {
    ...blank,
    messages: [createMessage({ content: "hello" })],
  };
  const incoming = mergeCloudAppState(
    cloud([make("other")], [folder("f", "Work")]),
    cloud([withMessage], [folder("f", "Work")]),
  )[StoreKey.Chat];
  expect(
    incoming.sessions.find((item) => item.id === "organized-empty")?.folderId,
  ).toBe("f");
  useChatStore.setState({
    sessions: [blank, make("other")],
    currentSessionIndex: 0,
    folders: [folder("f", "Work")],
  });
  state().deleteSession(0);
  expect(state().deletedSessions["organized-empty"]).toBeUndefined();
});

function cloud(
  sessions: any[],
  folders: any[],
  deletedFolders: Record<string, number> = {},
) {
  return {
    [StoreKey.Chat]: {
      ...clone(getLocalAppState()[StoreKey.Chat]),
      sessions,
      folders,
      deletedFolders,
      deletedSessions: {},
      currentSessionIndex: 0,
    },
  } as any;
}

test("sync merges folder records, deletion clocks and membership independently", () => {
  const local = cloud(
    [make("same", "old", { folderUpdatedAt: 10, lastUpdate: 80 })],
    [folder("old", "Old", 0, 10), folder("gone", "Gone", 1, 10)],
  );
  const remote = cloud(
    [
      make("same", "gone", { folderUpdatedAt: 30, lastUpdate: 70 }),
      make("new", "old", { lastUpdate: 100 }),
    ],
    [folder("old", "Renamed", 2, 20)],
    { gone: 20 },
  );
  const merged = mergeCloudAppState(local, remote)[StoreKey.Chat];
  expect(merged.folders.map((item) => item.name)).toEqual(["Renamed"]);
  expect(merged.deletedFolders.gone).toBe(20);
  const same = merged.sessions.find((item) => item.id === "same")!;
  expect(same.folderId).toBe("gone");
  expect(same.folderUpdatedAt).toBe(30);
  expect(sessionFolder(same, merged.folders)).toBeUndefined();
  expect(merged.sessions.map((item) => [item.id, item.lastUpdate])).toEqual([
    ["new", 100],
    ["same", 80],
  ]);
});

test("sync resolves equal names from independent folders deterministically and accepts old data", () => {
  const a = cloud(
    [make("same")],
    [folder("a", "Work", 0, 10), folder("x", "Work (2)", 3, 10)],
  );
  const b = cloud(
    [make("same")],
    [folder("b", "work", 1, 10), folder("c", "Work", 2, 10)],
  );
  const ab = mergeCloudAppState(clone(a), clone(b))[StoreKey.Chat];
  const ba = mergeCloudAppState(clone(b), clone(a))[StoreKey.Chat];
  expect(ab.folders).toEqual(ba.folders);
  expect(ab.folders.map((item) => item.name)).toEqual([
    "Work",
    "work (3)",
    "Work (4)",
    "Work (2)",
  ]);
  const afterDelete = cloud(
    [make("same")],
    ab.folders.filter((item) => item.id !== "a"),
    { a: 30 },
  );
  const synced = mergeCloudAppState(clone(b), afterDelete)[StoreKey.Chat];
  expect(synced.folders).toEqual(afterDelete[StoreKey.Chat].folders);
  const old = cloud([make("old")], []);
  delete old[StoreKey.Chat].folders;
  delete old[StoreKey.Chat].deletedFolders;
  expect(
    mergeCloudAppState(old, cloud([make("new")], []))[StoreKey.Chat].folders,
  ).toEqual([]);
});

test("deletion received from another device resets the local tab without syncing it", () => {
  useChatStore.setState({ folders: [folder("f", "Work")] });
  useChatFolderUI.getState().selectFolder("f");
  const local = cloud([make("a", "f")], [folder("f", "Work")]);
  const remote = cloud([make("a", "f")], [], { f: 20 });
  const result = mergeCloudAppState(local, remote)[StoreKey.Chat];
  useChatStore.setState(result);
  expect(useChatFolderUI.getState().selectedFolderId).toBeNull();
  expect(result).not.toHaveProperty("selectedFolderId");
  expect(sessionFolder(result.sessions[0], result.folders)).toBeUndefined();
});

test("backup export and restore preserve folders and chat membership", () => {
  const source = clone(getLocalAppState());
  source[StoreKey.Chat].folders = [folder("f", "Work")];
  source[StoreKey.Chat].sessions = [
    make("backed", "f", { folderUpdatedAt: 20 }),
    make("empty-backup", "f", { folderUpdatedAt: 20, messages: [] }),
  ];
  const backup = clone(createBackup(source, { plugins: {} }, {}));
  expect(backup[StoreKey.Chat]?.folders[0].name).toBe("Work");
  const destination = clone(getLocalAppState());
  destination[StoreKey.Chat].folders = [];
  destination[StoreKey.Chat].sessions = [make("other")];
  const restored = restoreBackup(destination, backup, { plugins: {} }, {});
  expect(restored.local[StoreKey.Chat].folders[0].id).toBe("f");
  expect(
    restored.local[StoreKey.Chat].sessions.find((item) => item.id === "backed")
      ?.folderId,
  ).toBe("f");
  expect(
    restored.local[StoreKey.Chat].sessions.find(
      (item) => item.id === "empty-backup",
    )?.folderId,
  ).toBe("f");
});
