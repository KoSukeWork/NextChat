import { migrateTTSConfig, speechValue } from "../app/utils/local-tts";

let configStore: typeof import("../app/store/config").useAppConfig;
let accessStore: typeof import("../app/store/access").useAccessStore;
beforeAll(async () => {
  await import("../app/client/api");
  configStore = (await import("../app/store/config")).useAppConfig;
  accessStore = (await import("../app/store/access")).useAccessStore;
});

test("local speech controls clamp to 0.5–2 with safe invalid defaults", () => {
  expect([0.1, 4, 1.5, NaN, Infinity, undefined].map(speechValue)).toEqual([
    0.5, 2, 1.5, 1, 1, 1,
  ]);
});

test("legacy settings migrate without retaining cloud engine/model/voice/speed", async () => {
  const legacy = {
    enable: true,
    autoplay: true,
    engine: "Edge-TTS",
    model: "tts-1",
    voice: "alloy",
    speed: 1.7,
  };
  expect(migrateTTSConfig(legacy)).toEqual({
    enable: true,
    autoplay: true,
    voiceURI: "",
    rate: 1.7,
    pitch: 1,
  });
  const options = configStore.persist.getOptions();
  const realtimeConfig = configStore.getState().realtimeConfig;
  const migrated = await options.migrate!(
    { ttsConfig: legacy, realtimeConfig },
    4.2,
  );
  expect((migrated as any).ttsConfig).toEqual(migrateTTSConfig(legacy));
  expect((migrated as any).realtimeConfig).toBe(realtimeConfig);
  expect(
    options.merge!({ ttsConfig: legacy }, configStore.getState()).ttsConfig,
  ).toEqual(migrateTTSConfig(legacy));
  expect(migrateTTSConfig(undefined)).toEqual({
    enable: false,
    autoplay: false,
    voiceURI: "",
    rate: 1,
    pitch: 1,
  });
  expect(
    migrateTTSConfig({ voiceURI: "installed", rate: 1.2, pitch: 0.8 }),
  ).toMatchObject({ voiceURI: "installed", rate: 1.2, pitch: 0.8 });
});

test("access migration and merge discard obsolete Edge settings without affecting credentials", async () => {
  const options = accessStore.persist.getOptions();
  const legacy = {
    edgeTTSVoiceName: "remote",
    edgeVoiceName: "obsolete",
    openaiApiKey: "test-only",
  };
  const migrated = await options.migrate!(legacy, 2);
  expect(migrated).toEqual({ openaiApiKey: "test-only" });
  const merged = options.merge!(legacy, accessStore.getState());
  expect(merged).not.toHaveProperty("edgeTTSVoiceName");
  expect(merged).not.toHaveProperty("edgeVoiceName");
  expect(merged.openaiApiKey).toBe("test-only");
});
