import { StoreKey } from "../constant";
import { getClientConfig } from "../config/client";
import { indexedDBStorage } from "../utils/indexedDB-storage";
import { LEGACY_ACCESS_BACKUP } from "../utils/legacy-endpoint-migration";
import { createPersistStore } from "../utils/store";

let fetchState = 0;
const isApp =
  !!getClientConfig()?.isApp || getClientConfig()?.buildMode === "export";
const DEFAULT_ACCESS_STATE = { accessCode: "", needCode: false };

export const useAccessStore = createPersistStore(
  DEFAULT_ACCESS_STATE,
  (set, get) => ({
    enabledAccessControl() {
      if (isApp) return false;
      this.fetch();
      return get().needCode;
    },
    isAuthorized() {
      return !this.enabledAccessControl() || !!get().accessCode.trim();
    },
    fetch() {
      if (isApp || fetchState > 0) return;
      fetchState = 1;
      fetch("/api/config", { method: "POST" })
        .then((response) => response.json())
        .then((value: { needCode?: boolean }) =>
          set({ needCode: !!value.needCode }),
        )
        .catch(() => console.error("[Config] failed to fetch access settings"))
        .finally(() => {
          fetchState = 2;
        });
    },
  }),
  {
    name: StoreKey.Access,
    version: 4,
    merge(persisted, current) {
      const state = (persisted ?? {}) as Partial<typeof DEFAULT_ACCESS_STATE>;
      return {
        ...current,
        accessCode:
          typeof state.accessCode === "string" ? state.accessCode : "",
        needCode: isApp ? false : !!state.needCode,
      };
    },
    async migrate(persisted, version) {
      const state = (persisted ?? {}) as Record<string, unknown>;
      if (
        version < 4 &&
        !(await indexedDBStorage.getItem(LEGACY_ACCESS_BACKUP))
      ) {
        await indexedDBStorage.setItem(
          LEGACY_ACCESS_BACKUP,
          JSON.stringify({ state: { ...state, _hasHydrated: true }, version }),
        );
        if (!(await indexedDBStorage.getItem(LEGACY_ACCESS_BACKUP)))
          throw new Error("Could not preserve old access settings");
      }
      return {
        accessCode:
          typeof state.accessCode === "string" ? state.accessCode : "",
        needCode: isApp ? false : !!state.needCode,
      } as any;
    },
  },
);
