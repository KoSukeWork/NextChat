import type { LLMModel } from "./api";
import { getHeaders } from "./api";
import { getModelProviderInfo } from "../utils/model";
import { fetch } from "../utils/stream";

export class ModelDiscoveryUnsupportedError extends Error {
  constructor() {
    super(
      "Model discovery is not supported by this provider. Please add models manually.",
    );
    this.name = "ModelDiscoveryUnsupportedError";
  }
}

export async function fetchModelPage(
  url: string,
  provider: string,
  headers: Record<string, string> = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { ...getHeaders(false, provider), ...headers },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${
          (await response.text()).slice(0, 500) || response.statusText
        }`,
      );
    }
    const result = await response.json();
    if (result.error) {
      throw new Error(
        result.error.message || result.message || JSON.stringify(result.error),
      );
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

export function discoveredModels(
  names: string[],
  providerName: string,
): LLMModel[] {
  const provider = getModelProviderInfo(providerName);
  return [...new Set(names)].map((name, sorted) => ({
    name,
    available: true,
    sorted,
    provider,
  }));
}

export async function fetchOpenAIModels(
  url: string,
  provider: string,
): Promise<LLMModel[]> {
  const result = await fetchModelPage(url, provider);
  if (
    !Array.isArray(result.data) ||
    result.data.some((m: { id?: string }) => typeof m.id !== "string")
  ) {
    throw new Error("Invalid model list response: expected data[].id");
  }
  return discoveredModels(
    result.data.map((m: { id: string }) => m.id),
    provider,
  );
}
