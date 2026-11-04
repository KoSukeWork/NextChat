import { useMemo } from "react";
import { useAppConfig } from "../store/config";

export function useAllModels() {
  const endpoints = useAppConfig((state) => state.endpoints);
  const selected = useAppConfig((state) => state.modelConfig);
  return useMemo(
    () =>
      endpoints.flatMap((endpoint) =>
        endpoint.models.map((model) => ({
          name: model.name,
          displayName: model.displayName || model.name,
          endpointId: endpoint.id,
          endpointName: endpoint.name,
          isDefault:
            endpoint.id === selected.endpointId &&
            model.name === selected.model,
        })),
      ),
    [endpoints, selected.endpointId, selected.model],
  );
}
