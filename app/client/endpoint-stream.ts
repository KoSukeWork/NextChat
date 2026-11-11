import type { Endpoint } from "../utils/endpoints";
import { endpointFetch } from "../utils/endpoint-transport";
import { parseThinking, ThinkingStream } from "../utils/thinking";
import { nativeNetworkErrorMessage } from "../utils/network-error";
import Locale from "../locales";
import { findMcpCall } from "../mcp/utils";
import type { ToolResult } from "../mcp/tool-runtime";
import { nanoid } from "nanoid";
import { createPluginSession } from "../request-plugins/host";
import {
  buildEndpointRequest,
  createEndpointEventParser,
  extractEndpointMessage,
  EndpointStreamError,
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
  onTextToolFallback?: () => void;
  onToolModeChange?: (mode: "native" | "text") => void;
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
  let finished = false;
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
      if (done) {
        finished = true;
        break;
      }
    }
    const remaining = payload(buffer);
    if (remaining) yield remaining;
  } finally {
    if (!finished || signal?.aborted) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseArguments(raw: string): any {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function validArguments(raw: string): string {
  try {
    JSON.parse(raw || "{}");
    return raw || "{}";
  } catch {
    return "{}";
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
      {
        role: "assistant",
        content: null,
        tool_calls: calls.map((call) => ({
          ...call,
          function: {
            ...call.function,
            arguments: validArguments(call.function.arguments),
          },
        })),
      },
      ...calls.map((call, index) => ({
        role: "tool",
        tool_call_id: call.id,
        content: results[index],
      })),
    );
  } else if (endpoint.protocol === "openai-responses") {
    body.input.push(
      ...outputItems.map((item) =>
        item.type === "function_call"
          ? { ...item, arguments: validArguments(item.arguments ?? "") }
          : item,
      ),
    );
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
          arguments: validArguments(call.function.arguments),
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
      return { ...item, input: parseArguments(call.function.arguments) };
    });
    blocks.push(
      ...calls
        .filter((call) => !includedCalls.has(call.id))
        .map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: parseArguments(call.function.arguments),
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
            args: parseArguments(call.function.arguments),
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
  display: EndpointChatInput["toolDisplay"],
): Promise<string[]> {
  return Promise.all(
    calls.map(async (call) => {
      const shown = { ...call, display: display?.[call.function.name] };
      callbacks.onBeforeTool?.(shown);
      try {
        const run = funcs[call.function.name];
        if (!run) throw new Error(`Unknown tool: ${call.function.name}`);
        const result = await run(JSON.parse(call.function.arguments || "{}"));
        if (result?.__toolResult === true) {
          const value = result as ToolResult;
          callbacks.onAfterTool?.({
            ...shown,
            content: value.content,
            isError: value.isError,
            errorMsg: value.isError ? value.content : undefined,
          });
          return value.isError ? `Error: ${value.content}` : value.content;
        }
        if (typeof result?.status === "number" && result.status >= 300)
          throw new Error(
            String(result?.statusText || result?.data || result.status),
          );
        const value = result?.data ?? result?.statusText ?? result;
        const content =
          typeof value === "string" ? value : JSON.stringify(value ?? "");
        callbacks.onAfterTool?.({ ...shown, content, isError: false });
        return content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        callbacks.onAfterTool?.({ ...shown, isError: true, errorMsg: message });
        return `Error: ${message}`;
      }
    }),
  );
}

const textOnlyModels = new Set<string>();
const noReasoningModels = new Set<string>();
const notifiedTextModels = new Set<string>();
const toolFallbackStatuses = new Set([400, 404, 405, 415, 422, 501]);

function mentionsUserParameter(
  message: string,
  input: EndpointChatInput,
  endpoint: Endpoint,
): boolean {
  // Anthropic requires this field even when the user leaves its switch off.
  if (endpoint.protocol === "anthropic" && /max[_-]?tokens/i.test(message))
    return true;
  const checks: [boolean | undefined, RegExp][] = [
    [input.enableTemperature, /\btemperature\b/i],
    [input.enableTopP, /\btop[_-]?p\b/i],
    [
      input.enableMaxTokens,
      /max[_-]?(?:completion[_-]?|output[_-]?)?tokens|maxOutputTokens/i,
    ],
    [input.enablePresencePenalty, /presence[_-]?penalty/i],
    [input.enableFrequencyPenalty, /frequency[_-]?penalty/i],
  ];
  if (
    checks.some(
      ([enabled, pattern]) => enabled === true && pattern.test(message),
    )
  )
    return true;
  if (input.reasoningEffort?.trim()) {
    if (
      /effort|output[_-]?config|thinking[_-]?level|thinkingLevel|thinkingBudget|budget[_-]?tokens/i.test(
        message,
      )
    )
      return true;
    if (
      /\b(reasoning|thinking|thinkingConfig)\b/i.test(message) &&
      !/display|summary|includeThoughts|encrypted_content|\binclude\b/i.test(
        message,
      )
    )
      return true;
  }
  return false;
}

/** The cache is deliberately process-local; it is never persisted to settings. */
export function clearEndpointCapabilityCache() {
  textOnlyModels.clear();
  noReasoningModels.clear();
  notifiedTextModels.clear();
}

function appendTextToolResult(
  endpoint: Endpoint,
  body: Record<string, any>,
  assistant: string,
  clientId: string,
  result: string,
  isError: boolean,
) {
  const data = JSON.stringify({ content: result, isError }).replace(
    /`/g,
    "\\u0060",
  );
  const content = `System-generated tool result, not supplied by the user:\n\`\`\`json:mcp-response:${clientId}\n${data}\n\`\`\``;
  if (endpoint.protocol === "openai-chat")
    body.messages.push(
      { role: "assistant", content: assistant },
      { role: "user", content },
    );
  else if (endpoint.protocol === "openai-responses")
    body.input.push(
      { role: "assistant", content: assistant },
      { role: "user", content },
    );
  else if (endpoint.protocol === "anthropic")
    body.messages.push(
      { role: "assistant", content: assistant },
      { role: "user", content },
    );
  else
    body.contents.push(
      { role: "model", parts: [{ text: assistant }] },
      { role: "user", parts: [{ text: content }] },
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
  const committed = new ThinkingStream();
  let latest = "";
  let lastResponse: Response | undefined;
  let committedValue = "";
  const key = JSON.stringify([
    endpoint.id,
    endpoint.protocol,
    endpoint.baseUrl,
    input.model,
    endpoint.requestPlugin ?? null,
  ]);
  let textMode =
    !!input.textOnly || (!!input.tools?.length && textOnlyModels.has(key));
  let reasoning =
    endpoint.protocol !== "openai-chat" &&
    input.enableReasoningSummary !== false &&
    !noReasoningModels.has(key) &&
    input.reasoningEnabled !== false;
  let pendingTextCache = false;
  let pendingReasoningCache = false;
  let retriedText = false;
  let retriedReasoning = false;
  let hasOutput = false;
  const notifyText = () => {
    if (
      input.hasPlugins &&
      callbacks.onTextToolFallback &&
      !notifiedTextModels.has(key)
    ) {
      notifiedTextModels.add(key);
      callbacks.onTextToolFallback();
    }
  };
  const commit = (value: string, allThinking: boolean) => {
    for (const part of parseThinking(value))
      committedValue = committed.append(
        part.content,
        allThinking || part.type === "thinking",
      );
    committedValue = committed.endSegment();
    latest = committedValue;
  };
  const build = () =>
    buildEndpointRequest(endpoint, {
      ...input,
      messages:
        textMode && input.textToolPrompt
          ? [
              { role: "system", content: input.textToolPrompt },
              ...input.messages,
            ]
          : input.messages,
      tools: textMode ? [] : input.tools,
      reasoningEnabled: reasoning,
    });
  const finish = (response: Response) => {
    if (pendingTextCache) textOnlyModels.add(key);
    if (pendingReasoningCache && !pendingTextCache) noReasoningModels.add(key);
    callbacks.onFinish(latest, response);
  };
  try {
    const extension = endpoint.requestPlugin
      ? createPluginSession(endpoint, input.sessionId ?? nanoid(), "chat")
      : undefined;
    callbacks.onToolModeChange?.(textMode ? "text" : "native");
    if (textMode) notifyText();
    let { url, headers, body } = build();
    for (let round = 0; round < 16; round++) {
      let roundStream = new ThinkingStream();
      let roundValue = "";
      let rawText = "";
      let textCall: ReturnType<typeof findMcpCall> = null;
      let parser = createEndpointEventParser(endpoint.protocol);
      try {
        const timeout = setTimeout(
          () => controller.abort(),
          input.timeoutMs ?? 60000,
        );
        try {
          // Transform a fresh wire copy on EVERY round/retry, never the canonical
          // body which receives tool results and signed thinking blocks.
          const wire = extension
            ? await extension.request(
                JSON.parse(JSON.stringify({ url, headers, body })),
                controller.signal,
              )
            : { url, headers, body };
          lastResponse = await waitForAbortable(
            extension
              ? extension.fetch(wire, "POST", requestFetch, controller.signal)
              : requestFetch(wire.url, {
                  method: "POST",
                  headers: wire.headers,
                  body: JSON.stringify(wire.body),
                  signal: controller.signal,
                  ...(extension ? { redirect: "manual" as const } : {}),
                }),
            controller.signal,
          );
        } finally {
          clearTimeout(timeout);
        }
        if (!lastResponse.ok) {
          const details = await lastResponse.text();
          if (lastResponse.status === 599)
            throw new Error(nativeNetworkErrorMessage(details));
          throw new EndpointStreamError(
            `HTTP ${lastResponse.status}${details ? `: ${details}` : ""}`,
            lastResponse.status,
          );
        }
        if (!input.stream) {
          const data = await lastResponse.json();
          if (data?.error)
            throw new EndpointStreamError(
              data.error.message ?? JSON.stringify(data.error),
              data.error.status ?? data.error.code,
            );
          const part = extractEndpointMessage(endpoint.protocol, data);
          if (part.content)
            roundValue = roundStream.append(part.content, part.isThinking);
          if (part.followingContent)
            roundValue = roundStream.append(part.followingContent, false);
          commit(roundStream.endSegment(), false);
          finish(lastResponse);
          return;
        }
        if (!lastResponse.body)
          throw new Error("Endpoint returned an empty stream");
        for await (const data of readEndpointEvents(
          lastResponse.body,
          controller.signal,
        )) {
          if (data === "[DONE]") break;
          const chunk: {
            isThinking: boolean;
            content?: string;
            followingContent?: string;
          } = parser.parse(JSON.parse(data));
          if (chunk.isThinking && chunk.content) {
            roundValue = roundStream.append(chunk.content, true);
            hasOutput = true;
          }
          const content = chunk.isThinking
            ? chunk.followingContent
            : chunk.content;
          if (content) {
            const next = rawText + content;
            textCall = textMode ? findMcpCall(next) : null;
            const accepted = textCall ? next.slice(0, textCall.end) : next;
            const delta = accepted.slice(rawText.length);
            rawText = accepted;
            if (delta) roundValue = roundStream.append(delta, false);
            hasOutput = true;
          }
          if (parser.calls().length) hasOutput = true;
          if (chunk.content || chunk.followingContent) {
            latest = committedValue + roundValue;
            callbacks.onUpdate?.(
              latest,
              content || chunk.content || "",
              roundStream.isThinking(),
            );
          }
          if (textCall) break;
        }
      } catch (error) {
        const status =
          error instanceof EndpointStreamError
            ? Number(error.status)
            : undefined;
        const message = error instanceof Error ? error.message : String(error);
        const userParameterError = mentionsUserParameter(
          message,
          input,
          endpoint,
        );
        if (
          !controller.signal.aborted &&
          !hasOutput &&
          reasoning &&
          !retriedReasoning &&
          (status === 400 || status === 422) &&
          !userParameterError
        ) {
          retriedReasoning = true;
          reasoning = false;
          pendingReasoningCache = true;
          ({ url, headers, body } = build());
          round--;
          continue;
        }
        if (
          !controller.signal.aborted &&
          !hasOutput &&
          !textMode &&
          !retriedText &&
          !userParameterError &&
          !!input.tools?.length &&
          status &&
          toolFallbackStatuses.has(status)
        ) {
          retriedText = true;
          textMode = true;
          pendingTextCache = true;
          callbacks.onToolModeChange?.("text");
          notifyText();
          ({ url, headers, body } = build());
          round--;
          continue;
        }
        throw error;
      }
      roundValue = roundStream.endSegment();
      if (textMode && textCall && input.executeTextTool) {
        commit(roundValue.replace(textCall.block, ""), false);
        callbacks.onUpdate?.(latest, "", false);
        let request: any;
        let failure = "";
        try {
          request = JSON.parse(textCall.raw);
          if (
            request?.method !== "tools/call" ||
            typeof request?.params?.name !== "string"
          )
            throw new Error("Invalid MCP tool request");
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        const name = request?.params?.name ?? "MCP";
        const call = {
          id: nanoid(),
          type: "function" as const,
          function: {
            name,
            arguments: failure
              ? textCall.raw
              : JSON.stringify(request?.params?.arguments ?? {}),
          },
          display: { source: "mcp" as const, server: textCall.clientId, name },
        };
        callbacks.onBeforeTool?.(call);
        let result: ToolResult;
        try {
          if (failure) throw new Error(failure);
          result = await waitForAbortable(
            input.executeTextTool(textCall.clientId, request),
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted) throw error;
          result = {
            __toolResult: true,
            isError: true,
            content: error instanceof Error ? error.message : String(error),
          };
        }
        if (controller.signal.aborted)
          throw new DOMException("Aborted", "AbortError");
        callbacks.onAfterTool?.({
          ...call,
          content: result.content,
          isError: result.isError,
          errorMsg: result.isError ? result.content : undefined,
        });
        appendTextToolResult(
          endpoint,
          body,
          rawText,
          textCall.clientId,
          result.content,
          result.isError,
        );
        continue;
      }
      const calls = parser.calls();
      if (!calls.length || textMode) {
        commit(roundValue, false);
        finish(lastResponse!);
        return;
      }
      commit(roundValue, true);
      callbacks.onUpdate?.(latest, "", false);
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
          input.toolDisplay,
        ),
        controller.signal,
      );
      if (controller.signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      appendToolResults(endpoint, body, calls, results, parser.outputItems());
    }
    throw new Error(Locale.Chat.ToolRoundsExceeded);
  } catch (error) {
    if (controller.signal.aborted) {
      callbacks.onFinish(
        latest,
        lastResponse ?? new Response(null, { status: 499 }),
      );
    } else
      callbacks.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
  }
}
