import { Path } from "../constant";
import { showToast } from "../components/ui-lib";
import Locale from "../locales";
import { useAppConfig } from "../store/config";
import { resolveEndpointModel } from "./endpoints";

export function resolveConfiguredModel(
  model: string,
  endpointId = "",
  silentOnMissing = false,
) {
  const config = useAppConfig.getState();
  const resolved = resolveEndpointModel(
    config.endpoints,
    { model, endpointId },
    config.modelConfig,
  );
  if (!resolved) {
    if (!silentOnMissing)
      showToast(Locale.ModelDiscovery.ConfigureFirst, {
        text: Locale.EndpointConfig.OpenSettings,
        onClick: () => {
          window.location.hash = `#${Path.Settings}`;
        },
      });
    return;
  }
  if (resolved.match === "default") {
    const previous =
      config.endpoints.find((item) => item.id === endpointId)?.name ?? "—";
    const next =
      config.endpoints.find((item) => item.id === resolved.endpointId)?.name ??
      "—";
    showToast(
      Locale.ModelFallback.Switched(
        `${model || "—"} (${previous})`,
        `${resolved.model} (${next})`,
      ),
    );
  }
  return { model: resolved.model, endpointId: resolved.endpointId };
}
