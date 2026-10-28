import { ServiceProvider } from "../constant";
import type { LLMModel } from "../client/api";

const CustomSeq = {
  val: -1000, //To ensure the custom model located at front, start from -1000, refer to constant.ts
  cache: new Map<string, number>(),
  next: (id: string) => {
    if (CustomSeq.cache.has(id)) {
      return CustomSeq.cache.get(id) as number;
    } else {
      let seq = CustomSeq.val++;
      CustomSeq.cache.set(id, seq);
      return seq;
    }
  },
};

const providers = [
  ["openai", ServiceProvider["OpenAI"]],
  ["azure", ServiceProvider["Azure"]],
  ["google", ServiceProvider["Google"]],
  ["anthropic", ServiceProvider["Anthropic"]],
  ["baidu", ServiceProvider["Baidu"]],
  ["bytedance", ServiceProvider["ByteDance"]],
  ["alibaba", ServiceProvider["Alibaba"]],
  ["tencent", ServiceProvider["Tencent"]],
  ["moonshot", ServiceProvider["Moonshot"]],
  ["iflytek", ServiceProvider["Iflytek"]],
  ["xai", ServiceProvider["XAI"]],
  ["chatglm", ServiceProvider["ChatGLM"]],
  ["deepseek", ServiceProvider["DeepSeek"]],
  ["siliconflow", ServiceProvider["SiliconFlow"]],
  ["ai302", ServiceProvider["302.AI"]],
] as const;

export function getModelProviderInfo(
  providerName: string,
): LLMModel["provider"] {
  const normalized = providerName.toLowerCase();
  const index = providers.findIndex(
    ([id, name]) => id === normalized || name.toLowerCase() === normalized,
  );
  if (index !== -1) {
    const [id, name] = providers[index];
    return { id, providerName: name, providerType: id, sorted: index + 1 };
  }
  return customProvider(providerName);
}

const customProvider = (providerName: string) => ({
  id: providerName.toLowerCase(),
  providerName: providerName,
  providerType: "custom",
  sorted: CustomSeq.next(providerName),
});

/**
 * Sorts an array of models based on specified rules.
 *
 * First, sorted by provider; if the same, sorted by model
 */
const sortModelTable = (models: ReturnType<typeof collectModels>) =>
  models.sort((a, b) => {
    if (a.provider && b.provider) {
      let cmp = a.provider.sorted - b.provider.sorted;
      return cmp === 0 ? a.sorted - b.sorted : cmp;
    } else {
      return a.sorted - b.sorted;
    }
  });

/**
 * get model name and provider from a formatted string,
 * e.g. `gpt-4@OpenAi` or `claude-3-5-sonnet@20240620@Google`
 * @param modelWithProvider model name with provider separated by last `@` char,
 * @returns [model, provider] tuple, if no `@` char found, provider is undefined
 */
export function getModelProvider(modelWithProvider: string): [string, string?] {
  const [model, provider] = modelWithProvider.split(/@(?!.*@)/);
  return [model, provider];
}

export function collectModelTable(
  models: readonly LLMModel[],
  customModels: string,
  defaultProviderName: string = ServiceProvider.OpenAI,
) {
  const modelTable: Record<
    string,
    {
      available: boolean;
      name: string;
      displayName: string;
      sorted: number;
      provider?: LLMModel["provider"]; // Marked as optional
      isDefault?: boolean;
    }
  > = {};

  // default models
  models.forEach((m) => {
    // using <modelName>@<providerId> as fullName
    modelTable[`${m.name}@${m?.provider?.id}`] = {
      ...m,
      displayName: m.displayName || m.name, // 'provider' is copied over if it exists
    };
  });

  // server custom models
  customModels
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .forEach((m) => {
      const available = !m.startsWith("-");
      const nameConfig =
        m.startsWith("+") || m.startsWith("-") ? m.slice(1) : m;
      let [name, displayName] = nameConfig.split("=");

      // enable or disable all models
      if (name === "all") {
        Object.values(modelTable).forEach(
          (model) => (model.available = available),
        );
      } else {
        // 1. find model by name, and set available value
        const [customModelName, customProviderName] = getModelProvider(name);
        let count = 0;
        for (const fullName in modelTable) {
          const [modelName, providerName] = getModelProvider(fullName);
          if (
            customModelName == modelName &&
            (customProviderName === undefined ||
              getModelProviderInfo(customProviderName).id === providerName)
          ) {
            count += 1;
            modelTable[fullName]["available"] = available;
            // swap name and displayName for bytedance
            if (providerName === "bytedance" && displayName) {
              [name, displayName] = [displayName, modelName];
              modelTable[fullName]["name"] = name;
            }
            if (displayName) {
              modelTable[fullName]["displayName"] = displayName;
            }
          }
        }
        // 2. if model not exists, create new model with available value
        if (count === 0) {
          let [customModelName, customProviderName] = getModelProvider(name);
          const provider = getModelProviderInfo(
            customProviderName || defaultProviderName,
          );
          // swap name and displayName for bytedance
          if (displayName && provider.providerName == "ByteDance") {
            [customModelName, displayName] = [displayName, customModelName];
          }
          modelTable[`${customModelName}@${provider?.id}`] = {
            name: customModelName,
            displayName: displayName || customModelName,
            available,
            provider, // Use optional chaining
            sorted: CustomSeq.next(`${customModelName}@${provider?.id}`),
          };
        }
      }
    });

  return modelTable;
}

export function collectModelTableWithDefaultModel(
  models: readonly LLMModel[],
  customModels: string,
  defaultModel: string,
  defaultProviderName: string = ServiceProvider.OpenAI,
) {
  let modelTable = collectModelTable(models, customModels, defaultProviderName);
  if (defaultModel && defaultModel !== "") {
    if (defaultModel.includes("@")) {
      const [name, provider] = getModelProvider(defaultModel);
      const key = `${name}@${getModelProviderInfo(provider!).id}`;
      if (modelTable[key]?.available) {
        modelTable[key].isDefault = true;
      }
    } else {
      for (const key of Object.keys(modelTable)) {
        if (
          modelTable[key].available &&
          getModelProvider(key)[0] == defaultModel
        ) {
          modelTable[key].isDefault = true;
          break;
        }
      }
    }
  }
  return modelTable;
}

/**
 * Generate full model table.
 */
export function collectModels(
  models: readonly LLMModel[],
  customModels: string,
  defaultProviderName: string = ServiceProvider.OpenAI,
) {
  const modelTable = collectModelTable(
    models,
    customModels,
    defaultProviderName,
  );
  let allModels = Object.values(modelTable);

  allModels = sortModelTable(allModels);

  return allModels;
}

export function collectModelsWithDefaultModel(
  models: readonly LLMModel[],
  customModels: string,
  defaultModel: string,
  defaultProviderName: string = ServiceProvider.OpenAI,
) {
  const modelTable = collectModelTableWithDefaultModel(
    models,
    customModels,
    defaultModel,
    defaultProviderName,
  );
  let allModels = Object.values(modelTable);

  allModels = sortModelTable(allModels);

  return allModels;
}

export function isModelAvailableInServer(
  customModels: string,
  modelName: string,
  providerName: string,
) {
  return isModelNotavailableInServer(customModels, modelName, providerName);
}

/**
 * Check if the model name is a GPT-4 related model
 *
 * @param modelName The name of the model to check
 * @returns True if the model is a GPT-4 related model (excluding gpt-4o-mini)
 */
export function isGPT4Model(modelName: string): boolean {
  return (
    (modelName.startsWith("gpt-4") ||
      modelName.startsWith("chatgpt-4o") ||
      modelName.startsWith("o1")) &&
    !modelName.startsWith("gpt-4o-mini")
  );
}

/**
 * Checks if a model is not available on any of the specified providers in the server.
 *
 * @param {string} customModels - A string of custom models, comma-separated.
 * @param {string} modelName - The name of the model to check.
 * @param {string|string[]} providerNames - A string or array of provider names to check against.
 *
 * @returns {boolean} True if the model is not available on any of the specified providers, false otherwise.
 */
export function isModelNotavailableInServer(
  customModels: string,
  modelName: string,
  providerNames: string | string[],
): boolean {
  // Check DISABLE_GPT4 environment variable
  if (
    process.env.DISABLE_GPT4 === "1" &&
    isGPT4Model(modelName.toLowerCase())
  ) {
    return true;
  }

  // Seed the requested model so unqualified rules and +/-all retain their order.
  const providers = Array.isArray(providerNames)
    ? providerNames
    : [providerNames];
  return providers.every((providerName) => {
    if (!providerName) return true;
    const provider = getModelProviderInfo(providerName);
    const table = collectModelTable(
      [
        {
          name: modelName,
          available: true,
          provider,
          sorted: 0,
        },
      ],
      customModels,
    );
    return table[`${modelName}@${provider.id}`]?.available !== true;
  });
}
