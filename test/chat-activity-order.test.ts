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
const chatRequest = jest
  .spyOn(EndpointClient.prototype, "chat")
  .mockImplementation(async () => {});
const { useChatStore, useAppConfig, createMessage } = await import(
  "../app/store"
);
const { createEmptyMask } = await import("../app/store/mask");
const { useChatFolderUI } = await import("../app/store/chat-folder-ui");
const { orderedVisibleSessions } = await import("../app/utils/chat-order");
const { mergeCloudAppState } = await import("../app/utils/sync");
const { StoreKey } = await import("../app/constant");

const session = (
  id: string,
  lastUpdate: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  topic: id,
  memoryPrompt: "",
  lastUpdate,
  lastSummarizeIndex: 0,
  messages: [createMessage({ id: `${id}-m`, content: id })],
  stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
  mask: createEmptyMask(),
  ...extra,
});
const store = () => useChatStore.getState();
const shown = () =>
  orderedVisibleSessions(store().sessions).map(({ session }) => session.id);
const load = (sessions: any[], currentSessionIndex = 0) =>
  useChatStore.setState({
    sessions,
    currentSessionIndex,
    folders: [],
    deletedSessions: {},
    deletedFolders: {},
  });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(10_000);
  chatRequest.mockClear();
  toast.mockClear();
  useChatFolderUI.getState().selectFolder(null);
  useChatFolderUI.getState().setNarrow(false);
  useAppConfig.setState({
    endpoints: [
      {
        id: "home",
        name: "Home",
        protocol: "openai-chat",
        baseUrl: "https://example.test",
        apiKey: "",
        models: [{ name: "home-model" }],
      },
    ],
    enableAutoGenerateTitle: false,
    modelConfig: {
      ...useAppConfig.getState().modelConfig,
      model: "home-model",
      endpointId: "home",
    },
  });
});
afterEach(() => jest.useRealTimers());

test("message activity changes display order without reordering storage or reacting to chunks", async () => {
  load(
    [
      session("pin", 100, { pinned: true }),
      session("other", 200),
      session("old", 100),
    ],
    2,
  );
  expect(shown()).toEqual(["pin", "other", "old"]);
  await store().onUserInput("hello");
  expect(shown()).toEqual(["pin", "old", "other"]);
  expect(store().sessions.map((item) => item.id)).toEqual([
    "pin",
    "other",
    "old",
  ]);
  expect(store().currentSession().id).toBe("old");
  const request = chatRequest.mock.calls[0][0];
  const old = store().sessions[2];
  const sentAt = old.lastUpdate;
  store().updateTargetSession(store().sessions[1], (target) => {
    target.lastUpdate = 15_000;
  });
  expect(shown()).toEqual(["pin", "other", "old"]);
  jest.setSystemTime(20_000);
  request.onUpdate?.("partial", "partial", false);
  expect(old.lastUpdate).toBe(sentAt);
  expect(shown()).toEqual(["pin", "other", "old"]);
  await request.onFinish?.("complete", { status: 200 } as Response);
  expect(old.lastUpdate).toBeGreaterThan(sentAt);
  expect(shown()).toEqual(["pin", "old", "other"]);
  expect(store().currentSessionIndex).toBe(2);
});

test("ties preserve storage order, and settings, title, pin and folder edits do not update activity", () => {
  load([
    session("older", 10),
    session("first-tie", 20),
    session("second-tie", 20),
  ]);
  expect(shown()).toEqual(["first-tie", "second-tie", "older"]);
  const target = store().sessions[0];
  store().updateTargetSession(target, (item) => {
    item.topic = "renamed";
    item.messages[0].content = "edited message";
    item.mask.modelConfig.temperature = 0.1;
  });
  const folder = store().createFolder("Work").folder!;
  store().moveSessionToFolder(target.id, folder.id);
  store().togglePinSession(target.id);
  store().togglePinSession(target.id);
  expect(target.lastUpdate).toBe(10);
  expect(shown()).toEqual(["first-tie", "second-tie", "older"]);
  store().summarizeSession(true, target);
  const request = chatRequest.mock.calls.at(-1)![0];
  request.onFinish?.("Refreshed title", { status: 200 } as Response);
  expect(target.topic).toBe("Refreshed title");
  expect(target.lastUpdate).toBe(10);
  expect(shown()).toEqual(["first-tie", "second-tie", "older"]);
});

test("next, delete and archive choose neighbours in the current folder's display order", () => {
  const items = () => [
    session("old", 10, { folderId: "f" }),
    session("outside", 40),
    session("new", 100, { folderId: "f" }),
    session("current", 50, { folderId: "f" }),
  ];
  load(items(), 2);
  useChatStore.setState({
    folders: [{ id: "f", name: "Work", order: 0, updatedAt: 1 }],
  });
  useChatFolderUI.getState().selectFolder("f");
  store().nextSession(1);
  expect(store().currentSession().id).toBe("current");
  store().deleteSession(3);
  expect(store().currentSession().id).toBe("old");

  load(items(), 3);
  useChatStore.setState({
    folders: [{ id: "f", name: "Work", order: 0, updatedAt: 1 }],
  });
  useChatFolderUI.getState().selectFolder("f");
  store().archiveSession("current");
  expect(store().currentSession().id).toBe("old");
  const archived = store().sessions.find((item) => item.id === "current")!;
  expect(archived.lastUpdate).toBe(50);
  store().unarchiveSession("current");
  expect(archived.lastUpdate).toBeGreaterThan(100);
  expect(shown()[0]).toBe("current");
});

test("remote deletion chooses the neighbour from the prior visible order", () => {
  const local = [
    session("last", 10),
    session("first", 100),
    session("current", 50),
    session("next", 30),
  ];
  const result = mergeCloudAppState(
    {
      [StoreKey.Chat]: {
        sessions: local,
        currentSessionIndex: 2,
        deletedSessions: {},
      },
    } as any,
    {
      [StoreKey.Chat]: {
        sessions: [],
        currentSessionIndex: 0,
        deletedSessions: { current: 60 },
      },
    } as any,
  )[StoreKey.Chat];
  expect(result.sessions[result.currentSessionIndex].id).toBe("next");
});
