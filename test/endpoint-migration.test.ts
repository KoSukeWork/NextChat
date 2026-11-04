import { migrateLegacyEndpoints } from "../app/utils/legacy-endpoint-migration";
import { endpointUrl } from "../app/utils/endpoints";

test("migrates real saved models, custom address and keys without changing the source", () => {
  const config = {
    models: [
      {
        name: "deepseek-v4.1-flash",
        displayName: "DeepSeek flash",
        provider: { id: "openai", providerName: "OpenAI" },
        available: true,
      },
      {
        name: "claude-custom",
        provider: { id: "anthropic", providerName: "Anthropic" },
        available: true,
      },
    ],
    customModels: "+other-model@OpenAI,+second@Anthropic",
    modelConfig: {
      model: "deepseek-v4.1-flash",
      providerName: "OpenAI",
      compressModel: "claude-custom",
      compressProviderName: "Anthropic",
    },
  };
  const access = {
    provider: "OpenAI",
    openaiUrl: "https://gateway.example/custom/v1",
    openaiApiKey: "secret-openai",
    anthropicUrl: "https://api.anthropic.com",
    anthropicApiKey: "secret-anthropic",
    baiduUrl: "https://aip.baidubce.com",
    baiduApiKey: "secret-baidu",
    baiduSecretKey: "secret-baidu-secret",
  };
  const original = JSON.stringify({ config, access });
  let nextId = 0;
  const migrated = migrateLegacyEndpoints(
    config,
    access,
    () => `endpoint-${++nextId}`,
  );
  expect(migrated.endpoints.map((item) => item.name)).toEqual([
    "OpenAI",
    "Anthropic",
  ]);
  expect(migrated.endpoints[0]).toMatchObject({
    id: "endpoint-1",
    baseUrl: "https://gateway.example/custom/v1",
    apiKey: "secret-openai",
    protocol: "openai-chat",
  });
  expect(migrated.endpoints[0].models).toEqual([
    { name: "deepseek-v4.1-flash", displayName: "DeepSeek flash" },
    { name: "other-model" },
  ]);
  expect(migrated.endpoints[1].models.map((m) => m.name)).toEqual([
    "claude-custom",
    "second",
  ]);
  expect(migrated.defaultModel).toEqual({
    model: "deepseek-v4.1-flash",
    endpointId: "endpoint-1",
  });
  expect(migrated.compressModel).toEqual({
    model: "claude-custom",
    endpointId: "endpoint-2",
  });
  expect(migrated.unsupported).toEqual(["Baidu"]);
  expect(JSON.stringify({ config, access })).toBe(original);
});

test("migrates special compatible endpoints to their correct protocol paths", () => {
  const result = migrateLegacyEndpoints(
    { models: [] },
    {
      deepseekApiKey: "a",
      chatglmApiKey: "b",
      bytedanceApiKey: "c",
      deepseekUrl: "https://api.deepseek.com",
      chatglmUrl: "https://open.bigmodel.cn",
      bytedanceUrl: "https://ark.cn-beijing.volces.com/api/",
    },
  );
  const url = (name: string) =>
    endpointUrl(result.endpoints.find((e) => e.name === name)!, "chat");
  expect(url("DeepSeek")).toBe("https://api.deepseek.com/v1/chat/completions");
  expect(url("ChatGLM")).toBe(
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  );
  expect(url("ByteDance")).toBe(
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
  );
});

test("custom URLs without keys migrate; default URLs and old relative proxies do not", () => {
  const result = migrateLegacyEndpoints(
    {},
    {
      openaiUrl: "https://api.openai.com",
      anthropicUrl: "/api/anthropic",
      googleUrl: "https://custom.example/v1beta",
      azureUrl: "https://old.example/openai",
    },
  );
  expect(result.endpoints.map((item) => item.name)).toEqual(["Google"]);
  expect(result.unsupported).toEqual(["Azure"]);
});

test("already migrated endpoint data is left intact", () => {
  const endpoints = [
    {
      id: "kept",
      name: "Manual",
      protocol: "openai-chat",
      baseUrl: "https://example.test",
      apiKey: "key",
      models: [{ name: "m" }],
    },
  ];
  const result = migrateLegacyEndpoints(
    { endpoints, modelConfig: { model: "m", endpointId: "kept" } },
    { openaiApiKey: "old" },
    () => {
      throw new Error("must not create id");
    },
  );
  expect(result.endpoints).toBe(endpoints);
  expect(result.defaultModel).toEqual({ model: "m", endpointId: "kept" });
});
