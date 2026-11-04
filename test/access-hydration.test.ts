import { jest } from "@jest/globals";

const values = new Map<string, string>();
let failWrites = false;
jest.unstable_mockModule("@/app/utils/indexedDB-storage", () => ({
  indexedDBStorage: {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (failWrites) throw new Error("storage full");
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  },
}));
const { useAccessStore } = await import("../app/store/access");
const { useAppConfig } = await import("../app/store/config");
const { LEGACY_ACCESS_BACKUP, LEGACY_CONFIG_BACKUP } = await import(
  "../app/utils/legacy-endpoint-migration"
);

beforeEach(() => {
  values.clear();
  failWrites = false;
});

test("access migration preserves the old credentials before retaining the access code", async () => {
  const old = {
    accessCode: "site-code",
    needCode: true,
    openaiApiKey: "user-key",
    openaiUrl: "https://example.test",
  };
  const result = await useAccessStore.persist.getOptions().migrate!(old, 3);
  expect(result).toMatchObject({ accessCode: "site-code" });
  expect(result).not.toHaveProperty("openaiApiKey");
  expect(JSON.parse(values.get(LEGACY_ACCESS_BACKUP)!).state).toMatchObject(
    old,
  );
  expect(old.openaiApiKey).toBe("user-key");
});

test("a failed backup aborts migration rather than losing credentials", async () => {
  const old = { accessCode: "site-code", openaiApiKey: "user-key" };
  failWrites = true;
  await expect(
    useAccessStore.persist.getOptions().migrate!(old, 3),
  ).rejects.toThrow("storage full");
  expect(old).toEqual({ accessCode: "site-code", openaiApiKey: "user-key" });
});

test("failed config hydration does not overwrite the old persisted snapshot", async () => {
  const old = {
    state: {
      modelConfig: { model: "saved", providerName: "OpenAI" },
      models: [{ name: "saved" }],
      _hasHydrated: true,
    },
    version: 4.4,
  };
  values.set("app-config", JSON.stringify(old));
  failWrites = true;
  await useAppConfig.persist.rehydrate();
  expect(JSON.parse(values.get("app-config")!)).toEqual(old);
  expect(values.has(LEGACY_CONFIG_BACKUP)).toBe(false);
});
