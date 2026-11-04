/** @jest-environment node */
import { jest } from "@jest/globals";
import {
  readEndpointEvents,
  runEndpointChat,
} from "../app/client/endpoint-stream";
import type { Endpoint } from "../app/utils/endpoints";

const endpoint: Endpoint = {
  id: "1",
  name: "Test",
  protocol: "openai-responses",
  baseUrl: "http://127.0.0.1:9999",
  apiKey: "key",
  models: [{ name: "test" }],
};
const input = {
  model: "test",
  messages: [{ role: "user" as const, content: "Hi" }],
  stream: true,
  vision: false,
};
const encoder = new TextEncoder();
const sse = (...events: any[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events)
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

test("SSE decoder preserves multibyte characters and partial frames", async () => {
  const bytes = encoder.encode(
    'data: {"delta":"你好"}\r\n\r\ndata: [DONE]\n\n',
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 2)
        controller.enqueue(bytes.slice(i, i + 2));
      controller.close();
    },
  });
  const events: string[] = [];
  for await (const value of readEndpointEvents(body)) events.push(value);
  expect(events).toEqual(['{"delta":"你好"}', "[DONE]"]);
});

test("streamed output reaches the caller before the response ends", async () => {
  let finishStream!: () => void;
  let notifyFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    notifyFirst = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"type":"response.output_text.delta","delta":"first"}\n\n',
        ),
      );
      finishStream = () => {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_text.delta","delta":" second"}\n\n',
          ),
        );
        controller.close();
      };
    },
  });
  const updates: string[] = [];
  const finish = jest.fn();
  const work = runEndpointChat(
    endpoint,
    input,
    {
      onUpdate(message) {
        updates.push(message);
        notifyFirst();
      },
      onFinish: finish,
    },
    {},
    async () =>
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
  );
  await first;
  expect(updates).toContain("first");
  expect(finish).not.toHaveBeenCalled();
  finishStream();
  await work;
  expect(finish.mock.calls[0][0]).toBe("first second");
});

test("Responses function calls execute and continue with function output", async () => {
  const requestBodies: any[] = [];
  let count = 0;
  const requestFetch = async (_url: string, options: RequestInit = {}) => {
    requestBodies.push(JSON.parse(options.body as string));
    if (count++ === 0)
      return sse(
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "call-1",
            id: "item-1",
            name: "weather",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: '{"city":"Paris"}',
        },
      );
    return sse({ type: "response.output_text.delta", delta: "Sunny" });
  };
  const before = jest.fn(),
    after = jest.fn(),
    finish = jest.fn();
  const weather = jest.fn(async (args: any) => ({
    data: `weather for ${args.city}`,
    status: 200,
  }));
  await runEndpointChat(
    endpoint,
    input,
    { onBeforeTool: before, onAfterTool: after, onFinish: finish },
    { weather },
    requestFetch,
  );
  expect(weather).toHaveBeenCalledWith({ city: "Paris" });
  expect(before).toHaveBeenCalledTimes(1);
  expect(after).toHaveBeenCalledTimes(1);
  expect(requestBodies[1].input.slice(-2)).toEqual([
    {
      type: "function_call",
      call_id: "call-1",
      name: "weather",
      arguments: '{"city":"Paris"}',
    },
    {
      type: "function_call_output",
      call_id: "call-1",
      output: "weather for Paris",
    },
  ]);
  expect(finish.mock.calls[0][0]).toBe("Sunny");
});

test("Responses preserves reasoning items and parallel calls for continuation", async () => {
  const bodies: any[] = [];
  const reasoning = {
    type: "reasoning",
    id: "rs1",
    encrypted_content: "opaque",
    summary: [],
  };
  const call = (id: string, name: string) => ({
    type: "function_call",
    id: `item-${id}`,
    call_id: id,
    name,
    arguments: "{}",
  });
  let round = 0;
  await runEndpointChat(
    endpoint,
    { ...input, model: "o3" },
    { onFinish: jest.fn() },
    { one: async () => "1", two: async () => "2" },
    async (_url, options) => {
      bodies.push(JSON.parse(options?.body as string));
      if (round++ === 0)
        return sse(
          {
            type: "response.output_item.done",
            output_index: 0,
            item: reasoning,
          },
          {
            type: "response.output_item.done",
            output_index: 1,
            item: call("c1", "one"),
          },
          {
            type: "response.output_item.done",
            output_index: 2,
            item: call("c2", "two"),
          },
        );
      return sse({ type: "response.output_text.delta", delta: "done" });
    },
  );
  expect(bodies[0].reasoning).toEqual({ summary: "auto" });
  expect(bodies[0].include).toEqual(["reasoning.encrypted_content"]);
  expect(bodies[1].input.slice(-5)).toEqual([
    reasoning,
    call("c1", "one"),
    call("c2", "two"),
    { type: "function_call_output", call_id: "c1", output: "1" },
    { type: "function_call_output", call_id: "c2", output: "2" },
  ]);
});

test("Gemini continuation retains the model's thought signature", async () => {
  const bodies: any[] = [];
  let round = 0;
  await runEndpointChat(
    { ...endpoint, protocol: "gemini" },
    input,
    { onFinish: jest.fn() },
    { weather: async () => "sunny" },
    async (_url, options) => {
      bodies.push(JSON.parse(options?.body as string));
      if (round++ === 0)
        return sse({
          candidates: [
            {
              content: {
                parts: [
                  {
                    thoughtSignature: "sig",
                    functionCall: { name: "weather", args: { city: "Paris" } },
                  },
                ],
              },
            },
          ],
        });
      return sse({ candidates: [{ content: { parts: [{ text: "sunny" }] } }] });
    },
  );
  expect(bodies[1].contents.at(-2).parts[0]).toEqual({
    thoughtSignature: "sig",
    functionCall: { name: "weather", args: { city: "Paris" } },
  });
});

test("Anthropic continuation retains signed thinking and tool-use blocks", async () => {
  const bodies: any[] = [];
  let round = 0;
  await runEndpointChat(
    { ...endpoint, protocol: "anthropic" },
    input,
    { onFinish: jest.fn() },
    { weather: async () => "sunny" },
    async (_url, options) => {
      bodies.push(JSON.parse(options?.body as string));
      if (round++ === 0)
        return sse(
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "why" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "signed" },
          },
          {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "t1",
              name: "weather",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "input_json_delta",
              partial_json: '{"city":"Paris"}',
            },
          },
        );
      return sse({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "done" },
      });
    },
  );
  expect(bodies[1].messages.at(-2).content).toEqual([
    { type: "thinking", thinking: "why", signature: "signed" },
    { type: "tool_use", id: "t1", name: "weather", input: { city: "Paris" } },
  ]);
  expect(bodies[1].messages.at(-1).content).toEqual([
    { type: "tool_result", tool_use_id: "t1", content: "sunny" },
  ]);
});

test.each([
  ["HTTP 401", () => new Response("bad key", { status: 401 })],
  [
    "model failed",
    () =>
      sse({
        type: "response.failed",
        response: { error: { message: "model failed" } },
      }),
  ],
  ["stream error", () => sse({ type: "error", message: "stream error" })],
])("errors reach the caller: %s", async (expected, makeResponse) => {
  const errors: string[] = [];
  const finish = jest.fn();
  await runEndpointChat(
    endpoint,
    input,
    { onError: (error) => errors.push(error.message), onFinish: finish },
    {},
    async () => makeResponse(),
  );
  expect(errors[0]).toContain(expected);
  expect(finish).not.toHaveBeenCalled();
});
