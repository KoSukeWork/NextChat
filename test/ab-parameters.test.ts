import { buildEndpointRequest } from "../app/client/endpoint-protocol";
import type { EndpointChatInput } from "../app/client/endpoint-protocol";
import type { Endpoint, EndpointProtocol } from "../app/utils/endpoints";

const endpoint = (protocol: EndpointProtocol): Endpoint => ({
  id: "ep",
  name: "test",
  protocol,
  baseUrl: "https://example.test",
  apiKey: "",
  models: [],
});
const input: EndpointChatInput = {
  model: "gpt-6.1-sol",
  messages: [{ role: "user", content: "hello" }],
  stream: true,
  temperature: 0.4,
  topP: 0.8,
  maxTokens: 1234,
  presencePenalty: 0.1,
  frequencyPenalty: 0.2,
};

test.each([
  [
    "openai-chat",
    {
      model: "gpt-6.1-sol",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    },
  ],
  [
    "openai-responses",
    {
      model: "gpt-6.1-sol",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      reasoning: { summary: "auto" },
      include: ["reasoning.encrypted_content"],
    },
  ],
  [
    "anthropic",
    {
      model: "gpt-6.1-sol",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      max_tokens: 16000,
      thinking: { type: "adaptive", display: "summarized" },
    },
  ],
  [
    "gemini",
    {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: { thinkingConfig: { includeThoughts: true } },
    },
  ],
] as const)(
  "%s defaults to required fields plus requested reasoning content",
  (protocol, expected) => {
    expect(buildEndpointRequest(endpoint(protocol), input).body).toEqual(
      expected,
    );
  },
);

test.each(["openai-chat", "openai-responses", "anthropic", "gemini"] as const)(
  "%s sends only each enabled supported setting",
  (protocol) => {
    const base = buildEndpointRequest(endpoint(protocol), {
      ...input,
      enableReasoningSummary: false,
    }).body;
    const cases: [keyof EndpointChatInput, string | null, unknown][] = [
      ["enableTemperature", "temperature", 0.4],
      ["enableTopP", protocol === "gemini" ? "topP" : "top_p", 0.8],
      [
        "enableMaxTokens",
        protocol === "gemini"
          ? "maxOutputTokens"
          : protocol === "openai-responses"
          ? "max_output_tokens"
          : "max_tokens",
        1234,
      ],
      [
        "enablePresencePenalty",
        protocol === "gemini"
          ? "presencePenalty"
          : protocol === "openai-chat"
          ? "presence_penalty"
          : null,
        0.1,
      ],
      [
        "enableFrequencyPenalty",
        protocol === "gemini"
          ? "frequencyPenalty"
          : protocol === "openai-chat"
          ? "frequency_penalty"
          : null,
        0.2,
      ],
    ];
    for (const [flag, field, value] of cases) {
      const body = buildEndpointRequest(endpoint(protocol), {
        ...input,
        enableReasoningSummary: false,
        [flag]: true,
      }).body;
      if (!field) {
        expect(body).toEqual(base);
        continue;
      }
      const expected = JSON.parse(JSON.stringify(base));
      if (protocol === "gemini") expected.generationConfig = { [field]: value };
      else expected[field] = value;
      expect(body).toEqual(expected);
    }
    if (protocol === "gemini") expect(base.generationConfig).toBeUndefined();
  },
);

test("OpenAI Chat model-name heuristic only selects the enabled token field", () => {
  const ordinary = buildEndpointRequest(endpoint("openai-chat"), {
    ...input,
    enableMaxTokens: true,
    enableTemperature: true,
  }).body;
  expect(ordinary).toMatchObject({ max_tokens: 1234, temperature: 0.4 });
  const reasoning = buildEndpointRequest(endpoint("openai-chat"), {
    ...input,
    model: "gpt-5-test",
    enableMaxTokens: true,
    enableTemperature: true,
  }).body;
  expect(reasoning).toMatchObject({
    max_completion_tokens: 1234,
    temperature: 0.4,
  });
  expect(reasoning.max_tokens).toBeUndefined();
});

test.each([
  ["openai-chat", { reasoning_effort: "HiGh" }, { reasoning_effort: "512" }],
  [
    "openai-responses",
    { reasoning: { effort: "HiGh" } },
    { reasoning: { effort: "512" } },
  ],
  [
    "anthropic",
    { output_config: { effort: "HiGh" }, thinking: { type: "adaptive" } },
    { thinking: { type: "enabled", budget_tokens: 512 } },
  ],
  [
    "gemini",
    { generationConfig: { thinkingConfig: { thinkingLevel: "HiGh" } } },
    { generationConfig: { thinkingConfig: { thinkingBudget: 512 } } },
  ],
] as const)(
  "%s forwards free-form effort and numeric budget without guessing",
  (protocol, level, budget) => {
    const base = buildEndpointRequest(endpoint(protocol), {
      ...input,
      enableReasoningSummary: false,
    }).body;
    expect(
      buildEndpointRequest(endpoint(protocol), {
        ...input,
        enableReasoningSummary: false,
        reasoningEffort: "  HiGh  ",
      }).body,
    ).toEqual({ ...base, ...level });
    expect(
      buildEndpointRequest(endpoint(protocol), {
        ...input,
        enableReasoningSummary: false,
        reasoningEffort: "512",
      }).body,
    ).toEqual({ ...base, ...budget });
  },
);

test("reasoning summary retry removes only summary fields and keeps the user's effort", () => {
  const response = buildEndpointRequest(endpoint("openai-responses"), {
    ...input,
    reasoningEffort: "high",
    reasoningEnabled: false,
  }).body;
  expect(response.reasoning).toEqual({ effort: "high" });
  expect(response.include).toBeUndefined();
  const anthropic = buildEndpointRequest(endpoint("anthropic"), {
    ...input,
    reasoningEffort: "1024",
    reasoningEnabled: false,
  }).body;
  expect(anthropic.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  const gemini = buildEndpointRequest(endpoint("gemini"), {
    ...input,
    reasoningEffort: "high",
    reasoningEnabled: false,
  }).body;
  expect(gemini.generationConfig.thinkingConfig).toEqual({
    thinkingLevel: "high",
  });
});

test("Anthropic omits thinking after retry without effort, but retains a word or numeric effort", () => {
  const build = (reasoningEffort: string) =>
    buildEndpointRequest(endpoint("anthropic"), {
      ...input,
      reasoningEffort,
      reasoningEnabled: false,
    }).body;
  expect(build("").thinking).toBeUndefined();
  expect(build("high")).toMatchObject({
    output_config: { effort: "high" },
    thinking: { type: "adaptive" },
  });
  expect(build("1024").thinking).toEqual({
    type: "enabled",
    budget_tokens: 1024,
  });
});
