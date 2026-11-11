import type { RequestPluginBinding } from "../request-plugins/schema";

export const endpointProtocols = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
] as const;

export type EndpointProtocol = (typeof endpointProtocols)[number];

export interface EndpointModel {
  name: string;
  displayName?: string;
}

export interface Endpoint {
  id: string;
  name: string;
  protocol: EndpointProtocol;
  baseUrl: string;
  apiKey: string;
  models: EndpointModel[];
  /** Older configurations omit this field and use automatic tool calling. */
  toolCalling?: "auto" | "text";
  requestPlugin?: RequestPluginBinding;
}

export interface ModelSelection {
  model: string;
  endpointId: string;
}

export type ModelResolution = ModelSelection & {
  match: "exact" | "name" | "default";
};

/** Resolve a synced selection against this device's endpoint configuration. */
export function resolveEndpointModel(
  endpoints: readonly Endpoint[],
  selection: Partial<ModelSelection>,
  fallback: Partial<ModelSelection>,
): ModelResolution | undefined {
  const model = selection.model ?? "";
  const exact = endpoints.find(
    (endpoint) =>
      endpoint.id === selection.endpointId &&
      endpoint.models.some((item) => item.name === model),
  );
  if (exact) return { model, endpointId: exact.id, match: "exact" };

  const named = endpoints.find((endpoint) =>
    endpoint.models.some((item) => item.name === model),
  );
  if (named) return { model, endpointId: named.id, match: "name" };

  const defaultEndpoint = endpoints.find(
    (endpoint) =>
      endpoint.id === fallback.endpointId &&
      endpoint.models.some((item) => item.name === fallback.model),
  );
  if (defaultEndpoint && fallback.model) {
    return {
      model: fallback.model,
      endpointId: defaultEndpoint.id,
      match: "default",
    };
  }
}

/** Join protocol paths without duplicating a version already in the base URL. */
export function endpointUrl(
  endpoint: Pick<Endpoint, "baseUrl" | "protocol">,
  operation: "chat" | "models",
  model = "",
  stream = true,
): string {
  const raw = endpoint.baseUrl.trim();
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The base address must use HTTP or HTTPS");
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  const hasVersion = /(?:^|\/)v\d+(?:(?:alpha|beta)\d*)?(?:\/|$)/i.test(
    basePath,
  );
  const defaultVersion = endpoint.protocol === "gemini" ? "v1beta" : "v1";
  const prefix = hasVersion ? basePath : `${basePath}/${defaultVersion}`;
  let suffix: string;
  if (operation === "models") {
    suffix = "models";
  } else {
    switch (endpoint.protocol) {
      case "openai-chat":
        suffix = "chat/completions";
        break;
      case "openai-responses":
        suffix = "responses";
        break;
      case "anthropic":
        suffix = "messages";
        break;
      case "gemini": {
        const name = model.replace(/^models\//, "");
        suffix = `models/${encodeURIComponent(name)}:${
          stream ? "streamGenerateContent" : "generateContent"
        }`;
        if (stream) url.searchParams.set("alt", "sse");
        break;
      }
    }
  }
  url.pathname = `${prefix}/${suffix}`.replace(/\/{2,}/g, "/");
  url.hash = "";
  return url.toString();
}
