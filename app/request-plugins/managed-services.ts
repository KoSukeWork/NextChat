import { useAppConfig } from "../store/config";
import type { Endpoint } from "../utils/endpoints";
import type {
  LocalServiceDeclaration,
  RequestPluginBinding,
  RequestPluginPackage,
} from "./schema";
import { pluginDefaults } from "./schema";
import { localServiceAction, supportsLocalServices } from "./local-services";
import type { LocalServiceConnection } from "./local-services";
import { ServiceLifecycle } from "./service-lifecycle";

export function serviceConnectionMode(
  binding: RequestPluginBinding,
  service: LocalServiceDeclaration,
  pkg: RequestPluginPackage,
): "managed" | "external" {
  const explicit = binding.localServices?.[service.id];
  if (explicit === "managed" || explicit === "external") return explicit;
  const config = { ...pluginDefaults(pkg), ...binding.config };
  const url = config[service.urlField];
  const token = config[service.tokenField];
  if (
    !token &&
    (!url || url === pkg.manifest.fields[service.urlField]?.default)
  )
    return "managed";
  // Upgrade the old desktop-generated connection format. Fixed-port/manual
  // connections and remote hosts stay external; an explicit choice always wins.
  try {
    const address = new URL(url);
    if (
      address.protocol === "http:" &&
      address.hostname === "127.0.0.1" &&
      Number(address.port) >= 49152 &&
      address.pathname === "/" &&
      !address.search &&
      !address.hash &&
      !address.username &&
      !address.password &&
      /^[a-f0-9]{64}$/.test(token)
    )
      return "managed";
  } catch {}
  return "external";
}

export function activeManagedServices(
  endpoint: Endpoint,
  pkg: RequestPluginPackage,
) {
  const binding = endpoint.requestPlugin;
  if (!binding || !supportsLocalServices()) return [];
  const config = { ...pluginDefaults(pkg), ...binding.config };
  return (pkg.manifest.localServices ?? []).filter(
    (service) =>
      (!service.when || config[service.when.field] === service.when.value) &&
      serviceConnectionMode(binding, service, pkg) === "managed",
  );
}

export function connectionFields(
  service: LocalServiceDeclaration,
  connection: LocalServiceConnection,
) {
  return {
    [service.urlField]: connection.url,
    [service.tokenField]: connection.token,
    ...(service.versionField && connection.cliVersion
      ? { [service.versionField]: connection.cliVersion }
      : {}),
  };
}

function configured() {
  const state = useAppConfig.getState();
  return state.endpoints.flatMap((endpoint) => {
    const binding = endpoint.requestPlugin;
    const pkg = state.requestPlugins.find(
      (pkg) =>
        pkg.enabled &&
        pkg.manifest.id === binding?.id &&
        pkg.manifest.version === binding?.version &&
        pkg.manifest.protocols.includes(endpoint.protocol),
    );
    return pkg
      ? activeManagedServices(endpoint, pkg).map((service) => ({
          endpoint,
          service,
        }))
      : [];
  });
}

function publishConnection(id: string, connection: LocalServiceConnection) {
  const changes = configured().filter(({ service }) => service.id === id);
  const state = useAppConfig.getState();
  const endpoints = state.endpoints.map((endpoint) => {
    const match = changes.find((item) => item.endpoint === endpoint);
    if (!match) return endpoint;
    const binding = endpoint.requestPlugin!;
    const patch = connectionFields(match.service, connection);
    if (
      binding.localServices?.[id] === "managed" &&
      Object.entries(patch).every(
        ([field, value]) => binding.config[field] === value,
      )
    )
      return endpoint;
    return {
      ...endpoint,
      requestPlugin: {
        ...binding,
        config: { ...binding.config, ...patch },
        localServices: { ...binding.localServices, [id]: "managed" as const },
      },
    };
  });
  if (endpoints.some((endpoint, index) => endpoint !== state.endpoints[index]))
    useAppConfig.setState({ endpoints });
}

export const managedServices = new ServiceLifecycle(
  localServiceAction,
  publishConnection,
);

export function reconcileManagedServices() {
  if (!supportsLocalServices() || !useAppConfig.getState()._hasHydrated)
    return Promise.resolve();
  return managedServices.reconcile(
    new Set(configured().map(({ service }) => service.id)),
  );
}

/** Runs independently of settings UI, after persistence is hydrated. */
export function initializeManagedServices() {
  if (!supportsLocalServices()) return () => {};
  void reconcileManagedServices();
  return useAppConfig.subscribe((state, previous) => {
    if (
      state.endpoints !== previous.endpoints ||
      state.requestPlugins !== previous.requestPlugins ||
      state._hasHydrated !== previous._hasHydrated
    )
      void reconcileManagedServices();
  });
}
