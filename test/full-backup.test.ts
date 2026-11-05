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
await import("../app/client/api");
const { getLocalAppState } = await import("../app/utils/sync");
const { createBackup, restoreBackup, applyRestoredBackup } = await import(
  "../app/utils/backup"
);
const { StoreKey } = await import("../app/constant");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const endpoint = (id: string, apiKey: string) => ({
  id,
  name: id,
  protocol: "openai-chat" as const,
  baseUrl: "https://example.test",
  apiKey,
  models: [],
});
const plugin = (id: string, title: string) => ({
  id,
  title,
  createdAt: 1,
  version: "1",
  content: "{}",
  builtin: false,
});

test("full backup restores settings, endpoints, plugins, sync and MCP without using timestamps", async () => {
  const local = clone(getLocalAppState());
  local[StoreKey.Config].lastUpdateTime = 9999;
  local[StoreKey.Config].endpoints = [
    endpoint("same", "local-key"),
    endpoint("local", "local-only"),
  ];
  local[StoreKey.Config].fontSize = 15;
  local[StoreKey.Access].accessCode = "local-code";
  const incoming = clone(local);
  incoming[StoreKey.Config].lastUpdateTime = 1;
  incoming[StoreKey.Config].fontSize = 20;
  incoming[StoreKey.Config].endpoints = [
    endpoint("same", "backup-key"),
    endpoint("backup", "backup-only"),
  ];
  incoming[StoreKey.Access].lastUpdateTime = 1;
  incoming[StoreKey.Access].accessCode = "backup-code";
  const mcp = {
    mcpServers: {
      remote: {
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer backup-secret" },
      },
    },
  };
  const backup = createBackup(
    incoming,
    {
      plugins: {
        same: plugin("same", "backup"),
        backup: plugin("backup", "backup"),
      },
    },
    {
      provider: "webdav",
      webdav: {
        endpoint: "https://dav.test",
        username: "user",
        password: "password",
      },
      lastSyncTime: 111,
      lastProvider: "webdav",
      _hasHydrated: true,
    },
    mcp,
  );
  expect(backup[StoreKey.Mcp]).toEqual(mcp);
  expect(backup[StoreKey.Sync]).not.toHaveProperty("lastSyncTime");
  expect(backup[StoreKey.Sync]).not.toHaveProperty("lastProvider");

  const restored = restoreBackup(
    local,
    backup,
    {
      plugins: {
        same: plugin("same", "local"),
        local: plugin("local", "local"),
      },
    },
    {
      provider: "upstash",
      lastSyncTime: 222,
      lastProvider: "upstash",
      _hasHydrated: true,
    },
  );
  expect(restored.local[StoreKey.Config].fontSize).toBe(20);
  expect(
    restored.local[StoreKey.Config].endpoints.map((e) => [e.id, e.apiKey]),
  ).toEqual([
    ["same", "backup-key"],
    ["local", "local-only"],
    ["backup", "backup-only"],
  ]);
  expect(restored.local[StoreKey.Access].accessCode).toBe("backup-code");
  expect(restored.plugins.plugins.same.title).toBe("backup");
  expect(Object.keys(restored.plugins.plugins).sort()).toEqual([
    "backup",
    "local",
    "same",
  ]);
  expect(restored.sync.webdav.password).toBe("password");
  expect(restored.sync.lastSyncTime).toBe(222);
  expect(restored.sync.lastProvider).toBe("upstash");
  expect(restored.mcp).toEqual(mcp);

  const applyLocal = jest.fn();
  const result = await applyRestoredBackup(
    restored,
    async () => {
      throw new Error("not approved");
    },
    applyLocal,
  );
  expect(result.mcpSkipped).toBe(true);
  expect(applyLocal).toHaveBeenCalledWith(restored);
});

test("older backups without new fields remain importable and legacy API settings are ignored", () => {
  const local = clone(getLocalAppState());
  local[StoreKey.Config].endpoints = [endpoint("local", "keep")];
  local[StoreKey.Access].accessCode = "keep-code";
  const old = {
    [StoreKey.Config]: { models: [], lastUpdateTime: 100 },
    [StoreKey.Access]: { accessCode: "obsolete" },
  };
  const plugins = { plugins: { local: plugin("local", "keep") } };
  const sync = { provider: "webdav", lastSyncTime: 20 };
  const restored = restoreBackup(local, old, plugins, sync);
  expect(restored.legacyApiSettings).toBe(true);
  expect(restored.local[StoreKey.Config].endpoints[0].apiKey).toBe("keep");
  expect(restored.local[StoreKey.Access].accessCode).toBe("keep-code");
  expect(restored.plugins).toEqual(plugins);
  expect(restored.sync).toEqual(sync);
  expect(restored.mcp).toBeUndefined();
});
