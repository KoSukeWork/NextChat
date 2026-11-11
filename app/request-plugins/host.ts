import { z } from "zod";
import { useAppConfig } from "../store/config";
import type { Endpoint } from "../utils/endpoints";
import { parsePluginPackage, pluginDefaults } from "./schema";
import { callPlugin } from "./worker";
import type { PluginChat, PluginContext, PluginRequest } from "./sdk";
import { pluginSessionId } from "./identity";
import { nanoid } from "nanoid";
import {
  activeManagedServices,
  connectionFields,
  managedServices,
  reconcileManagedServices,
} from "./managed-services";
import type { ServiceLease } from "./service-lifecycle";

const requestSchema = z
  .object({
    url: z.string(),
    headers: z.record(z.string()),
    body: z.record(z.unknown()).optional(),
    transport: z
      .object({ profile: z.string().min(1).max(120) })
      .strict()
      .optional(),
  })
  .strict();

export function resolveRequestPlugin(endpoint: Endpoint) {
  const binding = endpoint.requestPlugin;
  if (!binding) return;
  const installed = useAppConfig
    .getState()
    .requestPlugins.find(
      (p) =>
        p.manifest.id === binding.id && p.manifest.version === binding.version,
    );
  if (!installed?.enabled)
    throw new Error(
      `Request plugin ${binding.id}@${binding.version} is missing or disabled`,
    );
  const pkg = parsePluginPackage(
    installed && { manifest: installed.manifest, source: installed.source },
  );
  if (!pkg.manifest.protocols.includes(endpoint.protocol))
    throw new Error("The request plugin does not support this protocol");
  const config = { ...pluginDefaults(pkg), ...binding.config };
  for (const [key, field] of Object.entries(pkg.manifest.fields)) {
    if (
      field.type === "select" &&
      !field.options?.some((option) => option.value === config[key])
    )
      throw new Error(`Invalid plugin configuration: ${field.title}`);
  }
  // Snapshot the package and configuration for the entire operation.
  return { ...pkg, config };
}

export function createPluginSession(
  endpoint: Endpoint,
  sessionId: string,
  operation: PluginContext["operation"],
  options: { preview?: boolean } = {},
) {
  const pkg = resolveRequestPlugin(endpoint);
  if (!pkg) return;
  const services = activeManagedServices(endpoint, pkg);
  if (options.preview) {
    for (const service of services) {
      // Preview is side-effect free and never boots a process for placeholder credentials.
      pkg.config[service.tokenField] = "managed-service-token-placeholder";
    }
  }
  const leases: ServiceLease[] = [];
  let preparation: Promise<void> | undefined;
  let disposed = false;
  const prepare = (signal?: AbortSignal) => {
    if (disposed) return Promise.reject(new Error("Plugin session is closed"));
    return (preparation ??= (async () => {
      if (options.preview || !services.length) return;
      void reconcileManagedServices();
      for (const service of services) {
        const lease = await managedServices.acquire(service.id, signal);
        leases.push(lease);
        Object.assign(pkg.config, connectionFields(service, lease.connection));
      }
    })());
  };
  const context: PluginContext = {
    operation,
    protocol: endpoint.protocol,
    endpoint: {
      id: endpoint.id,
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
    },
    config: pkg.config,
    sessionId: pluginSessionId(endpoint.id, sessionId),
    requestId: nanoid(),
  };
  const validate = (value: unknown, driver: boolean): PluginRequest => {
    const request = requestSchema.parse(value);
    const url = new URL(request.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Plugin returned an invalid HTTP URL");
    // A hook cannot silently redirect the endpoint credentials to another host.
    const allowed = new URL(driver ? pkg.config.bridgeUrl : endpoint.baseUrl);
    if (url.origin !== allowed.origin)
      throw new Error(
        "Plugin request destination differs from the configured endpoint",
      );
    new Headers(request.headers);
    if (request.transport) {
      if (
        driver ||
        pkg.manifest.sdkVersion !== 2 ||
        !pkg.manifest.capabilities.includes("transport")
      )
        throw new Error("The plugin did not declare an independent transport");
      const relay = new URL(pkg.config.transportUrl);
      if (
        !["http:", "https:"].includes(relay.protocol) ||
        relay.username ||
        relay.password ||
        relay.search ||
        relay.hash
      )
        throw new Error("Invalid independent transport URL");
      if (!pkg.config.transportToken || pkg.config.transportToken.length < 16)
        throw new Error(
          "Configure a transport token of at least 16 characters",
        );
    }
    return request;
  };
  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      await preparation?.catch(() => {});
      await Promise.allSettled(
        leases.splice(0).map((lease) => lease.release()),
      );
    },
    async fetch(
      request: PluginRequest,
      method: "GET" | "POST",
      requestFetch: (url: string, options?: RequestInit) => Promise<Response>,
      signal?: AbortSignal,
    ) {
      await prepare(signal);
      // Validation is repeated at this trust boundary; the transport token is
      // taken from the frozen endpoint settings, never from worker output.
      const wire = validate(request, false);
      if (!wire.transport)
        return requestFetch(wire.url, {
          method,
          headers: wire.headers,
          ...(wire.body === undefined
            ? {}
            : { body: JSON.stringify(wire.body) }),
          redirect: "manual",
          signal,
        });
      return requestFetch(
        `${pkg.config.transportUrl.replace(/\/+$/, "")}/v1/requests`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${pkg.config.transportToken}`,
          },
          // Preserve header spelling and exact serialized body inside an opaque
          // envelope. Browser Headers and the web/native relay only see the outer
          // transport request, so they cannot normalize upstream headers.
          body: JSON.stringify({
            version: 1,
            profile: wire.transport.profile,
            url: wire.url,
            method,
            headers: Object.entries(wire.headers),
            ...(wire.body === undefined
              ? {}
              : { body: JSON.stringify(wire.body) }),
          }),
          redirect: "manual",
          signal,
        },
      );
    },
    async request(request: PluginRequest, signal?: AbortSignal) {
      await prepare(signal);
      if (!pkg.manifest.capabilities.includes("request")) return request;
      return validate(
        await callPlugin(
          pkg.source,
          "prepareRequest",
          [request, context],
          signal,
        ),
        false,
      );
    },
    async chat(chat: PluginChat, signal?: AbortSignal) {
      await prepare(signal);
      if (!pkg.manifest.capabilities.includes("driver")) return null;
      const result = await callPlugin(
        pkg.source,
        "prepareChat",
        [chat, context],
        signal,
      );
      return result === null ? null : validate(result, true);
    },
  };
}
