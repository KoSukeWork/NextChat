import { endpointUrl } from "../utils/endpoints";
import type { Endpoint, EndpointModel } from "../utils/endpoints";
import { endpointFetch } from "../utils/endpoint-transport";
import { endpointHeaders } from "./endpoint-protocol";
import { createPluginSession } from "../request-plugins/host";
import { nanoid } from "nanoid";

export async function fetchEndpointModels(
  endpoint: Endpoint,
  requestFetch: typeof endpointFetch = endpointFetch,
): Promise<EndpointModel[]> {
  const found = new Map<string, EndpointModel>();
  const plugin = endpoint.requestPlugin
    ? createPluginSession(endpoint, nanoid(), "models")
    : undefined;
  const seenPages = new Set<string>();
  let page = "";
  try {
    if (plugin) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const prepared = await plugin.models(controller.signal);
        if (prepared) {
          let entries: any;
          if ("hostDriver" in prepared) {
            if (prepared.hostDriver !== "antigravity" || !window.__TAURI__)
              throw new Error("Model discovery is unavailable for this driver");
            entries = await window.__TAURI__.invoke("agy_acp_models");
          } else {
            const response = await requestFetch(prepared.url, {
              method: "GET",
              headers: prepared.headers,
              redirect: "manual",
              signal: controller.signal,
            });
            if (!response.ok)
              throw new Error(
                `HTTP ${response.status}: ${(await response.text()).slice(
                  0,
                  500,
                )}`,
              );
            entries = (await response.json())?.data;
          }
          if (!Array.isArray(entries))
            throw new Error("Invalid model list response");
          return entries
            .filter((item) => typeof item?.id === "string" && item.id)
            .map((item) => ({
              name: item.id,
              ...(typeof item.display_name === "string" &&
              item.display_name !== item.id
                ? { displayName: item.display_name }
                : {}),
            }));
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    do {
      const url = new URL(endpointUrl(endpoint, "models"));
      if (endpoint.protocol === "gemini") {
        url.searchParams.set("pageSize", "1000");
        if (page) url.searchParams.set("pageToken", page);
      } else if (endpoint.protocol === "anthropic") {
        url.searchParams.set("limit", "100");
        if (page) url.searchParams.set("after_id", page);
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      let response: Response;
      try {
        const original = {
          url: url.toString(),
          headers: endpointHeaders(endpoint),
        };
        const wire = plugin
          ? await plugin.request(original, controller.signal)
          : original;
        response = await (plugin
          ? plugin.fetch(wire, "GET", requestFetch, controller.signal)
          : requestFetch(wire.url, {
              method: "GET",
              headers: wire.headers,
              ...(plugin ? { redirect: "manual" as const } : {}),
              signal: controller.signal,
            }));
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
        );
      }
      const value = await response.json();
      if (value?.error)
        throw new Error(value.error.message ?? JSON.stringify(value.error));
      const models = endpoint.protocol === "gemini" ? value.models : value.data;
      if (!Array.isArray(models))
        throw new Error("Invalid model list response");
      for (const model of models) {
        if (
          endpoint.protocol === "gemini" &&
          !model?.supportedGenerationMethods?.includes("generateContent")
        )
          continue;
        const name =
          endpoint.protocol === "gemini"
            ? model?.name?.replace(/^models\//, "")
            : model?.id;
        if (typeof name !== "string" || !name) continue;
        const displayName = model.display_name ?? model.displayName;
        found.set(name, {
          name,
          ...(typeof displayName === "string" && displayName !== name
            ? { displayName }
            : {}),
        });
      }
      const next =
        endpoint.protocol === "gemini"
          ? value.nextPageToken
          : endpoint.protocol === "anthropic" && value.has_more
          ? value.last_id
          : "";
      if (endpoint.protocol === "anthropic" && value.has_more && !next)
        throw new Error("Invalid model pagination");
      if (next && (typeof next !== "string" || seenPages.has(next)))
        throw new Error("Invalid model pagination");
      if (next) seenPages.add(next);
      page = next || "";
    } while (page);
    return [...found.values()];
  } finally {
    await plugin?.dispose();
  }
}
