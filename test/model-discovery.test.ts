import { jest } from "@jest/globals";
import { getClientApi } from "../app/client/api";
import { ServiceProvider, DEFAULT_MODELS } from "../app/constant";
import { useAccessStore, useAppConfig, useChatStore } from "../app/store";
import {
  collectModels,
  getModelProviderInfo,
  isModelNotavailableInServer,
} from "../app/utils/model";
import {
  discoveredModels,
  ModelDiscoveryUnsupportedError,
} from "../app/client/models";

const mockedFetch = jest.mocked(global.fetch);
function respond(body: unknown, status = 200) {
  mockedFetch.mockResolvedValueOnce({
    ok: status < 400,
    status,
    statusText: "Failure",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

beforeEach(() => {
  mockedFetch.mockClear();
  useAppConfig.getState().reset();
  useAccessStore.setState({
    fetch: () => {},
    useCustomConfig: false,
    openaiApiKey: "openai-test",
    anthropicApiKey: "anthropic-test",
    googleApiKey: "google-test",
  });
});

test("starts with no built-in chat models", () => {
  expect(DEFAULT_MODELS).toEqual([]);
  expect(useAppConfig.getState().models).toEqual([]);
  expect(useAppConfig.getState().modelConfig.model).toBe("");
});

test.each(
  Object.values(ServiceProvider).filter((p) => p !== ServiceProvider.Stability),
)("normalizes provider %s without built-in models", (provider) => {
  const models = collectModels([], `sample@${provider.toLowerCase()}`);
  expect(models[0].provider?.providerName).toBe(provider);
});

test("uses the selected provider for unqualified models and preserves aliases", () => {
  expect(
    collectModels([], "custom=Display", ServiceProvider.Anthropic)[0],
  ).toMatchObject({
    name: "custom",
    displayName: "Display",
    provider: { providerName: "Anthropic" },
  });
  expect(collectModels([], "custom")[0].provider?.providerName).toBe("OpenAI");
  expect(getModelProviderInfo("ai302").providerName).toBe("302.AI");
});

test("server allows unlisted models unless -all is set and respects ordered overrides", () => {
  expect(isModelNotavailableInServer("other", "custom", "Anthropic")).toBe(
    false,
  );
  expect(isModelNotavailableInServer("-all", "custom", "Anthropic")).toBe(true);
  expect(
    isModelNotavailableInServer("-all,custom@anthropic", "custom", "Anthropic"),
  ).toBe(false);
  expect(isModelNotavailableInServer("-custom", "custom", "Anthropic")).toBe(
    true,
  );
  expect(isModelNotavailableInServer("-all,+all", "custom", "Anthropic")).toBe(
    false,
  );
});

test("replaces only the selected provider and allows clearing it", () => {
  const store = useAppConfig.getState();
  store.setProviderModels("openai", discoveredModels(["a"], "OpenAI"));
  store.setProviderModels("anthropic", discoveredModels(["b"], "Anthropic"));
  store.setProviderModels("openai", []);
  expect(useAppConfig.getState().models.map((m) => m.name)).toEqual(["b"]);
});

test("4.2 migration removes persisted catalog and merge cannot revive it", async () => {
  const options = useAppConfig.persist.getOptions();
  const state = {
    ...useAppConfig.getState(),
    models: discoveredModels(["old"], "OpenAI"),
  };
  const migrated = await options.migrate!(state, 4.1);
  expect(options.merge!(migrated, useAppConfig.getState()).models).toEqual([]);
});

test("OpenAI discovery retains arbitrary gateway IDs", async () => {
  respond({ data: [{ id: "vendor/custom" }, { id: "gpt-4" }] });
  const models = await getClientApi(ServiceProvider.OpenAI).llm.models();
  expect(models.map((m) => m.name)).toEqual(["vendor/custom", "gpt-4"]);
  expect(mockedFetch.mock.calls[0][0]).toContain("v1/models");
});

test("discovery uses selected-provider authentication independently of chat", async () => {
  useChatStore.getState().currentSession().mask.modelConfig.providerName =
    ServiceProvider.OpenAI;
  respond({ data: [{ id: "claude-test" }], has_more: false });
  await getClientApi(ServiceProvider.Anthropic).llm.models();
  const headers = mockedFetch.mock.calls[0][1]?.headers;
  expect(headers).toMatchObject({
    "x-api-key": "anthropic-test",
    "anthropic-version": "2023-06-01",
  });
  expect(headers).not.toHaveProperty("Authorization");
});

test("Google discovery filters generation methods and follows pagination", async () => {
  respond({
    models: [
      { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
    ],
    nextPageToken: "next",
  });
  respond({
    models: [
      {
        name: "models/gemini-test",
        supportedGenerationMethods: ["generateContent"],
      },
    ],
  });
  expect(
    (await getClientApi(ServiceProvider.Google).llm.models()).map(
      (m) => m.name,
    ),
  ).toEqual(["gemini-test"]);
  expect(mockedFetch.mock.calls[1][0]).toContain("pageToken=next");
});

test("HTTP failures include status and server error", async () => {
  respond({ error: { message: "Unauthorized" } }, 401);
  await expect(
    getClientApi(ServiceProvider.OpenAI).llm.models(),
  ).rejects.toThrow("HTTP 401");
});

test.each([
  ServiceProvider.Azure,
  ServiceProvider.Baidu,
  ServiceProvider.ByteDance,
  ServiceProvider.Alibaba,
  ServiceProvider.Tencent,
  ServiceProvider.Iflytek,
  ServiceProvider.ChatGLM,
])("unsupported discovery for %s makes no request", async (provider) => {
  await expect(getClientApi(provider).llm.models()).rejects.toBeInstanceOf(
    ModelDiscoveryUnsupportedError,
  );
  expect(mockedFetch).not.toHaveBeenCalled();
});

test.each([
  [ServiceProvider.SiliconFlow, "sub_type", "chat"],
  [ServiceProvider["302.AI"], "llm", "1"],
])(
  "%s discovery requests only chat models",
  async (provider, parameter, value) => {
    respond({ data: [{ id: "chat-model" }] });
    await getClientApi(provider as ServiceProvider).llm.models();
    const url = new URL(
      String(mockedFetch.mock.calls[0][0]),
      "http://localhost",
    );
    expect(url.searchParams.get(parameter)).toBe(value);
  },
);
