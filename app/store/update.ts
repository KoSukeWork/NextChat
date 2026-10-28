import { ModelProvider, StoreKey } from "../constant";
import { getClientConfig } from "../config/client";
import { createPersistStore } from "../utils/store";
import { ClientApi } from "../client/api";

const ONE_MINUTE = 60 * 1000;

interface UsageState {
  used: number;
  subscription: number;
  lastUpdateUsage: number;
}

// Restore only usage data. A previous installation's version must never override
// the current build's local version, and obsolete remote-update fields are dropped.
function usageState(value: unknown): UsageState {
  const state = value as Partial<UsageState> | undefined;
  return {
    used: state?.used ?? 0,
    subscription: state?.subscription ?? 0,
    lastUpdateUsage: state?.lastUpdateUsage ?? 0,
  };
}

export const useUpdateStore = createPersistStore(
  {
    version: getClientConfig()?.version ?? "unknown",
    ...usageState(undefined),
  },
  (set, get) => ({
    formatVersion(version: string) {
      return version || "unknown";
    },

    async updateUsage(force = false) {
      // only support openai for now
      const overOneMinute = Date.now() - get().lastUpdateUsage >= ONE_MINUTE;
      if (!overOneMinute && !force) return;

      set(() => ({
        lastUpdateUsage: Date.now(),
      }));

      try {
        const api = new ClientApi(ModelProvider.GPT);
        const usage = await api.llm.usage();

        if (usage) {
          set(() => ({
            used: usage.used,
            subscription: usage.total,
          }));
        }
      } catch (e) {
        console.error((e as Error).message);
      }
    },
  }),
  {
    name: StoreKey.Update,
    version: 1,
    merge: (persistedState, currentState) => ({
      ...currentState,
      ...usageState(persistedState),
    }),
  },
);
