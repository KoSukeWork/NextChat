import { BUILTIN_MASKS } from "../masks";
import { getLang, Lang } from "../locales";
import { DEFAULT_TOPIC, ChatMessage } from "./chat";
import { ModelConfig, useAppConfig } from "./config";
import { StoreKey } from "../constant";
import { nanoid } from "nanoid";
import { createPersistStore } from "../utils/store";
import { validTimestamp } from "../utils/chat-deletion";

export type Mask = {
  id: string;
  createdAt: number;
  updatedAt?: number;
  avatar: string;
  name: string;
  hideContext?: boolean;
  context: ChatMessage[];
  syncGlobalConfig?: boolean;
  modelConfig: ModelConfig;
  lang: Lang;
  builtin: boolean;
  plugin?: string[];
  mcpDisabled?: string[];
  enableArtifacts?: boolean;
  enableCodeFold?: boolean;
};

export const DEFAULT_MASK_STATE = {
  masks: {} as Record<string, Mask>,
  deletedMasks: {} as Record<string, number>,
  language: undefined as Lang | undefined,
};

export type MaskState = typeof DEFAULT_MASK_STATE & {
  language?: Lang | undefined;
};

export const DEFAULT_MASK_AVATAR = "gpt-bot";
export const createEmptyMask = () =>
  ({
    id: nanoid(),
    avatar: DEFAULT_MASK_AVATAR,
    name: DEFAULT_TOPIC,
    context: [],
    syncGlobalConfig: true, // use global config as default
    modelConfig: { ...useAppConfig.getState().modelConfig },
    lang: getLang(),
    builtin: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    plugin: [],
  }) as Mask;

export const useMaskStore = createPersistStore(
  { ...DEFAULT_MASK_STATE },

  (set, get) => ({
    create(mask?: Partial<Mask>) {
      const masks = get().masks;
      const id = nanoid();
      masks[id] = {
        ...createEmptyMask(),
        ...mask,
        id,
        builtin: false,
        updatedAt: Date.now(),
      };

      set(() => ({ masks }));
      get().markUpdate();

      return masks[id];
    },
    updateMask(id: string, updater: (mask: Mask) => void) {
      const masks = get().masks;
      const mask = masks[id];
      if (!mask) return;
      const updateMask = { ...mask };
      updater(updateMask);
      updateMask.updatedAt = Math.max(
        Date.now(),
        validTimestamp(mask.updatedAt ?? mask.createdAt) + 1,
        validTimestamp(get().deletedMasks?.[id]) + 1,
      );
      masks[id] = updateMask;
      const deletedMasks = { ...get().deletedMasks };
      delete deletedMasks[id];
      set(() => ({ masks, deletedMasks }));
      get().markUpdate();
    },
    delete(id: string) {
      const masks = get().masks;
      const mask = masks[id];
      if (!mask) return;
      delete masks[id];
      const deletedMasks = {
        ...get().deletedMasks,
        [id]: Math.max(
          Date.now(),
          validTimestamp(mask.updatedAt ?? mask.createdAt) + 1,
          validTimestamp(get().deletedMasks?.[id]) + 1,
        ),
      };
      set(() => ({ masks, deletedMasks }));
      get().markUpdate();
    },

    get(id?: string) {
      return get().masks[id ?? 1145141919810];
    },
    getAll() {
      const userMasks = Object.values(get().masks).sort(
        (a, b) => b.createdAt - a.createdAt,
      );
      const config = useAppConfig.getState();
      if (config.hideBuiltinMasks) return userMasks;
      const buildinMasks = BUILTIN_MASKS.map(
        (m) =>
          ({
            ...m,
            modelConfig: {
              ...config.modelConfig,
              ...m.modelConfig,
            },
          }) as Mask,
      );
      return userMasks.concat(buildinMasks);
    },
    search(text: string) {
      return Object.values(get().masks);
    },
    setLanguage(language: Lang | undefined) {
      set({
        language,
      });
    },
  }),
  {
    name: StoreKey.Mask,
    version: 3.2,

    migrate(state, version) {
      const newState = JSON.parse(JSON.stringify(state)) as MaskState;

      // migrate mask id to nanoid
      if (version < 3) {
        Object.values(newState.masks).forEach((m) => (m.id = nanoid()));
      }

      if (version < 3.1) {
        const updatedMasks: Record<string, Mask> = {};
        Object.values(newState.masks).forEach((m) => {
          updatedMasks[m.id] = m;
        });
        newState.masks = updatedMasks;
      }

      if (version < 3.2) {
        const masks: Record<string, Mask> = Object.create(null);
        Object.entries(newState.masks ?? {}).forEach(([key, mask]) => {
          mask.id ||= key;
          mask.updatedAt = validTimestamp(mask.updatedAt ?? mask.createdAt);
          const existing = masks[mask.id];
          if (
            !existing ||
            validTimestamp(mask.updatedAt) > validTimestamp(existing.updatedAt)
          )
            masks[mask.id] = mask;
        });
        newState.masks = masks;
        newState.deletedMasks ??= {};
      }

      return newState as any;
    },
  },
);
