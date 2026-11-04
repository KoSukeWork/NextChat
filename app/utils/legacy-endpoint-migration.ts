import { nanoid } from "nanoid";
import type {
  Endpoint,
  EndpointModel,
  EndpointProtocol,
  ModelSelection,
} from "./endpoints";

type Legacy = Record<string, any>;
export const LEGACY_ACCESS_BACKUP = "legacy-access-control-backup";
export const LEGACY_CONFIG_BACKUP = "legacy-app-config-backup";

// Built-in masks use the local default rather than a bundled model selection.
export function stripBuiltinModelSelection<T extends object>(config: T) {
  const { model, providerName, endpointId, ...rest } = config as Legacy;
  return rest;
}

const supported: {
  name: string;
  id: string;
  key: string;
  url: string;
  base: string;
  protocol: EndpointProtocol;
  prefix?: string;
}[] = [
  {
    name: "OpenAI",
    id: "openai",
    key: "openaiApiKey",
    url: "openaiUrl",
    base: "https://api.openai.com",
    protocol: "openai-chat",
  },
  {
    name: "Anthropic",
    id: "anthropic",
    key: "anthropicApiKey",
    url: "anthropicUrl",
    base: "https://api.anthropic.com",
    protocol: "anthropic",
  },
  {
    name: "Google",
    id: "google",
    key: "googleApiKey",
    url: "googleUrl",
    base: "https://generativelanguage.googleapis.com",
    protocol: "gemini",
  },
  {
    name: "DeepSeek",
    id: "deepseek",
    key: "deepseekApiKey",
    url: "deepseekUrl",
    base: "https://api.deepseek.com",
    protocol: "openai-chat",
    prefix: "/v1",
  },
  {
    name: "Moonshot",
    id: "moonshot",
    key: "moonshotApiKey",
    url: "moonshotUrl",
    base: "https://api.moonshot.ai",
    protocol: "openai-chat",
  },
  {
    name: "XAI",
    id: "xai",
    key: "xaiApiKey",
    url: "xaiUrl",
    base: "https://api.x.ai",
    protocol: "openai-chat",
  },
  {
    name: "ChatGLM",
    id: "chatglm",
    key: "chatglmApiKey",
    url: "chatglmUrl",
    base: "https://open.bigmodel.cn",
    protocol: "openai-chat",
    prefix: "/api/paas/v4",
  },
  {
    name: "ByteDance",
    id: "bytedance",
    key: "bytedanceApiKey",
    url: "bytedanceUrl",
    base: "https://ark.cn-beijing.volces.com",
    protocol: "openai-chat",
    prefix: "/api/v3",
  },
  {
    name: "SiliconFlow",
    id: "siliconflow",
    key: "siliconflowApiKey",
    url: "siliconflowUrl",
    base: "https://api.siliconflow.cn",
    protocol: "openai-chat",
  },
  {
    name: "302.AI",
    id: "ai302",
    key: "ai302ApiKey",
    url: "ai302Url",
    base: "https://api.302.ai",
    protocol: "openai-chat",
  },
];

const unsupported = [
  {
    name: "Baidu",
    keys: ["baiduApiKey", "baiduSecretKey"],
    url: "baiduUrl",
    base: "https://aip.baidubce.com",
  },
  {
    name: "Alibaba",
    keys: ["alibabaApiKey"],
    url: "alibabaUrl",
    base: "https://dashscope.aliyuncs.com/api",
  },
  {
    name: "Tencent",
    keys: ["tencentSecretKey", "tencentSecretId"],
    url: "tencentUrl",
    base: "https://hunyuan.tencentcloudapi.com",
  },
  {
    name: "Iflytek",
    keys: ["iflytekApiKey", "iflytekApiSecret"],
    url: "iflytekUrl",
    base: "https://spark-api-open.xf-yun.com",
  },
  { name: "Azure", keys: ["azureApiKey"], url: "azureUrl", base: "" },
];

function absoluteUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) return;
  try {
    return new URL(value.trim()).toString().replace(/\/$/, "");
  } catch {
    return;
  }
}

function withLegacyPrefix(base: string, prefix?: string) {
  if (!prefix) return base;
  const url = new URL(base);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (/(?:^|\/)v\d+(?:(?:alpha|beta)\d*)?(?:\/|$)/i.test(pathname)) return base;
  const parts = prefix.split("/").filter(Boolean);
  const existing = pathname.split("/").filter(Boolean);
  let overlap = Math.min(existing.length, parts.length);
  while (
    overlap > 0 &&
    existing.slice(-overlap).join("/") !== parts.slice(0, overlap).join("/")
  )
    overlap--;
  url.pathname = `${pathname}/${parts.slice(overlap).join("/")}`;
  return url.toString().replace(/\/$/, "");
}

function modelBelongs(value: unknown, entry: (typeof supported)[number]) {
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase();
  return (
    normalized === entry.id.toLowerCase() ||
    normalized === entry.name.toLowerCase()
  );
}

function collectLegacyModels(
  config: Legacy,
  access: Legacy,
  entry: (typeof supported)[number],
): EndpointModel[] {
  const found = new Map<string, EndpointModel>();
  const add = (name: unknown, displayName?: unknown) => {
    if (typeof name !== "string" || !name.trim()) return;
    const item: EndpointModel = { name: name.trim() };
    if (
      typeof displayName === "string" &&
      displayName.trim() &&
      displayName !== item.name
    )
      item.displayName = displayName.trim();
    if (!found.has(item.name)) found.set(item.name, item);
  };
  for (const model of Array.isArray(config.models) ? config.models : []) {
    if (
      modelBelongs(model?.provider?.id, entry) ||
      modelBelongs(model?.provider?.providerName, entry)
    )
      add(model.name, model.displayName);
  }
  for (const source of [config.customModels, access.customModels]) {
    if (typeof source !== "string") continue;
    for (const token of source.split(",")) {
      let value = token.trim();
      if (!value || value.startsWith("-")) continue;
      if (value.startsWith("+")) value = value.slice(1);
      const [modelPart, displayName] = value.split("=");
      const at = modelPart.lastIndexOf("@");
      const name = at < 0 ? modelPart : modelPart.slice(0, at);
      const owner =
        at < 0 ? access.provider || "OpenAI" : modelPart.slice(at + 1);
      if (name !== "all" && modelBelongs(owner, entry)) add(name, displayName);
    }
  }
  return [...found.values()];
}

export interface LegacyEndpointMigration {
  endpoints: Endpoint[];
  defaultModel: ModelSelection;
  compressModel: ModelSelection;
  unsupported: string[];
}

/** Convert a snapshot only; callers retain the old access store if migration fails. */
export function migrateLegacyEndpoints(
  config: Legacy,
  access: Legacy,
  makeId: () => string = nanoid,
): LegacyEndpointMigration {
  if (Array.isArray(config.endpoints)) {
    return {
      endpoints: config.endpoints,
      defaultModel: {
        model: config.modelConfig?.model ?? "",
        endpointId: config.modelConfig?.endpointId ?? "",
      },
      compressModel: {
        model: config.modelConfig?.compressModel ?? "",
        endpointId: config.modelConfig?.compressEndpointId ?? "",
      },
      unsupported: Array.isArray(config.unmigratedEndpoints)
        ? config.unmigratedEndpoints
        : [],
    };
  }
  const endpointOwners = new Map<string, string>();
  const endpoints: Endpoint[] = [];
  for (const entry of supported) {
    const enteredUrl = absoluteUrl(access[entry.url]);
    const isCustomUrl = !!enteredUrl && enteredUrl !== absoluteUrl(entry.base);
    const apiKey =
      typeof access[entry.key] === "string" ? access[entry.key] : "";
    if (!apiKey.trim() && !isCustomUrl) continue;
    const endpoint: Endpoint = {
      id: makeId(),
      name: entry.name,
      protocol: entry.protocol,
      baseUrl: withLegacyPrefix(enteredUrl ?? entry.base, entry.prefix),
      apiKey,
      models: collectLegacyModels(config, access, entry),
    };
    endpoints.push(endpoint);
    endpointOwners.set(entry.name.toLowerCase(), endpoint.id);
    endpointOwners.set(entry.id.toLowerCase(), endpoint.id);
  }
  const modelConfig = config.modelConfig ?? {};
  const selection = (model: unknown, owner: unknown): ModelSelection => {
    const name = typeof model === "string" ? model : "";
    const selected =
      typeof owner === "string"
        ? endpointOwners.get(owner.toLowerCase())
        : undefined;
    return {
      model: name,
      endpointId:
        selected ??
        endpoints.find((item) => item.models.some((m) => m.name === name))
          ?.id ??
        "",
    };
  };
  return {
    endpoints,
    defaultModel: selection(modelConfig.model, modelConfig.providerName),
    compressModel: selection(
      modelConfig.compressModel,
      modelConfig.compressProviderName,
    ),
    unsupported: unsupported
      .filter((entry) => {
        const url = absoluteUrl(access[entry.url]);
        return (
          entry.keys.some(
            (key) => typeof access[key] === "string" && access[key].trim(),
          ) ||
          (!!url && url !== absoluteUrl(entry.base))
        );
      })
      .map((entry) => entry.name),
  };
}

/** Remove obsolete fields only after the new endpoint snapshot was built. */
export function migrateLegacyConfig(config: Legacy, access: Legacy) {
  const migrated = migrateLegacyEndpoints(config, access);
  const { models, customModels, realtimeConfig, ...rest } = config;
  const {
    providerName,
    compressProviderName,
    size,
    quality,
    style,
    ...modelConfig
  } = config.modelConfig ?? {};
  return {
    ...rest,
    endpoints: migrated.endpoints,
    unmigratedEndpoints: migrated.unsupported,
    modelConfig: {
      ...modelConfig,
      model: migrated.defaultModel.model,
      endpointId: migrated.defaultModel.endpointId,
      compressModel: migrated.compressModel.model,
      compressEndpointId: migrated.compressModel.endpointId,
    },
  };
}
