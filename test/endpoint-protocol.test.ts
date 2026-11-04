import {
  buildEndpointRequest,
  createEndpointEventParser,
  extractEndpointMessage,
} from "../app/client/endpoint-protocol";
import { ThinkingStream } from "../app/utils/thinking";
import type { Endpoint, EndpointProtocol } from "../app/utils/endpoints";

const endpoint = (protocol: EndpointProtocol): Endpoint => ({
  id: "id",
  name: "Test",
  protocol,
  baseUrl: "https://example.test",
  apiKey: "secret",
  models: [],
});
const tool = {
  type: "function",
  function: {
    name: "weather",
    description: "weather",
    parameters: { type: "object" },
  },
};
const messages = [
  { role: "system" as const, content: "system" },
  {
    role: "user" as const,
    content: [
      { type: "text" as const, text: "look" },
      {
        type: "image_url" as const,
        image_url: { url: "data:image/png;base64,YWJj" },
      },
    ],
  },
];
const input = {
  model: "vision-model",
  messages,
  vision: true,
  stream: true,
  maxTokens: 1234,
  tools: [tool],
};

test("OpenAI chat builds vision and tool requests with reasoning-model token settings", () => {
  const request = buildEndpointRequest(endpoint("openai-chat"), {
    ...input,
    model: "o1-mini",
  });
  expect(request.url).toBe("https://example.test/v1/chat/completions");
  expect(request.headers.authorization).toBe("Bearer secret");
  expect(request.body.max_completion_tokens).toBe(1234);
  expect(request.body.max_tokens).toBeUndefined();
  expect(request.body.messages[1].content[1].image_url.url).toBe(
    "data:image/png;base64,YWJj",
  );
  expect(request.body.tools).toEqual([tool]);
});

test("Responses uses the documented image and function-tool shapes", () => {
  const request = buildEndpointRequest(endpoint("openai-responses"), input);
  expect(request.url).toBe("https://example.test/v1/responses");
  expect(request.body.input[1].content).toEqual([
    { type: "input_text", text: "look" },
    { type: "input_image", image_url: "data:image/png;base64,YWJj" },
  ]);
  expect(request.body.tools[0]).toEqual({ type: "function", ...tool.function });
});

test("Anthropic converts images and tools with its authentication headers", () => {
  const request = buildEndpointRequest(endpoint("anthropic"), input);
  expect(request.headers["x-api-key"]).toBe("secret");
  expect(request.headers["anthropic-version"]).toBe("2023-06-01");
  expect(request.body.system).toBe("system");
  expect(request.body.messages[0].content[1]).toEqual({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "YWJj" },
  });
  expect(request.body.tools[0].input_schema).toEqual({ type: "object" });
});

test("Gemini converts inline images and tools with its authentication header", () => {
  const request = buildEndpointRequest(endpoint("gemini"), input);
  expect(request.headers["x-goog-api-key"]).toBe("secret");
  expect(request.url).toBe(
    "https://example.test/v1beta/models/vision-model:streamGenerateContent?alt=sse",
  );
  expect(request.body.contents[0].parts.at(-1)).toEqual({
    inline_data: { mime_type: "image/png", data: "YWJj" },
  });
  expect(request.body.tools[0].functionDeclarations[0]).toEqual(tool.function);
});

test("OpenAI chat stream accumulates both reasoning variants and parallel tool fragments", () => {
  const parser = createEndpointEventParser("openai-chat");
  expect(
    parser.parse({ choices: [{ delta: { reasoning_content: "think" } }] }),
  ).toMatchObject({ isThinking: true, content: "think" });
  expect(
    parser.parse({
      choices: [{ delta: { reasoning: "more", content: "answer" } }],
    }),
  ).toMatchObject({
    isThinking: true,
    content: "more",
    followingContent: "answer",
  });
  parser.parse({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "c1",
              function: { name: "weather", arguments: '{"x":' },
            },
            { index: 1, id: "c2", function: { name: "other", arguments: "{" } },
          ],
        },
      },
    ],
  });
  parser.parse({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: "1}" } },
            { index: 1, function: { arguments: "}" } },
          ],
        },
      },
    ],
  });
  expect(
    parser.calls().map((item) => [item.id, item.function.arguments]),
  ).toEqual([
    ["c1", '{"x":1}'],
    ["c2", "{}"],
  ]);
  const stream = new ThinkingStream();
  stream.append("<think>reason</think>answer", false);
  expect(stream.endSegment()).toContain("<think>");
});

test("Responses stream handles reasoning, text, tool arguments, and failures", () => {
  const parser = createEndpointEventParser("openai-responses");
  expect(
    parser.parse({
      type: "response.reasoning_summary_text.delta",
      delta: "why",
    }),
  ).toEqual({ isThinking: true, content: "why" });
  expect(
    parser.parse({ type: "response.output_text.delta", delta: "yes" }),
  ).toEqual({ isThinking: false, content: "yes" });
  parser.parse({
    type: "response.output_item.added",
    output_index: 2,
    item: {
      type: "function_call",
      id: "item",
      call_id: "call",
      name: "weather",
      arguments: "",
    },
  });
  parser.parse({
    type: "response.function_call_arguments.delta",
    item_id: "item",
    delta: '{"x":',
  });
  parser.parse({
    type: "response.function_call_arguments.delta",
    output_index: 2,
    delta: "1}",
  });
  expect(parser.calls()[0]).toMatchObject({
    id: "call",
    function: { name: "weather", arguments: '{"x":1}' },
  });
  expect(() =>
    parser.parse({
      type: "response.failed",
      response: { error: { message: "failed" } },
    }),
  ).toThrow("failed");
  expect(() => parser.parse({ type: "error", message: "bad" })).toThrow("bad");
});

test("Anthropic and Gemini stream thinking and function calls", () => {
  const anthropic = createEndpointEventParser("anthropic");
  anthropic.parse({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "t", name: "weather" },
  });
  anthropic.parse({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: "{}" },
  });
  expect(anthropic.calls()[0].function.arguments).toBe("{}");
  expect(
    anthropic.parse({ delta: { type: "thinking_delta", thinking: "why" } }),
  ).toEqual({ isThinking: true, content: "why" });
  const gemini = createEndpointEventParser("gemini");
  expect(
    gemini.parse({
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "why" },
              { text: "yes" },
              { functionCall: { name: "weather", args: { city: "Paris" } } },
            ],
          },
        },
      ],
    }),
  ).toMatchObject({
    isThinking: true,
    content: "why",
    followingContent: "yes",
  });
  expect(gemini.calls()[0].function).toEqual({
    name: "weather",
    arguments: '{"city":"Paris"}',
  });
});

test("non-streamed Responses and Gemini retain reasoning and text", () => {
  expect(
    extractEndpointMessage("openai-responses", {
      output: [
        { type: "reasoning", summary: [{ text: "why" }] },
        { type: "message", content: [{ text: "yes" }] },
      ],
    }),
  ).toMatchObject({
    isThinking: true,
    content: "why",
    followingContent: "yes",
  });
  expect(
    extractEndpointMessage("gemini", {
      candidates: [
        {
          content: { parts: [{ thought: true, text: "why" }, { text: "yes" }] },
        },
      ],
    }),
  ).toMatchObject({
    isThinking: true,
    content: "why",
    followingContent: "yes",
  });
});
