/** @jest-environment node */
import { jest } from "@jest/globals";
import {
  clearEndpointCapabilityCache,
  runEndpointChat,
} from "../app/client/endpoint-stream";
import type { Endpoint } from "../app/utils/endpoints";
import type {
  EndpointChatInput,
  EndpointTool,
} from "../app/client/endpoint-protocol";

const endpoint: Endpoint = {
  id: "ab",
  name: "AB",
  protocol: "openai-chat",
  baseUrl: "http://localhost:9911",
  apiKey: "test",
  models: [{ name: "model" }],
};
const tool: EndpointTool = {
  type: "function",
  function: { name: "tool", parameters: { type: "object", properties: {} } },
};
const input: EndpointChatInput = {
  model: "model",
  messages: [{ role: "user", content: "question" }],
  stream: true,
  tools: [tool],
  textToolPrompt: "TEXT MCP PROMPT",
};
const encoder = new TextEncoder();
const sse = (...events: any[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const event of events)
          c.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        c.close();
      },
    }),
    { status: 200 },
  );
const answer = (text = "answer") =>
  sse({ choices: [{ delta: { content: text } }] });
const call = (args = "{}") =>
  sse({
    choices: [
      {
        delta: {
          content: "checking",
          tool_calls: [
            { index: 0, id: "c1", function: { name: "tool", arguments: args } },
          ],
        },
      },
    ],
  });

beforeEach(() => clearEndpointCapabilityCache());

test("Anthropic retries without thinking for an old model, but preserves a user effort error", async () => {
  const ep = { ...endpoint, protocol: "anthropic" as const };
  const bodies: any[] = [];
  const fetcher = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    bodies.push(body);
    return body.thinking?.type === "adaptive"
      ? new Response("thinking adaptive is unsupported", { status: 400 })
      : sse({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "done" },
        });
  };
  const finished = jest.fn();
  await runEndpointChat(
    ep,
    { ...input, tools: [] },
    { onFinish: finished },
    {},
    fetcher,
  );
  await runEndpointChat(
    ep,
    { ...input, tools: [] },
    { onFinish: finished },
    {},
    fetcher,
  );
  expect(bodies.map((body) => body.thinking)).toEqual([
    { type: "adaptive", display: "summarized" },
    undefined,
    undefined,
  ]);
  expect(finished).toHaveBeenCalledTimes(2);

  clearEndpointCapabilityCache();
  bodies.length = 0;
  const errors = jest.fn<(error: Error) => void>();
  await runEndpointChat(
    ep,
    { ...input, tools: [], reasoningEffort: "high" },
    { onFinish: jest.fn(), onError: errors },
    {},
    fetcher,
  );
  expect(bodies).toHaveLength(1);
  expect(bodies[0].output_config).toEqual({ effort: "high" });
  expect(errors.mock.calls[0][0].message).toContain(
    "thinking adaptive is unsupported",
  );
});

test.each([false, true])(
  "tool fallback does not prematurely cache reasoning rejection (reject reasoning: %s)",
  async (rejectReasoning) => {
    const ep = { ...endpoint, protocol: "openai-responses" as const };
    const bodies: any[] = [];
    const fetcher = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      bodies.push(body);
      if (body.tools) return new Response("tools unsupported", { status: 400 });
      if (rejectReasoning && body.include)
        return new Response("reasoning unsupported", { status: 400 });
      return sse({ type: "response.output_text.delta", delta: "done" });
    };
    const callbacks = { onFinish: jest.fn() };
    await runEndpointChat(ep, input, callbacks, {}, fetcher);
    await runEndpointChat(ep, input, callbacks, {}, fetcher);
    if (rejectReasoning)
      await runEndpointChat(ep, input, callbacks, {}, fetcher);
    expect(bodies.map((body) => [!!body.include, !!body.tools])).toEqual(
      rejectReasoning
        ? [
            [true, true],
            [false, true],
            [false, false],
            [true, false],
            [false, false],
            [false, false],
          ]
        : [
            [true, true],
            [false, true],
            [false, false],
            [true, false],
          ],
    );
    expect(callbacks.onFinish).toHaveBeenCalledTimes(rejectReasoning ? 3 : 2);
  },
);

test("plugin unavailability is announced once per endpoint and model until the cache is cleared", async () => {
  const notify = jest.fn();
  const fetcher = async () => answer();
  const callbacks = { onFinish: jest.fn(), onTextToolFallback: notify };
  await runEndpointChat(
    endpoint,
    { ...input, textOnly: true },
    callbacks,
    {},
    fetcher,
  );
  await runEndpointChat(
    endpoint,
    { ...input, textOnly: true, hasPlugins: true },
    callbacks,
    {},
    fetcher,
  );
  await runEndpointChat(
    endpoint,
    { ...input, textOnly: true, hasPlugins: true },
    callbacks,
    {},
    fetcher,
  );
  await runEndpointChat(
    endpoint,
    { ...input, model: "other", textOnly: true, hasPlugins: true },
    callbacks,
    {},
    fetcher,
  );
  expect(notify).toHaveBeenCalledTimes(2);
  clearEndpointCapabilityCache();
  await runEndpointChat(
    endpoint,
    { ...input, textOnly: true, hasPlugins: true },
    callbacks,
    {},
    fetcher,
  );
  expect(notify).toHaveBeenCalledTimes(3);
});

test.each([400, 404, 405, 415, 422, 501])(
  "HTTP %i with tools falls back and remembers only after success",
  async (status) => {
    const bodies: any[] = [];
    let calls = 0;
    const fetcher = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return calls++ === 0
        ? new Response("unsupported tools", { status })
        : answer();
    };
    const finish = jest.fn();
    await runEndpointChat(endpoint, input, { onFinish: finish }, {}, fetcher);
    await runEndpointChat(endpoint, input, { onFinish: finish }, {}, fetcher);
    expect(bodies.map((b) => !!b.tools)).toEqual([true, false, false]);
    expect(bodies[1].messages[0]).toEqual({
      role: "system",
      content: "TEXT MCP PROMPT",
    });
    expect(finish).toHaveBeenCalledTimes(2);
  },
);

test.each([401, 403, 429, 500, 502, 503, 599])(
  "HTTP %i does not trigger tool fallback",
  async (status) => {
    const fetcher = jest.fn(async () => new Response("failed", { status }));
    const onError = jest.fn();
    await runEndpointChat(
      endpoint,
      input,
      { onFinish: jest.fn(), onError },
      {},
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  },
);

test("network errors, missing tools, and errors after output never trigger fallback", async () => {
  const network = jest.fn(async () => {
    throw new Error("offline");
  });
  await runEndpointChat(
    endpoint,
    input,
    { onFinish: jest.fn(), onError: jest.fn() },
    {},
    network,
  );
  expect(network).toHaveBeenCalledTimes(1);
  const noTools = jest.fn(async () => new Response("bad", { status: 400 }));
  await runEndpointChat(
    endpoint,
    { ...input, tools: [] },
    { onFinish: jest.fn(), onError: jest.fn() },
    {},
    noTools,
  );
  expect(noTools).toHaveBeenCalledTimes(1);
  const afterOutput = jest.fn(async () =>
    sse(
      { choices: [{ delta: { content: "partial" } }] },
      { type: "error", error: { status: 400, message: "tools unsupported" } },
    ),
  );
  await runEndpointChat(
    endpoint,
    input,
    { onFinish: jest.fn(), onError: jest.fn() },
    {},
    afterOutput,
  );
  expect(afterOutput).toHaveBeenCalledTimes(1);
});

test("stream errors before output can fall back; a failed fallback is not remembered", async () => {
  const bodies: any[] = [];
  let count = 0;
  const fetcher = async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(init!.body as string));
    if (count++ === 0)
      return sse({
        type: "error",
        error: { status: 400, message: "tools unsupported" },
      });
    if (count === 2) return new Response("context too long", { status: 400 });
    return answer();
  };
  const errors = jest.fn();
  await runEndpointChat(
    endpoint,
    input,
    { onFinish: jest.fn(), onError: errors },
    {},
    fetcher,
  );
  await runEndpointChat(
    endpoint,
    input,
    { onFinish: jest.fn(), onError: errors },
    {},
    fetcher,
  );
  expect(bodies.map((b) => !!b.tools)).toEqual([true, false, true]);
  expect(errors).toHaveBeenCalledTimes(1);
});

test("Responses removes reasoning first, then tools, with a bounded retry and in-memory caches", async () => {
  const bodies: any[] = [];
  let count = 0;
  const fetcher = async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(init!.body as string));
    if (count++ === 0)
      return new Response("unsupported reasoning.encrypted_content", {
        status: 422,
      });
    if (count === 2) return new Response("unsupported tools", { status: 400 });
    return sse({ type: "response.output_text.delta", delta: "done" });
  };
  const ep = { ...endpoint, protocol: "openai-responses" as const };
  await runEndpointChat(
    ep,
    { ...input, model: "gpt-6.1-sol", reasoningEffort: "high" },
    { onFinish: jest.fn() },
    {},
    fetcher,
  );
  await runEndpointChat(
    ep,
    { ...input, model: "gpt-6.1-sol", reasoningEffort: "high" },
    { onFinish: jest.fn() },
    {},
    fetcher,
  );
  expect(bodies.map((b) => [!!b.include, !!b.tools])).toEqual([
    [true, true],
    [false, true],
    [false, false],
    [true, false],
  ]);
  expect(bodies[0].include).toEqual(["reasoning.encrypted_content"]);
  expect(bodies.every((body) => body.reasoning?.effort === "high")).toBe(true);
});

test.each(["openai-responses", "anthropic", "gemini"] as const)(
  "%s retries rejected default reasoning content and remembers only success",
  async (protocol) => {
    const ep = { ...endpoint, protocol };
    const bodies: any[] = [];
    let count = 0;
    const response = () =>
      protocol === "openai-responses"
        ? sse({ type: "response.output_text.delta", delta: "done" })
        : protocol === "anthropic"
        ? sse({
            type: "content_block_delta",
            delta: { type: "text_delta", text: "done" },
          })
        : sse({ candidates: [{ content: { parts: [{ text: "done" }] } }] });
    const fetcher = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return count++ === 0
        ? new Response("unsupported default thinking content", { status: 400 })
        : response();
    };
    await runEndpointChat(
      ep,
      { ...input, tools: [] },
      { onFinish: jest.fn() },
      {},
      fetcher,
    );
    await runEndpointChat(
      ep,
      { ...input, tools: [] },
      { onFinish: jest.fn() },
      {},
      fetcher,
    );
    if (protocol === "openai-responses")
      expect(bodies.map((body) => !!body.include)).toEqual([
        true,
        false,
        false,
      ]);
    if (protocol === "anthropic")
      expect(bodies.map((body) => !!body.thinking)).toEqual([
        true,
        false,
        false,
      ]);
    if (protocol === "gemini")
      expect(
        bodies.map(
          (body) => !!body.generationConfig?.thinkingConfig?.includeThoughts,
        ),
      ).toEqual([true, false, false]);
  },
);

test.each([
  [{ enableTemperature: true, temperature: 0.4 }, "temperature is unsupported"],
  [{ enableTopP: true, topP: 0.8 }, "top_p is unsupported"],
  [
    { enableMaxTokens: true, maxTokens: 1000 },
    "max_output_tokens is unsupported",
  ],
  [{ reasoningEffort: "high" }, "invalid reasoning effort"],
] as const)(
  "explicit parameter errors are shown without retries",
  async (settings, message) => {
    const fetcher = jest.fn(async () => new Response(message, { status: 400 }));
    const errors = jest.fn<(error: Error) => void>();
    await runEndpointChat(
      { ...endpoint, protocol: "openai-responses" },
      { ...input, ...settings },
      { onFinish: jest.fn(), onError: errors },
      {},
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0].message).toContain(message);
  },
);

test("Anthropic's mandatory default max_tokens error is shown without tool fallback", async () => {
  const fetcher = jest.fn(
    async () =>
      new Response("max_tokens exceeds this model's limit", { status: 400 }),
  );
  const errors = jest.fn<(error: Error) => void>();
  await runEndpointChat(
    { ...endpoint, protocol: "anthropic" },
    input,
    { onFinish: jest.fn(), onError: errors },
    {},
    fetcher,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(errors.mock.calls[0][0].message).toContain("max_tokens");
});

test("failed reasoning retry does not enter the cache; disabling the switch sends no thinking request", async () => {
  const bodies: any[] = [];
  let count = 0;
  const fetcher = async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(init!.body as string));
    if (count++ === 0)
      return new Response("reasoning unsupported", { status: 400 });
    if (count === 2) return new Response("server error", { status: 500 });
    return sse({ type: "response.output_text.delta", delta: "done" });
  };
  const ep = { ...endpoint, protocol: "openai-responses" as const };
  await runEndpointChat(
    ep,
    { ...input, tools: [] },
    { onFinish: jest.fn(), onError: jest.fn() },
    {},
    fetcher,
  );
  await runEndpointChat(
    ep,
    { ...input, tools: [] },
    { onFinish: jest.fn() },
    {},
    fetcher,
  );
  await runEndpointChat(
    ep,
    { ...input, tools: [], enableReasoningSummary: false },
    { onFinish: jest.fn() },
    {},
    fetcher,
  );
  expect(bodies.map((body) => !!body.include)).toEqual([
    true,
    false,
    true,
    false,
  ]);
});

test("native multi-round output is folded into thinking and errors are returned to the model", async () => {
  const bodies: any[] = [];
  let count = 0;
  const after = jest.fn();
  const finish = jest.fn();
  await runEndpointChat(
    endpoint,
    input,
    { onFinish: finish, onAfterTool: after },
    {
      tool: async () => ({
        __toolResult: true,
        isError: true,
        content: "not found",
      }),
    },
    async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return count++ === 0 ? call() : answer("final");
    },
  );
  expect(bodies[1].messages.at(-1)).toMatchObject({
    role: "tool",
    content: "Error: not found",
  });
  expect(after.mock.calls[0][0]).toMatchObject({
    isError: true,
    content: "not found",
  });
  expect(finish.mock.calls[0][0]).toContain("<think>\nchecking\n</think>");
  expect(finish.mock.calls[0][0]).toMatch(/final$/);
});

test("invalid OpenAI tool arguments become a tool error and a valid continuation", async () => {
  const bodies: any[] = [];
  let round = 0;
  const after = jest.fn();
  const finish = jest.fn();
  const run = jest.fn(async () => "should not run");
  await runEndpointChat(
    endpoint,
    input,
    { onFinish: finish, onAfterTool: after },
    { tool: run },
    async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return round++ === 0 ? call("{") : answer("done");
    },
  );
  expect(run).not.toHaveBeenCalled();
  expect(after.mock.calls[0][0]).toMatchObject({ isError: true });
  expect(bodies[1].messages.at(-2).tool_calls[0].function.arguments).toBe("{}");
  expect(bodies[1].messages.at(-1).content).toContain("Error:");
  expect(finish).toHaveBeenCalled();
});

test.each(["anthropic", "gemini"] as const)(
  "%s returns malformed tool arguments as an error instead of crashing",
  async (protocol) => {
    const ep = { ...endpoint, protocol };
    const requests: any[] = [];
    let round = 0;
    const badEvent =
      protocol === "anthropic"
        ? [
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "c",
                name: "tool",
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: "{" },
            },
          ]
        : [];
    // Gemini's structured event cannot represent malformed JSON; test the Anthropic
    // path directly, and a normal structured Gemini call as a control.
    if (protocol === "gemini")
      badEvent.push({
        candidates: [
          {
            content: { parts: [{ functionCall: { name: "tool", args: {} } }] },
          },
        ],
      } as any);
    const onError = jest.fn();
    const onFinish = jest.fn();
    await runEndpointChat(
      ep,
      input,
      { onFinish, onError },
      { tool: async () => "ok" },
      async (_url, init) => {
        requests.push(JSON.parse(init!.body as string));
        if (round++ === 0) return sse(...badEvent);
        return protocol === "anthropic"
          ? sse({
              type: "content_block_delta",
              delta: { type: "text_delta", text: "done" },
            })
          : sse({ candidates: [{ content: { parts: [{ text: "done" }] } }] });
      },
    );
    expect(onError).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalled();
    if (protocol === "anthropic")
      expect(JSON.stringify(requests[1])).toContain("Error:");
  },
);

test("text-only mode stops at the first completed block and returns tool errors to the model", async () => {
  let count = 0;
  const bodies: any[] = [];
  const cancel = jest.fn<() => void>(() => {});
  const finish = jest.fn();
  const after = jest.fn();
  const block =
    'Before\n```json:mcp:服务\n{"method":"tools/call","params":{"name":"lookup","arguments":{}}}\n```';
  await runEndpointChat(
    endpoint,
    {
      ...input,
      textOnly: true,
      executeTextTool: async () => {
        throw new Error("tool failed");
      },
    },
    { onFinish: finish, onAfterTool: after },
    {},
    async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      if (count++ === 0)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [
                      { delta: { content: block + " MUST NOT APPEAR" } },
                    ],
                  })}\n\n`,
                ),
              );
            },
            cancel,
          }),
        );
      return answer("final answer");
    },
  );
  expect(bodies.every((body) => !body.tools)).toBe(true);
  expect(bodies[1].messages.at(-1).content).toContain(
    "System-generated tool result, not supplied by the user",
  );
  expect(bodies[1].messages.at(-1).content).toContain("tool failed");
  expect(bodies[1].messages.at(-2).content).not.toContain("MUST NOT APPEAR");
  expect(finish.mock.calls[0][0]).not.toContain("MUST NOT APPEAR");
  expect(after.mock.calls[0][0]).toMatchObject({ isError: true });
  expect(cancel).toHaveBeenCalled();
});

test("invalid text tool JSON is reported back and does not execute", async () => {
  let round = 0;
  const execute = jest.fn(async () => ({
    __toolResult: true as const,
    content: "unexpected",
    isError: false,
  }));
  const bodies: any[] = [];
  await runEndpointChat(
    endpoint,
    { ...input, textOnly: true, executeTextTool: execute },
    { onFinish: jest.fn() },
    {},
    async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return round++ === 0 ? answer("```json:mcp:s\n{\n```") : answer("done");
    },
  );
  expect(execute).not.toHaveBeenCalled();
  expect(bodies[1].messages.at(-1).content).toContain("isError");
});

test.each(["native", "text"] as const)(
  "stopping during %s tool execution prevents results and continuation",
  async (mode) => {
    let controller!: AbortController;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let complete!: (value: any) => void;
    const pending = new Promise<any>((resolve) => {
      complete = resolve;
    });
    const fetcher = jest.fn(async () =>
      mode === "native"
        ? call()
        : answer(
            '```json:mcp:s\n{"method":"tools/call","params":{"name":"tool"}}\n```',
          ),
    );
    const after = jest.fn();
    const work = runEndpointChat(
      endpoint,
      {
        ...input,
        textOnly: mode === "text",
        executeTextTool: async () => pending,
      },
      {
        onController: (c) => {
          controller = c;
        },
        onBeforeTool: started,
        onAfterTool: after,
        onFinish: jest.fn(),
      },
      { tool: async () => pending },
      fetcher,
    );
    await startedPromise;
    controller.abort();
    await work;
    complete({ __toolResult: true, content: "late", isError: false });
    await Promise.resolve();
    expect(after).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test("tool loops stop at sixteen rounds", async () => {
  const fetcher = jest.fn(async () => call());
  const error = jest.fn<(error: Error) => void>();
  await runEndpointChat(
    endpoint,
    input,
    { onFinish: jest.fn(), onError: error },
    { tool: async () => "ok" },
    fetcher,
  );
  expect(fetcher).toHaveBeenCalledTimes(16);
  expect(error.mock.calls[0][0].message).toContain("Too many");
});
