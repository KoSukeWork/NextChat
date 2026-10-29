import { jest } from "@jest/globals";

jest
  .mocked(global.fetch)
  .mockImplementation(
    async (input) =>
      ({
        json: async () =>
          String(input).includes("prompts.json")
            ? { en: [], cn: [], tw: [] }
            : [],
      }) as Response,
  );

test.each(["export", "standalone"])(
  "%s: repeated startup hydration repairs only desktop Access",
  async (buildMode) => {
    jest.resetModules();
    let persisted: string | null = null;
    jest.unstable_mockModule("@/app/config/client", () => ({
      getClientConfig: () => ({ buildMode, isApp: buildMode === "export" }),
    }));
    jest.unstable_mockModule("@/app/utils/indexedDB-storage", () => ({
      indexedDBStorage: {
        getItem: async (key: string) =>
          key === "access-control" ? persisted : null,
        setItem: async () => {},
        removeItem: async () => {},
        clear: async () => {},
      },
    }));
    await import("../app/client/api");
    const { useAccessStore } = await import("../app/store/access");
    await useAccessStore.persist.rehydrate();
    const initial = useAccessStore.getState();
    const urlKeys = Object.keys(initial).filter((key) => key.endsWith("Url"));
    const flags = [
      "needCode",
      "hideUserApiKey",
      "hideBalanceQuery",
      "disableGPT4",
      "disableFastLink",
      "customModels",
      "defaultModel",
      "visionModels",
    ] as const;
    const legacy: Record<string, unknown> = {
      ...Object.fromEntries(
        flags.map((key) => [
          key,
          typeof initial[key] === "boolean" ? !initial[key] : "remote-rule",
        ]),
      ),
      ...Object.fromEntries(urlKeys.map((key) => [key, "/api/" + key])),
      openaiApiKey: "",
      anthropicApiKey: "user-kept-test-key",
      anthropicUrl: "https://user.example:8443/custom/v1",
      googleUrl: "http://127.0.0.1:9999/v1",
      deepseekUrl: "ftp://invalid.example",
      xaiUrl: "https://",
      useCustomConfig: true,
    };
    for (let startup = 0; startup < 2; startup++) {
      // Same version each time: repair is not gated on a schema migration.
      persisted = JSON.stringify({ state: legacy, version: 3 });
      await useAccessStore.persist.rehydrate();
      const result = useAccessStore.getState();
      for (const key of flags)
        expect(result[key]).toBe(
          buildMode === "export" ? initial[key] : legacy[key],
        );
      for (const key of urlKeys) {
        const expected =
          ["anthropicUrl", "googleUrl"].includes(key) || buildMode !== "export"
            ? legacy[key]
            : (initial as any)[key];
        expect((result as any)[key]).toBe(expected);
      }
      expect(result.openaiApiKey).toBe("");
      expect(result.anthropicApiKey).toBe("user-kept-test-key");
      expect(result.useCustomConfig).toBe(true);
    }
  },
);
