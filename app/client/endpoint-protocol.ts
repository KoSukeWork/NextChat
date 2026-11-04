import { nanoid } from "nanoid";
import type { RequestMessage } from "./api";
import type { Endpoint, EndpointProtocol } from "../utils/endpoints";
import { endpointUrl } from "../utils/endpoints";
import { stripThinkingFromMessages, thinkingChunk } from "../utils/thinking";

export interface EndpointTool {
  type: string;
  function: { name: string; description?: string; parameters: unknown };
}

export interface EndpointCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  thoughtSignature?: string;
}

export interface EndpointChatInput {
  model: string;
  messages: RequestMessage[];
  stream: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  tools?: EndpointTool[];
}

function plainText(content: RequestMessage["content"]): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
}

function hasImage(content: RequestMessage["content"]): boolean {
  return (
    Array.isArray(content) &&
    content.some((part) => part.type === "image_url" && !!part.image_url?.url)
  );
}

function anthropicContent(content: RequestMessage["content"]) {
  if (typeof content === "string" || !hasImage(content))
    return plainText(content);
  return content.flatMap<Record<string, unknown>>((part) => {
    if (part.type === "text") return [{ type: "text", text: part.text ?? "" }];
    const url = part.image_url?.url ?? "";
    const data = /^data:([^;,]+);base64,(.+)$/s.exec(url);
    if (data)
      return [
        {
          type: "image",
          source: { type: "base64", media_type: data[1], data: data[2] },
        },
      ];
    return url ? [{ type: "image", source: { type: "url", url } }] : [];
  });
}

function geminiParts(content: RequestMessage["content"]) {
  if (typeof content === "string" || !hasImage(content))
    return [{ text: plainText(content) }];
  return content.flatMap<Record<string, unknown>>((part) => {
    if (part.type === "text") return [{ text: part.text ?? "" }];
    const url = part.image_url?.url ?? "";
    const data = /^data:([^;,]+);base64,(.+)$/s.exec(url);
    if (data) return [{ inline_data: { mime_type: data[1], data: data[2] } }];
    return url ? [{ file_data: { file_uri: url } }] : [];
  });
}

export function endpointHeaders(endpoint: Endpoint): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (endpoint.protocol === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (endpoint.apiKey) headers["x-api-key"] = endpoint.apiKey;
  } else if (endpoint.protocol === "gemini") {
    if (endpoint.apiKey) headers["x-goog-api-key"] = endpoint.apiKey;
  } else if (endpoint.apiKey)
    headers.authorization = `Bearer ${endpoint.apiKey}`;
  return headers;
}

/** Build the actual wire request separately from the UI and transport. */
export function buildEndpointRequest(
  endpoint: Endpoint,
  input: EndpointChatInput,
) {
  const messages = stripThinkingFromMessages(input.messages);
  const tools = input.tools ?? [];
  const url = endpointUrl(endpoint, "chat", input.model, input.stream);
  let body: Record<string, any>;
  if (endpoint.protocol === "openai-chat") {
    const reasoning = /^(?:o1|o3|o4|gpt-5)/i.test(input.model);
    body = {
      model: input.model,
      messages: messages.map((message) => ({
        role: message.role,
        content: hasImage(message.content)
          ? message.content
          : plainText(message.content),
      })),
      stream: input.stream,
      ...(reasoning
        ? { max_completion_tokens: input.maxTokens }
        : {
            temperature: input.temperature,
            top_p: input.topP,
            presence_penalty: input.presencePenalty,
            frequency_penalty: input.frequencyPenalty,
            max_tokens: input.maxTokens,
          }),
      ...(tools.length ? { tools } : {}),
    };
  } else if (endpoint.protocol === "openai-responses") {
    body = {
      model: input.model,
      input: messages.map((message) => ({
        role: message.role,
        content:
          typeof message.content === "string" || !hasImage(message.content)
            ? plainText(message.content)
            : message.content.flatMap<Record<string, unknown>>((part) =>
                part.type === "text"
                  ? [{ type: "input_text", text: part.text ?? "" }]
                  : part.image_url?.url
                  ? [{ type: "input_image", image_url: part.image_url.url }]
                  : [],
              ),
      })),
      stream: input.stream,
      max_output_tokens: input.maxTokens,
      ...(/^(?:o1|o3|o4|gpt-5)/i.test(input.model)
        ? {
            reasoning: { summary: "auto" },
            include: ["reasoning.encrypted_content"],
          }
        : {}),
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              type: "function",
              ...tool.function,
            })),
          }
        : {}),
    };
  } else if (endpoint.protocol === "anthropic") {
    const systemMessages = messages.filter(
      (message) => message.role === "system",
    );
    const system = systemMessages.some((message) => hasImage(message.content))
      ? systemMessages.flatMap((message) => {
          const content = anthropicContent(message.content);
          return typeof content === "string"
            ? [{ type: "text", text: content }]
            : content;
        })
      : systemMessages
          .map((message) => plainText(message.content))
          .join("\n\n");
    const converted: { role: string; content: any }[] = [];
    for (const message of messages.filter((item) => item.role !== "system")) {
      const role = message.role === "assistant" ? "assistant" : "user";
      const content = anthropicContent(message.content);
      const previous = converted.at(-1);
      if (previous?.role === role) {
        const blocks = (value: any) =>
          typeof value === "string" ? [{ type: "text", text: value }] : value;
        previous.content = [...blocks(previous.content), ...blocks(content)];
      } else converted.push({ role, content });
    }
    body = {
      model: input.model,
      messages: converted,
      stream: input.stream,
      max_tokens: input.maxTokens ?? 4000,
      temperature: input.temperature,
      top_p: input.topP,
      ...(system ? { system } : {}),
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              name: tool.function.name,
              description: tool.function.description,
              input_schema: tool.function.parameters,
            })),
          }
        : {}),
    };
  } else {
    const converted: { role: string; parts: any[] }[] = [];
    for (const message of messages) {
      const role = message.role === "assistant" ? "model" : "user";
      const parts = geminiParts(message.content);
      const previous = converted.at(-1);
      if (previous?.role === role) previous.parts.push(...parts);
      else converted.push({ role, parts });
    }
    body = {
      contents: converted,
      generationConfig: {
        temperature: input.temperature,
        topP: input.topP,
        maxOutputTokens: input.maxTokens,
      },
      ...(tools.length
        ? {
            tools: [
              { functionDeclarations: tools.map((tool) => tool.function) },
            ],
          }
        : {}),
    };
  }
  return { url, headers: endpointHeaders(endpoint), body };
}

/** Parse one semantic SSE payload, accumulating fragmented function calls. */
export function createEndpointEventParser(protocol: EndpointProtocol) {
  const calls = new Map<string, EndpointCall>();
  const aliases = new Map<string, string>();
  const outputItems = new Map<number, any>();
  const anthropicBlocks = new Map<number, any>();
  const call = (key: string, id?: string, name?: string) => {
    const canonical = aliases.get(key) ?? key;
    let item = calls.get(canonical);
    if (!item) {
      item = {
        id: id || nanoid(),
        type: "function",
        function: { name: name ?? "", arguments: "" },
      };
      calls.set(canonical, item);
    }
    if (id) item.id = id;
    if (name) item.function.name = name;
    return item;
  };
  return {
    calls: () => [...calls.values()],
    outputItems: () =>
      [...(protocol === "anthropic" ? anthropicBlocks : outputItems).entries()]
        .sort(([a], [b]) => a - b)
        .map(([, item]) => item),
    parse(value: any) {
      if (
        value?.type === "error" ||
        value?.type === "response.failed" ||
        value?.error
      ) {
        throw new Error(
          value?.error?.message ??
            value?.response?.error?.message ??
            value?.message ??
            "Endpoint stream failed",
        );
      }
      if (protocol === "openai-chat") {
        const delta = value?.choices?.[0]?.delta ?? {};
        for (const tool of delta.tool_calls ?? []) {
          const item = call(
            String(tool.index ?? 0),
            tool.id,
            tool.function?.name,
          );
          if (tool.function?.arguments)
            item.function.arguments += tool.function.arguments;
        }
        return thinkingChunk(delta);
      }
      if (protocol === "openai-responses") {
        const key = String(value.output_index ?? value.item_id ?? 0);
        if (
          value.type === "response.output_item.done" &&
          value.item &&
          Number.isInteger(value.output_index)
        )
          outputItems.set(value.output_index, value.item);
        if (
          value.type === "response.output_item.added" &&
          value.item?.type === "function_call"
        ) {
          const item = call(key, value.item.call_id, value.item.name);
          if (value.item.id) aliases.set(value.item.id, key);
          if (value.item.arguments)
            item.function.arguments = value.item.arguments;
        }
        if (value.type === "response.function_call_arguments.delta")
          call(key).function.arguments += value.delta ?? "";
        if (value.type === "response.function_call_arguments.done")
          call(key).function.arguments =
            value.arguments ?? call(key).function.arguments;
        if (
          value.type === "response.output_item.done" &&
          value.item?.type === "function_call"
        ) {
          const item = call(key, value.item.call_id, value.item.name);
          if (value.item.arguments)
            item.function.arguments = value.item.arguments;
        }
        return {
          isThinking:
            value.type === "response.reasoning_summary_text.delta" ||
            value.type === "response.reasoning_text.delta",
          content: [
            "response.output_text.delta",
            "response.reasoning_summary_text.delta",
            "response.reasoning_text.delta",
          ].includes(value.type)
            ? value.delta ?? ""
            : "",
        };
      }
      if (protocol === "anthropic") {
        const key = String(value.index ?? 0);
        const blockIndex = value.index ?? 0;
        if (value.type === "content_block_start" && value.content_block)
          anthropicBlocks.set(blockIndex, { ...value.content_block });
        const block = anthropicBlocks.get(blockIndex);
        if (block && value.type === "content_block_delta") {
          if (value.delta?.type === "thinking_delta")
            block.thinking =
              (block.thinking ?? "") + (value.delta.thinking ?? "");
          if (value.delta?.type === "signature_delta")
            block.signature =
              (block.signature ?? "") + (value.delta.signature ?? "");
          if (value.delta?.type === "text_delta")
            block.text = (block.text ?? "") + (value.delta.text ?? "");
        }
        if (value.content_block?.type === "tool_use") {
          const item = call(
            key,
            value.content_block.id,
            value.content_block.name,
          );
          if (
            value.content_block.input &&
            Object.keys(value.content_block.input).length
          )
            item.function.arguments = JSON.stringify(value.content_block.input);
        }
        if (value.delta?.type === "input_json_delta")
          call(key).function.arguments += value.delta.partial_json ?? "";
        const isThinking =
          value.delta?.type === "thinking_delta" ||
          value.content_block?.type === "thinking";
        return {
          isThinking,
          content: isThinking
            ? value.delta?.thinking ?? value.content_block?.thinking ?? ""
            : value.delta?.text ?? "",
        };
      }
      const parts = value?.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.functionCall?.name) {
          const item = call(
            String(calls.size),
            part.functionCall.id,
            part.functionCall.name,
          );
          item.function.arguments = JSON.stringify(
            part.functionCall.args ?? {},
          );
          if (typeof part.thoughtSignature === "string")
            item.thoughtSignature = part.thoughtSignature;
        }
      }
      const reason = parts
        .filter((part: any) => part.thought === true)
        .map((part: any) => part.text ?? "")
        .join("");
      const text = parts
        .filter((part: any) => part.thought !== true)
        .map((part: any) => part.text ?? "")
        .join("");
      return thinkingChunk({ reasoning: reason, content: text });
    },
  };
}

export function extractEndpointMessage(protocol: EndpointProtocol, value: any) {
  if (protocol === "openai-chat") {
    const message = value?.choices?.[0]?.message ?? {};
    return thinkingChunk(message);
  }
  if (protocol === "openai-responses") {
    const items = Array.isArray(value?.output) ? value.output : [];
    const reasoning = items
      .filter((item: any) => item.type === "reasoning")
      .flatMap((item: any) => item.summary ?? [])
      .map((item: any) => item.text ?? "")
      .join("");
    const content = items
      .filter((item: any) => item.type === "message")
      .flatMap((item: any) => item.content ?? [])
      .map((item: any) => item.text ?? "")
      .join("");
    return thinkingChunk({
      reasoning,
      content: content || value?.output_text || "",
    });
  }
  const parts =
    protocol === "anthropic"
      ? value?.content ?? []
      : value?.candidates?.[0]?.content?.parts ?? [];
  const reasoning = parts
    .filter((item: any) => item.type === "thinking" || item.thought === true)
    .map((item: any) => item.thinking ?? item.text ?? "")
    .join("");
  const content = parts
    .filter((item: any) => item.type !== "thinking" && item.thought !== true)
    .map((item: any) => item.text ?? "")
    .join("");
  return thinkingChunk({ reasoning, content });
}
