import { useMemo } from "react";
import { useAccessStore, useAppConfig } from "../store";
import { configuredModels } from "./local-models";

export function useAllModels() {
  const accessStore = useAccessStore();
  const configStore = useAppConfig();
  const models = useMemo(() => {
    return configuredModels(configStore, accessStore);
  }, [
    accessStore.useCustomConfig,
    accessStore.provider,
    accessStore.customModels,
    accessStore.defaultModel,
    configStore.customModels,
    configStore.models,
  ]);

  return models;
}
