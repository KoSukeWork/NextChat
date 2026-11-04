import { StoreKey } from "../constant";
import { getClientConfig } from "../config/client";
import { createPersistStore } from "../utils/store";

export const useUpdateStore = createPersistStore(
  { version: getClientConfig()?.version ?? "unknown" },
  () => ({
    formatVersion(version: string) {
      return version || "unknown";
    },
  }),
  {
    name: StoreKey.Update,
    version: 2,
    merge: (_persisted, current) => current,
    migrate: () => ({}) as any,
  },
);
