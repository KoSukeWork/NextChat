import { jest } from "@jest/globals";
import { TextEncoder, TextDecoder } from "util";
jest.mocked(global.fetch).mockImplementation(
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
const { useSyncStore } = await import("../app/store/sync");
const { getLocalAppState, mergeAppState, mergeWithUpdate } = await import(
  "../app/utils/sync"
);
const { discoveredModels } = await import("../app/client/models");
const { StoreKey } = await import("../app/constant");
const { ProviderType } = await import("../app/utils/cloud");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test.each([true, false])(
  "newer %s local config wins; arrays replace and unique keys survive",
  (localNewer) => {
    const local = {
      lastUpdateTime: localNewer ? 20 : 10,
      models: [{ name: "A", local: true }],
      nested: { local: 1, shared: "local" },
      onlyLocal: true,
    };
    const remote = {
      lastUpdateTime: localNewer ? 10 : 20,
      models: [{ name: "X" }, { name: "Y" }],
      nested: { remote: 1, shared: "remote" },
      onlyRemote: true,
    };
    const result = mergeWithUpdate<any>(local, remote);
    expect(result.models).toEqual(localNewer ? local.models : remote.models);
    expect(result.nested).toEqual({
      local: 1,
      remote: 1,
      shared: localNewer ? "local" : "remote",
    });
    expect(result).toMatchObject({
      onlyLocal: true,
      onlyRemote: true,
      lastUpdateTime: 20,
    });
    expect(local.models).toEqual([{ name: "A", local: true }]);
    expect(remote.models).toEqual([{ name: "X" }, { name: "Y" }]);
  },
);
test("ties prefer local and missing timestamps count as zero", () => {
  expect(
    mergeWithUpdate(
      { models: [], lastUpdateTime: 5 },
      { models: [1], lastUpdateTime: 5 },
    ).models,
  ).toEqual([]);
  expect(
    mergeWithUpdate(
      { models: [], lastUpdateTime: undefined },
      { models: [1], lastUpdateTime: 1 },
    ).models,
  ).toEqual([1]);
});

test("Config/Access use newer state; chat/mask/prompt retain dedicated merges", () => {
  const local = clone(getLocalAppState()),
    remote = clone(local);
  local[StoreKey.Config].lastUpdateTime = 20;
  remote[StoreKey.Config].lastUpdateTime = 10;
  local[StoreKey.Config].models = [];
  remote[StoreKey.Config].models = discoveredModels(["old"], "OpenAI");
  local[StoreKey.Access].lastUpdateTime = 10;
  remote[StoreKey.Access].lastUpdateTime = 20;
  remote[StoreKey.Access].openaiUrl = "https://new.example";
  local[StoreKey.Prompt].prompts = { shared: { title: "local" } } as any;
  remote[StoreKey.Prompt].prompts = {
    shared: { title: "remote" },
    added: { title: "added" },
  } as any;
  local[StoreKey.Mask].masks = { shared: { name: "local" } } as any;
  remote[StoreKey.Mask].masks = {
    shared: { name: "remote" },
    added: { name: "added" },
  } as any;
  const session = clone(useChatStore.getState().currentSession());
  session.id = "remote-n";
  session.messages = [
    {
      id: "message-n",
      content: "remote message",
      date: "2026-10-29",
      role: "user",
    },
  ] as any;
  local[StoreKey.Chat].sessions = [];
  remote[StoreKey.Chat].sessions = [session];
  mergeAppState(local, remote);
  expect(local[StoreKey.Config].models).toEqual([]);
  expect(local[StoreKey.Access].openaiUrl).toBe("https://new.example");
  expect(local[StoreKey.Prompt].prompts.shared.title).toBe("local");
  expect(local[StoreKey.Prompt].prompts.added.title).toBe("added");
  expect(local[StoreKey.Mask].masks.shared.name).toBe("local");
  expect(local[StoreKey.Mask].masks.added.name).toBe("added");
  expect(local[StoreKey.Chat].sessions[0].messages[0].content).toBe(
    "remote message",
  );
});

test("delete saved models then sync twice never resurrects the older remote list", async () => {
  Object.assign(global, { TextEncoder, TextDecoder });
  const old = Object.getOwnPropertyDescriptor(window, "__TAURI__");
  const models = discoveredModels(["keep", "delete"], "OpenAI");
  useAppConfig.setState({ models, lastUpdateTime: Date.now() + 10000 });
  let backup = JSON.stringify(getLocalAppState());
  const remoteTime = useAppConfig.getState().lastUpdateTime;
  useAppConfig
    .getState()
    .removeSavedModels([JSON.stringify([models[1].provider.id, "delete"])]);
  expect(useAppConfig.getState().lastUpdateTime).toBeGreaterThan(remoteTime);
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
  try {
    await useSyncStore.getState().sync();
    await useSyncStore.getState().sync();
    expect(useAppConfig.getState().models.map((m) => m.name)).toEqual(["keep"]);
    expect(JSON.parse(backup)).not.toHaveProperty(StoreKey.Config);
    expect(JSON.parse(backup)).not.toHaveProperty(StoreKey.Access);
    expect(
      invoke.mock.calls.filter(([, a]) => a.request.method === "GET"),
    ).toHaveLength(2);
  } finally {
    if (old) Object.defineProperty(window, "__TAURI__", old);
    else Reflect.deleteProperty(window, "__TAURI__");
  }
});
