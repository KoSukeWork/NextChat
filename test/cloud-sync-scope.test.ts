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
jest.unstable_mockModule("@/app/components/ui-lib", () => ({
  showToast: jest.fn(),
}));
await import("../app/client/api");
const { useAppConfig, useAccessStore, useChatStore } = await import(
  "../app/store"
);
const { useSyncStore } = await import("../app/store/sync");
const { useMaskStore, createEmptyMask } = await import("../app/store/mask");
const { usePromptStore } = await import("../app/store/prompt");
const { getLocalAppState, mergeAppState, prepareImportedState } = await import(
  "../app/utils/sync"
);
const { StoreKey } = await import("../app/constant");
const { ProviderType } = await import("../app/utils/cloud");
const endpoint = (id: string) => ({
  id,
  name: id,
  protocol: "openai-chat" as const,
  baseUrl: `https://${id}.example`,
  apiKey: `${id}-secret`,
  models: [{ name: `${id}-model` }],
});
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const originalTauri = Object.getOwnPropertyDescriptor(window, "__TAURI__");
afterEach(() => {
  if (originalTauri) Object.defineProperty(window, "__TAURI__", originalTauri);
  else Reflect.deleteProperty(window, "__TAURI__");
});

test.each([ProviderType.WebDAV, ProviderType.UpStash])(
  "%s sync ignores old remote credentials/settings and uploads only content",
  async (provider) => {
    Object.assign(global, { TextEncoder, TextDecoder });
    useAppConfig.setState({
      endpoints: [endpoint("home")],
      modelConfig: {
        ...useAppConfig.getState().modelConfig,
        model: "home-model",
        endpointId: "home",
      },
      lastUpdateTime: 1,
    });
    useAccessStore.setState({
      accessCode: "home-code",
      lastUpdateTime: 1,
    });
    useChatStore.getState().newSession();
    const before = clone(getLocalAppState());
    const remote = clone(before);
    // Old or future clients must not bring MCP/local-only stores into sync.
    (remote as any)[StoreKey.Mcp] = {
      servers: { private: { command: "private-command" } },
    };
    remote[StoreKey.Access].accessCode = "office-code";
    remote[StoreKey.Access].lastUpdateTime = Date.now() + 1000;
    remote[StoreKey.Config].endpoints = [endpoint("office")];
    remote[StoreKey.Config].modelConfig.model = "office-model";
    remote[StoreKey.Config].lastUpdateTime = Date.now() + 1000;
    const session = clone(useChatStore.getState().currentSession());
    session.id = `office-${provider}`;
    session.messages = [
      {
        id: "message",
        role: "user",
        content: "office content",
        date: "2026-10-29",
      },
    ];
    remote[StoreKey.Chat].sessions = [session];
    remote[StoreKey.Mask].masks = {
      office: { ...createEmptyMask(), id: "office", name: "office mask" },
    };
    remote[StoreKey.Prompt].prompts = {
      office: { id: "office", title: "office prompt", content: "prompt" },
    } as any;
    let backup = JSON.stringify(remote);
    const redis = new Map<string, string>([
      ["backup-chunk-count", "1"],
      ["backup-chunk-0", backup],
    ]);
    const invoke = jest.fn(async (_command: string, args: any) => {
      const r = args.request;
      if (provider === ProviderType.WebDAV) {
        if (r.method === "MKCOL") return { status: 405, body: "" };
        if (r.method === "GET") return { status: 200, body: backup };
        backup = r.body;
        return { status: 204, body: "" };
      }
      const [action, key] = r.path.split("/");
      if (action === "set") redis.set(key, r.body);
      return {
        status: 200,
        body: JSON.stringify({
          result: action === "get" ? redis.get(key) ?? null : "OK",
        }),
      };
    });
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: { invoke },
    });
    useSyncStore.setState({
      provider,
      webdav: {
        endpoint: "https://dav.example",
        username: "backup",
        password: "test",
      },
      upstash: {
        endpoint: "https://redis.example",
        username: "backup",
        apiKey: "test",
      },
    });
    await useSyncStore.getState().sync();
    const uploaded = JSON.parse(
      provider === ProviderType.WebDAV ? backup : redis.get("backup-chunk-0")!,
    );
    expect(Object.keys(uploaded).sort()).toEqual(
      [StoreKey.Chat, StoreKey.Mask, StoreKey.Prompt].sort(),
    );
    const after = clone(getLocalAppState());
    expect(after[StoreKey.Config]).toEqual(before[StoreKey.Config]);
    expect(after[StoreKey.Access]).toEqual(before[StoreKey.Access]);
    expect(after[StoreKey.Chat].sessions.some((s) => s.id === session.id)).toBe(
      true,
    );
    expect(useMaskStore.getState().masks.office.name).toBe("office mask");
    expect(usePromptStore.getState().prompts.office.title).toBe(
      "office prompt",
    );
    // A second sync reads the new three-store format successfully.
    await useSyncStore.getState().sync();
    expect(clone(getLocalAppState())[StoreKey.Access]).toEqual(
      before[StoreKey.Access],
    );
  },
);

test("local export still downloads the complete five-store backup", async () => {
  const write = jest.fn(async () => {});
  Object.defineProperty(window, "__TAURI__", {
    configurable: true,
    value: {
      dialog: { save: async () => "backup.json" },
      fs: { writeTextFile: write },
    },
  });
  useSyncStore.getState().export();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const content = JSON.parse((write.mock.calls[0] as any)[1]);
  expect(Object.keys(content).sort()).toEqual(
    [
      StoreKey.Chat,
      StoreKey.Mask,
      StoreKey.Prompt,
      StoreKey.Config,
      StoreKey.Access,
    ].sort(),
  );
  expect(content[StoreKey.Config].endpoints).toEqual(
    useAppConfig.getState().endpoints,
  );
});

test("legacy import restores content while leaving endpoint and access settings intact", () => {
  const local = clone(getLocalAppState());
  local[StoreKey.Config].endpoints = [endpoint("home")];
  local[StoreKey.Access].accessCode = "local-code";
  const remote = clone(local);
  (remote as any)[StoreKey.Config] = {
    models: [{ name: "obsolete" }],
    lastUpdateTime: Date.now() + 1000,
  };
  (remote as any)[StoreKey.Access] = {
    openaiApiKey: "obsolete-secret",
    lastUpdateTime: Date.now() + 1000,
  };
  const importedSession = clone(useChatStore.getState().currentSession());
  importedSession.id = "legacy-import";
  importedSession.messages = [
    {
      id: "legacy-message",
      role: "user",
      content: "hello",
      date: "2026-10-29",
    },
  ];
  remote[StoreKey.Chat].sessions = [importedSession];
  remote[StoreKey.Mask].masks = {
    legacy: { ...createEmptyMask(), id: "legacy", name: "legacy mask" },
  };
  remote[StoreKey.Prompt].prompts = {
    legacy: { id: "legacy", title: "legacy prompt", content: "text" },
  } as any;
  const prepared = prepareImportedState(local, remote);
  expect(prepared.legacyApiSettings).toBe(true);
  mergeAppState(local, prepared.state, { restoreDeletedSessions: true });
  expect(local[StoreKey.Config].endpoints).toEqual([endpoint("home")]);
  expect(local[StoreKey.Access].accessCode).toBe("local-code");
  expect(
    local[StoreKey.Chat].sessions.some((item) => item.id === "legacy-import"),
  ).toBe(true);
  expect(local[StoreKey.Mask].masks.legacy.name).toBe("legacy mask");
  expect(local[StoreKey.Prompt].prompts.legacy.title).toBe("legacy prompt");
});
