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

test("restored executable request plugins require trust unless already installed identically", () => {
  const pkg = {
    manifest: {
      sdkVersion: 1 as const,
      id: "test.adapter",
      version: "1.0.0",
      name: "Test",
      description: "Test adapter",
      protocols: ["anthropic" as const],
      capabilities: ["request" as const],
      fields: {},
    },
    source: "export function prepareRequest(request) { return request; }",
    enabled: true,
  };
  const local = clone(getLocalAppState());
  local[StoreKey.Config].requestPlugins = [];
  const incoming = clone(local);
  incoming[StoreKey.Config].requestPlugins = [pkg];
  const restored = restoreBackup(local, incoming, { plugins: {} }, {});
  expect(restored.local[StoreKey.Config].requestPlugins[0].enabled).toBe(false);
  const trusted = clone(getLocalAppState());
  trusted[StoreKey.Config].requestPlugins = [pkg];
  const again = restoreBackup(trusted, incoming, { plugins: {} }, {});
  expect(again.local[StoreKey.Config].requestPlugins[0].enabled).toBe(true);
  const localOnly = { ...pkg, manifest: { ...pkg.manifest, id: "local.only" } };
  trusted[StoreKey.Config].requestPlugins = [localOnly, pkg];
  trusted[StoreKey.Config].endpoints = [
    {
      ...endpoint("local", "key"),
      requestPlugin: { id: "local.only", version: "1.0.0", config: {} },
    },
  ];
  const merged = restoreBackup(clone(trusted), incoming, { plugins: {} }, {});
  expect(
    merged.local[StoreKey.Config].requestPlugins.map(
      (entry) => entry.manifest.id,
    ),
  ).toEqual(["local.only", "test.adapter"]);
  expect(
    merged.local[StoreKey.Config].endpoints.some(
      (entry) => entry.requestPlugin?.id === "local.only",
    ),
  ).toBe(true);
  const empty = clone(incoming);
  empty[StoreKey.Config].requestPlugins = [];
  expect(
    restoreBackup(clone(trusted), empty, { plugins: {} }, {}).local[
      StoreKey.Config
    ].requestPlugins,
  ).toEqual(trusted[StoreKey.Config].requestPlugins);
  const conflicting = clone(incoming);
  conflicting[StoreKey.Config].requestPlugins[0].source += " // changed";
  expect(() =>
    restoreBackup(clone(trusted), conflicting, { plugins: {} }, {}),
  ).toThrow(/different contents/);
});

test("backup migration skips old Claude packages and preserves external connection and endpoint credentials", () => {
  const local = clone(getLocalAppState());
  local[StoreKey.Config].requestPlugins = [];
  local[StoreKey.Config].endpoints = [];
  const incoming = clone(local);
  incoming[StoreKey.Config].requestPlugins = [
    {
      manifest: {
        id: "nextchat.claude-code",
        version: "3.2.0-beta.1",
        capabilities: ["transport"],
      },
      source: "legacy",
      enabled: true,
    },
  ] as any;
  incoming[StoreKey.Config].endpoints = [
    {
      ...endpoint("legacy", "gateway-secret"),
      protocol: "anthropic",
      requestPlugin: {
        id: "nextchat.claude-code",
        version: "3.2.0-beta.1",
        config: {
          mode: "cli",
          bridgeUrl: "https://bridge.example",
          bridgeToken: "bridge-secret",
          nativeBeta: "beta-one",
        },
        localServices: { "claude-cli": "external" },
      },
    },
  ];
  const restored = restoreBackup(local, incoming, { plugins: {} }, {});
  expect(
    restored.local[StoreKey.Config].requestPlugins.map(
      (pkg) => pkg.manifest.version,
    ),
  ).toEqual(["4.0.0"]);
  expect(restored.local[StoreKey.Config].endpoints[0]).toMatchObject({
    apiKey: "gateway-secret",
    baseUrl: "https://example.test",
    requestPlugin: {
      version: "4.0.0",
      config: {
        connection: "external",
        bridgeUrl: "https://bridge.example",
        bridgeToken: "bridge-secret",
        nativeBeta: "beta-one",
      },
    },
  });
});

test("backup rejects a transport capability in any other plugin", () => {
  const local = clone(getLocalAppState());
  const incoming = clone(local);
  incoming[StoreKey.Config].requestPlugins = [
    {
      manifest: {
        id: "other.plugin",
        version: "1.0.0",
        capabilities: ["transport"],
      },
      source: "legacy",
      enabled: true,
    },
  ] as any;
  expect(() => restoreBackup(local, incoming, { plugins: {} }, {})).toThrow(
    /transport extensions are no longer supported/,
  );
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

test("local service ownership survives a backup round trip", () => {
  const local = clone(getLocalAppState());
  local[StoreKey.Config].endpoints = [
    {
      ...endpoint("managed", "key"),
      requestPlugin: {
        id: "test.adapter",
        version: "1.0.0",
        config: { mode: "cli" },
        localServices: { wire: "external", "claude-cli": "managed" },
      },
    },
  ];
  const backup = JSON.parse(
    JSON.stringify(
      createBackup(local, { plugins: {} }, {}, { mcpServers: {} }),
    ),
  );
  const restored = restoreBackup(
    clone(getLocalAppState()),
    backup,
    { plugins: {} },
    {},
  );
  expect(
    restored.local[StoreKey.Config].endpoints.find(
      (entry) => entry.id === "managed",
    )?.requestPlugin,
  ).toEqual(local[StoreKey.Config].endpoints[0].requestPlugin);
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
