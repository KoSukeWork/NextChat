import { useAccessStore } from "../store/access";
import { useAppConfig } from "../store/config";
import { ServiceProvider } from "../constant";
import { collectModelsWithDefaultModel } from "./model";
import { showToast } from "../components/ui-lib";
import Locale from "../locales";

// Shared by the model picker and all chat request paths.
export function configuredModels(
  config: ReturnType<typeof useAppConfig.getState>,
  access: ReturnType<typeof useAccessStore.getState>,
) {
  return collectModelsWithDefaultModel(
    config.models,
    [config.customModels, access.customModels].join(","),
    access.defaultModel,
    access.useCustomConfig ? access.provider : ServiceProvider.OpenAI,
  );
}

export function resolveLocalModel(model: string, providerName: string) {
  const config = useAppConfig.getState();
  const models = configuredModels(config, useAccessStore.getState());
  const available = (name: string, provider: string) =>
    models.some(
      (m) =>
        m.available && m.name === name && m.provider?.providerName === provider,
    );
  if (available(model, providerName))
    return { model, providerName: providerName as ServiceProvider };
  const fallback = config.modelConfig;
  if (!available(fallback.model, fallback.providerName)) {
    showToast(Locale.ModelDiscovery.ConfigureFirst);
    return;
  }
  showToast(
    Locale.ModelFallback.Switched(
      `${model || "—"}@${providerName}`,
      `${fallback.model}@${fallback.providerName}`,
    ),
  );
  return { model: fallback.model, providerName: fallback.providerName };
}
