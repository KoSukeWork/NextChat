import {
  migrateClaudeConfiguration,
  isLegacyClaudePlugin,
} from "../app/request-plugins/claude-migration";

const endpoint = (
  id: string,
  version: string,
  config: Record<string, string>,
  localServices?: Record<string, "managed" | "external">,
) => ({
  id,
  name: id,
  protocol: "anthropic" as const,
  baseUrl: "https://gateway.example",
  apiKey: `secret-${id}`,
  models: [{ name: "model" }],
  requestPlugin: {
    id: "nextchat.claude-code",
    version,
    config,
    ...(localServices ? { localServices } : {}),
  },
});
const pkg = (version: string, enabled = true, defaultMode = "http") =>
  ({
    manifest: {
      id: "nextchat.claude-code",
      version,
      fields: { mode: { default: defaultMode } },
    },
    source: "old",
    enabled,
  }) as any;

test("migrates built-in, external, removed HTTP and v1 bindings without changing endpoints", () => {
  const endpoints = [
    endpoint(
      "builtin",
      "3.2.0-beta.1",
      {
        mode: "cli",
        nativeBeta: "beta-one",
        bridgeUrl: "http://127.0.0.1:50000",
        bridgeToken: "a".repeat(64),
      },
      { "claude-cli": "managed" },
    ),
    endpoint(
      "external",
      "3.2.0-beta.1",
      {
        mode: "cli",
        nativeCliVersion: "2.2.1",
        bridgeUrl: "https://bridge.example",
        bridgeToken: "external-token-123456",
        nativeEffort: "high",
      },
      { "claude-cli": "external" },
    ),
    endpoint("http", "3.2.0-beta.1", {
      mode: "http",
      transportToken: "discard",
      transportUrl: "http://127.0.0.1:8789",
    }),
    endpoint("v1", "1.0.0", {
      mode: "cli",
      cliVersion: "2.1.9",
      bridgeUrl: "https://old.example",
      bridgeToken: "old-external-token",
    }),
    {
      id: "plain",
      name: "plain",
      protocol: "anthropic" as const,
      baseUrl: "https://plain.example",
      apiKey: "plain-secret",
      models: [],
    },
  ];
  const unrelated = {
    manifest: { id: "example.plugin", version: "1.0.0" },
    source: "untouched",
    enabled: true,
  } as any;
  const result = migrateClaudeConfiguration(endpoints, [
    pkg("3.2.0-beta.1"),
    pkg("1.0.0", true, "cli"),
    unrelated,
  ]);
  expect(result.endpoints[0].requestPlugin).toMatchObject({
    version: "4.0.0",
    config: { connection: "builtin", nativeBeta: "beta-one" },
  });
  expect(result.endpoints[0].requestPlugin!.config.bridgeToken).toBeUndefined();
  expect(result.endpoints[1].requestPlugin).toMatchObject({
    version: "4.0.0",
    config: {
      connection: "external",
      bridgeUrl: "https://bridge.example",
      bridgeToken: "external-token-123456",
      nativeEffort: "high",
    },
  });
  expect(result.endpoints[2].requestPlugin).toMatchObject({
    version: "4.0.0",
    migrationNotice: "http-removed",
    config: { connection: "builtin" },
  });
  expect(
    result.endpoints[2].requestPlugin!.config.transportToken,
  ).toBeUndefined();
  expect(result.endpoints[3].requestPlugin).toMatchObject({
    version: "4.0.0",
    config: { connection: "external", nativeCliVersion: "2.1.9" },
  });
  expect(result.endpoints[4]).toEqual(endpoints[4]);
  expect(
    result.endpoints.map(({ baseUrl, apiKey, models }) => ({
      baseUrl,
      apiKey,
      models,
    })),
  ).toEqual(
    endpoints.map(({ baseUrl, apiKey, models }) => ({
      baseUrl,
      apiKey,
      models,
    })),
  );
  expect(result.packages).toContain(unrelated);
  expect(
    result.packages.some(
      (item) =>
        item.manifest.id === "nextchat.claude-code" &&
        item.manifest.version === "4.0.0" &&
        item.enabled,
    ),
  ).toBe(true);
  expect(
    result.packages.some((item) =>
      isLegacyClaudePlugin(item.manifest.id, item.manifest.version),
    ),
  ).toBe(false);
  expect(migrateClaudeConfiguration(result.endpoints, result.packages)).toEqual(
    result,
  );
});

test("disabled old packages do not become enabled during migration", () => {
  const result = migrateClaudeConfiguration(
    [endpoint("one", "2.0.0", {})],
    [pkg("2.0.0", false)],
  );
  expect(
    result.packages.find((item) => item.manifest.id === "nextchat.claude-code")
      ?.enabled,
  ).toBe(false);
});
