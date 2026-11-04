import type { Endpoint } from "../utils/endpoints";
import { endpointFetch } from "../utils/endpoint-transport";
import { ThinkingStream } from "../utils/thinking";
import {
  buildEndpointRequest,
  createEndpointEventParser,
  extractEndpointMessage,
} from "./endpoint-protocol";
import type { EndpointCall, EndpointChatInput } from "./endpoint-protocol";

type EndpointCallbacks = {
  onUpdate?: (message: string, chunk: string, thinkingActive?: boolean) => void;
  onFinish: (message: string, response: Response) => void;
  onError?: (error: Error) => void;
  onController?: (controller: AbortController) => void;
  onBeforeTool?: (tool: EndpointCall) => void;
  onAfterTool?: (
    tool: EndpointCall & {
      content?: string;
      isError?: boolean;
      errorMsg?: string;
    },
  ) => void;
};

function waitForAbortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Decode SSE frames across arbitrary network and UTF-8 chunk boundaries. */
export async function* readEndpointEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const payload = (frame: string) =>
    frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
  try {
    while (true) {
      const { done, value } = await waitForAbortable(reader.read(), signal);
      buffer += decoder.decode(value, { stream: !done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = payload(frame);
        if (data) yield data;
      }
      if (done) break;
    }
    const remaining = payload(buffer);
    if (remaining) yield remaining;
  } finally {
    if (signal?.aborted) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function appendToolResults(
  endpoint: Endpoint,
  body: Record<string, any>,
  calls: EndpointCall[],
  results: string[],
  outputItems: Record<string, any>[],
) {
  if (endpoint.protocol === "openai-chat") {
    body.messages.push(
      { role: "assistant", content: null, tool_calls: calls },
      ...calls.map((call, index) => ({
        role: "tool",
        tool_call_id: call.id,
        content: results[index],
      })),
    );
  } else if (endpoint.protocol === "openai-responses") {
    body.input.push(...outputItems);
    const includedCalls = new Set(
      outputItems
        .filter((item) => item.type === "function_call")
        .map((item) => item.call_id),
    );
    for (const call of calls) {
      if (!includedCalls.has(call.id))
        body.input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments || "{}",
        });
    }
    for (let index = 0; index < calls.length; index++) {
      body.input.push({
        type: "function_call_output",
        call_id: calls[index].id,
        output: results[index],
      });
    }
  } else if (endpoint.protocol === "anthropic") {
    const includedCalls = new Set<string>();
    const blocks = outputItems.map((item) => {
      if (item.type !== "tool_use") return item;
      const call = calls.find((entry) => entry.id === item.id);
      if (!call) return item;
      includedCalls.add(call.id);
      return { ...item, input: JSON.parse(call.function.arguments || "{}") };
    });
    blocks.push(
      ...calls
        .filter((call) => !includedCalls.has(call.id))
        .map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments || "{}"),
        })),
    );
    body.messages.push(
      {
        role: "assistant",
        content: blocks,
      },
      {
        role: "user",
        content: calls.map((call, index) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: results[index],
        })),
      },
    );
  } else {
    body.contents.push(
      {
        role: "model",
        parts: calls.map((call) => ({
          functionCall: {
            name: call.function.name,
            args: JSON.parse(call.function.arguments || "{}"),
          },
          ...(call.thoughtSignature
            ? { thoughtSignature: call.thoughtSignature }
            : {}),
        })),
      },
      {
        role: "user",
        parts: calls.map((call, index) => ({
          functionResponse: {
            name: call.function.name,
            response: { content: results[index] },
          },
        })),
      },
    );
  }
}

async function runTools(
  calls: EndpointCall[],
  callbacks: EndpointCallbacks,
  funcs: Record<string, Function>,
): Promise<string[]> {
  return Promise.all(
    calls.map(async (call) => {
      callbacks.onBeforeTool?.(call);
      try {
        const run = funcs[call.function.name];
        if (!run) throw new Error(`Unknown tool: ${call.function.name}`);
        const result = await run(JSON.parse(call.function.arguments || "{}"));
        if (typeof result?.status === "number" && result.status >= 300)
          throw new Error(
            String(result?.statusText || result?.data || result.status),
          );
        const value = result?.data ?? result?.statusText ?? result;
        const content =
          typeof value === "string" ? value : JSON.stringify(value ?? "");
        callbacks.onAfterTool?.({ ...call, content, isError: false });
        return content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        callbacks.onAfterTool?.({ ...call, isError: true, errorMsg: message });
        return message;
      }
    }),
  );
}

export async function runEndpointChat(
  endpoint: Endpoint,
  input: EndpointChatInput,
  callbacks: EndpointCallbacks,
  funcs: Record<string, Function> = {},
  requestFetch: typeof endpointFetch = endpointFetch,
) {
  const controller = new AbortController();
  callbacks.onController?.(controller);
  const thinking = new ThinkingStream();
  let latest = "";
  let lastResponse: Response | undefined;
  const append = (chunk: {
    isThinking: boolean;
    content?: string;
    followingContent?: string;
  }) => {
    if (chunk.content)
      latest = thinking.append(chunk.content, chunk.isThinking);
    if (chunk.followingContent)
      latest = thinking.append(chunk.followingContent, false);
    if (chunk.content || chunk.followingContent)
      callbacks.onUpdate?.(
        latest,
        chunk.followingContent || chunk.content || "",
        thinking.isThinking(),
      );
  };
  try {
    const { url, headers, body } = buildEndpointRequest(endpoint, input);
    for (let round = 0; round < 16; round++) {
      const timeout = setTimeout(
        () => controller.abort(),
        input.timeoutMs ?? 60000,
      );
      try {
        lastResponse = await waitForAbortable(
          requestFetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          }),
          controller.signal,
        );
      } finally {
        clearTimeout(timeout);
      }
      if (!lastResponse.ok) {
        const details = await lastResponse.text();
        throw new Error(
          `HTTP ${lastResponse.status}${details ? `: ${details}` : ""}`,
        );
      }
      if (!input.stream) {
        const data = await lastResponse.json();
        if (data?.error)
          throw new Error(data.error.message ?? JSON.stringify(data.error));
        append(extractEndpointMessage(endpoint.protocol, data));
        latest = thinking.endSegment();
        callbacks.onFinish(latest, lastResponse);
        return;
      }
      if (!lastResponse.body)
        throw new Error("Endpoint returned an empty stream");
      const parser = createEndpointEventParser(endpoint.protocol);
      for await (const data of readEndpointEvents(
        lastResponse.body,
        controller.signal,
      )) {
        if (data === "[DONE]") break;
        append(parser.parse(JSON.parse(data)));
      }
      latest = thinking.endSegment();
      const calls = parser.calls();
      if (!calls.length) {
        callbacks.onFinish(latest, lastResponse);
        return;
      }
      const results = await waitForAbortable(
        runTools(
          calls,
          {
            ...callbacks,
            onAfterTool: (tool) => {
              if (!controller.signal.aborted) callbacks.onAfterTool?.(tool);
            },
          },
          funcs,
        ),
        controller.signal,
      );
      appendToolResults(endpoint, body, calls, results, parser.outputItems());
    }
    throw new Error("Too many consecutive tool calls");
  } catch (error) {
    if (controller.signal.aborted) {
      callbacks.onFinish(
        thinking.endSegment(),
        lastResponse ?? new Response(null, { status: 499 }),
      );
    } else
      callbacks.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
  }
}
