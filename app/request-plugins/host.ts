import { z } from "zod";
import { useAppConfig } from "../store/config";
import type { Endpoint } from "../utils/endpoints";
import { parsePluginPackage, pluginDefaults } from "./schema";
import { callPlugin } from "./worker";
import type { PluginChat, PluginContext, PluginRequest } from "./sdk";
import { pluginSessionId } from "./identity";
import { nanoid } from "nanoid";
import { supportsLocalServices } from "./local-services";

const requestSchema = z
  .object({
    url: z.string(),
    headers: z.record(z.string()),
    body: z.record(z.unknown()).optional(),
  })
  .strict();

export type PreparedHostDriver = {
  hostDriver: "claude-code";
  input: {
    endpoint: { baseUrl: string; apiKey: string };
    sessionId: string;
    model: string;
    messages: PluginChat["messages"];
    enableTools: boolean;
    authType: string;
    betas: string[];
    reasoningEffort?: string;
  };
};
const hostDriverSchema = z
  .object({ hostDriver: z.literal("claude-code") })
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
  let disposed = false;
  const prepare = (signal?: AbortSignal) => {
    if (disposed) return Promise.reject(new Error("Plugin session is closed"));
    if (signal?.aborted)
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    return Promise.resolve();
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
    hostDrivers: supportsLocalServices() ? ["claude-code"] : [],
  };
  const validate = (value: unknown, driver: boolean): PluginRequest => {
    if (value && typeof value === "object" && "transport" in value)
      throw new Error(
        "Request plugin transport extensions are no longer supported",
      );
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
    return request;
  };
  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
    },
    async fetch(
      request: PluginRequest,
      method: "GET" | "POST",
      requestFetch: (url: string, options?: RequestInit) => Promise<Response>,
      signal?: AbortSignal,
    ) {
      await prepare(signal);
      const wire = validate(request, false);
      return requestFetch(wire.url, {
        method,
        headers: wire.headers,
        ...(wire.body === undefined ? {} : { body: JSON.stringify(wire.body) }),
        redirect: "manual",
        signal,
      });
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
      if (result === null) return null;
      const host = hostDriverSchema.safeParse(result);
      if (host.success) {
        if (!context.hostDrivers?.includes(host.data.hostDriver))
          throw new Error("This built-in driver is unavailable");
        const effort = pkg.config.nativeEffort || chat.reasoningEffort;
        const input: PreparedHostDriver["input"] = {
          endpoint: { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey },
          sessionId: context.sessionId,
          model: chat.model,
          messages: chat.messages,
          enableTools: chat.enableTools,
          authType: pkg.config.authType,
          betas: (pkg.config.nativeBeta || "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          ...(effort ? { reasoningEffort: effort } : {}),
        };
        return {
          hostDriver: host.data.hostDriver,
          input,
        } as PreparedHostDriver;
      }
      return validate(result, true);
    },
  };
}
