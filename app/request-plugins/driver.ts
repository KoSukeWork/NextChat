import type { ChatOptions, RequestMessage } from "../client/api";
import type { Endpoint } from "../utils/endpoints";
import { endpointFetch } from "../utils/endpoint-transport";
import { ThinkingStream, stripThinkingFromMessages } from "../utils/thinking";
import { createPluginSession } from "./host";
import type { DriverEvent } from "./sdk";
import { nanoid } from "nanoid";

/** Consume SDK v1 NDJSON. A clean EOF is not a successful generation without done. */
export async function consumeDriverResponse(
  response: Response,
  options: ChatOptions,
  signal: AbortSignal,
) {
  if (!response.ok)
    throw new Error(
      `Client driver HTTP ${response.status}: ${await response.text()}`,
    );
  if (!response.body) throw new Error("Client driver returned no stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const thinking = new ThinkingStream();
  const tools = new Map<
    string,
    {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }
  >();
  let buffer = "",
    message = "",
    done = false;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const event = (line: string) => {
    if (!line.trim()) return;
    const value = JSON.parse(line) as DriverEvent;
    if (value.type === "error") throw new Error(value.message);
    if (value.type === "text" || value.type === "thinking") {
      if (typeof value.text !== "string")
        throw new Error("Invalid client driver text event");
      message = thinking.append(value.text, value.type === "thinking");
      options.onUpdate?.(message, value.text, value.type === "thinking");
    } else if (value.type === "tool_start") {
      const call = {
        id: value.id,
        type: "function" as const,
        function: {
          name: value.name,
          arguments: JSON.stringify(value.input ?? {}),
        },
      };
      tools.set(value.id, call);
      options.onBeforeTool?.(call);
    } else if (value.type === "tool_end") {
      const call = tools.get(value.id);
      if (call)
        options.onAfterTool?.({
          ...call,
          content: value.content,
          isError: value.isError,
          errorMsg: value.isError ? value.content : undefined,
        });
    } else if (value.type === "done") done = true;
  };
  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    while (!done) {
      const chunk = await reader.read();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let index;
      while (!done && (index = buffer.indexOf("\n")) >= 0) {
        event(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      if (buffer.length > 4 * 1024 * 1024)
        throw new Error("Client driver event exceeded the size limit");
      if (chunk.done) {
        if (!done && buffer.trim()) event(buffer);
        break;
      }
    }
    if (!done) throw new Error("Client driver disconnected before completion");
    message = thinking.endSegment();
    options.onFinish(message, response);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function runPluginDriver(
  endpoint: Endpoint,
  messages: RequestMessage[],
  options: ChatOptions,
): Promise<boolean> {
  if (!endpoint.requestPlugin) return false;
  const controller = new AbortController();
  options.onController?.(controller);
  const plugin = createPluginSession(
    endpoint,
    options.sessionId ?? nanoid(),
    "chat",
  );
  try {
    const canonical = stripThinkingFromMessages(messages).map(
      ({ role, content }) => ({ role, content }),
    );
    const request = await plugin!.chat(
      {
        messages: canonical,
        model: options.config.model,
        enableTools: !!options.enableTools,
        reasoningEffort: options.config.reasoningEffort,
      },
      controller.signal,
    );
    if (!request) return false;
    const response = await endpointFetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
      redirect: "manual",
    });
    await consumeDriverResponse(response, options, controller.signal);
    return true;
  } finally {
    await plugin?.dispose();
  }
}
