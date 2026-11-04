import { getClientConfig } from "../config/client";
import {
  DEFAULT_INPUT_TEMPLATE,
  DEFAULT_SIDEBAR_WIDTH,
  StoreKey,
} from "../constant";
import { createPersistStore } from "../utils/store";
import { normalizeZoom } from "../utils/zoom";
import {
  DEFAULT_LOCAL_TTS,
  migrateTTSConfig,
  speechValue,
} from "../utils/local-tts";
import type { Endpoint } from "../utils/endpoints";
import { indexedDBStorage } from "../utils/indexedDB-storage";
import {
  LEGACY_ACCESS_BACKUP,
  LEGACY_CONFIG_BACKUP,
  migrateLegacyConfig,
} from "../utils/legacy-endpoint-migration";

export type ModelType = string;

export enum SubmitKey {
  Enter = "Enter",
  CtrlEnter = "Ctrl + Enter",
  ShiftEnter = "Shift + Enter",
  AltEnter = "Alt + Enter",
  MetaEnter = "Meta + Enter",
}

export enum Theme {
  Auto = "auto",
  Dark = "dark",
  Light = "light",
}

const config = getClientConfig();

export const DEFAULT_CONFIG = {
  lastUpdate: Date.now(), // timestamp, to merge state

  submitKey: SubmitKey.Enter,
  avatar: "1f603",
  fontSize: 14,
  zoom: 1,
  fontFamily: "",
  theme: Theme.Auto as Theme,
  tightBorder: !!config?.isApp,
  sendPreviewBubble: true,
  enableAutoGenerateTitle: true,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,

  enableArtifacts: true, // show artifacts config

  enableCodeFold: true, // code fold config

  disablePromptHint: false,

  dontShowMaskSplashScreen: false, // dont show splash screen when create chat
  hideBuiltinMasks: false, // dont add builtin masks

  endpoints: [] as Endpoint[],
  unmigratedEndpoints: [] as string[],

  modelConfig: {
    model: "" as ModelType,
    endpointId: "",
    temperature: 0.5,
    top_p: 1,
    max_tokens: 4000,
    presence_penalty: 0,
    frequency_penalty: 0,
    sendMemory: true,
    historyMessageCount: 4,
    compressMessageLengthThreshold: 1000,
    compressModel: "",
    compressEndpointId: "",
    enableInjectSystemPrompts: true,
    template: config?.template ?? DEFAULT_INPUT_TEMPLATE,
  },

  ttsConfig: { ...DEFAULT_LOCAL_TTS },
};

export type ChatConfig = typeof DEFAULT_CONFIG;

export type ModelConfig = ChatConfig["modelConfig"];
export type TTSConfig = ChatConfig["ttsConfig"];

export function limitNumber(
  x: number,
  min: number,
  max: number,
  defaultValue: number,
) {
  if (isNaN(x)) {
    return defaultValue;
  }

  return Math.min(max, Math.max(min, x));
}

export const TTSConfigValidator = { rate: speechValue, pitch: speechValue };

export const ModalConfigValidator = {
  model(x: string) {
    return x as ModelType;
  },
  max_tokens(x: number) {
    return limitNumber(x, 0, 512000, 1024);
  },
  presence_penalty(x: number) {
    return limitNumber(x, -2, 2, 0);
  },
  frequency_penalty(x: number) {
    return limitNumber(x, -2, 2, 0);
  },
  temperature(x: number) {
    return limitNumber(x, 0, 2, 1);
  },
  top_p(x: number) {
    return limitNumber(x, 0, 1, 1);
  },
};

export const useAppConfig = createPersistStore(
  { ...DEFAULT_CONFIG },
  (set) => ({
    reset() {
      set(() => ({ ...DEFAULT_CONFIG }));
    },
  }),
  {
    name: StoreKey.Config,
    version: 4.5,

    merge(persistedState, currentState) {
      const state = persistedState as ChatConfig | undefined;
      if (!state) return { ...currentState };
      return {
        ...currentState,
        ...state,
        endpoints: state.endpoints ?? [],
        unmigratedEndpoints: state.unmigratedEndpoints ?? [],
        modelConfig: { ...currentState.modelConfig, ...state.modelConfig },
        zoom: normalizeZoom(state.zoom),
        ttsConfig: migrateTTSConfig(state.ttsConfig),
      };
    },

    async migrate(persistedState, version) {
      // Migration works on a copy, preserving the exact old state on failure.
      let state = JSON.parse(JSON.stringify(persistedState ?? {}));
      if (
        version < 4.5 &&
        !(await indexedDBStorage.getItem(LEGACY_CONFIG_BACKUP))
      ) {
        await indexedDBStorage.setItem(
          LEGACY_CONFIG_BACKUP,
          JSON.stringify({ state: { ...state, _hasHydrated: true }, version }),
        );
        if (!(await indexedDBStorage.getItem(LEGACY_CONFIG_BACKUP)))
          throw new Error("Could not preserve old configuration");
      }
      state.modelConfig ??= {};

      if (version < 3.4) {
        state.modelConfig.sendMemory = true;
        state.modelConfig.historyMessageCount = 4;
        state.modelConfig.compressMessageLengthThreshold = 1000;
        state.modelConfig.frequency_penalty = 0;
        state.modelConfig.top_p = 1;
        state.modelConfig.template = DEFAULT_INPUT_TEMPLATE;
        state.dontShowMaskSplashScreen = false;
        state.hideBuiltinMasks = false;
      }

      if (version < 3.6) {
        state.modelConfig.enableInjectSystemPrompts = true;
      }

      if (version < 3.7) {
        state.enableAutoGenerateTitle = true;
      }

      if (version < 3.8) {
        state.lastUpdate = Date.now();
      }

      if (version < 3.9) {
        state.modelConfig.template =
          state.modelConfig.template !== DEFAULT_INPUT_TEMPLATE
            ? state.modelConfig.template
            : config?.template ?? DEFAULT_INPUT_TEMPLATE;
      }

      if (version < 4.1) {
        state.modelConfig.compressModel =
          DEFAULT_CONFIG.modelConfig.compressModel;
      }

      if (version < 4.2) {
        state.models = [];
      }

      if (version < 4.4) state.ttsConfig = migrateTTSConfig(state.ttsConfig);

      if (version < 4.5) {
        let rawAccess = await indexedDBStorage.getItem(LEGACY_ACCESS_BACKUP);
        if (!rawAccess) {
          rawAccess = await indexedDBStorage.getItem(StoreKey.Access);
          // The access store can finish migrating between the two reads.
          rawAccess =
            (await indexedDBStorage.getItem(LEGACY_ACCESS_BACKUP)) ?? rawAccess;
        }
        const access = rawAccess ? JSON.parse(rawAccess)?.state ?? {} : {};
        state = migrateLegacyConfig(state, access);
      }

      return state as any;
    },
  },
);
