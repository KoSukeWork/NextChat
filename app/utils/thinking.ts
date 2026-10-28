import type { RequestMessage } from "../client/api";

export interface MessagePart {
  type: "text" | "thinking";
  content: string;
  closed: boolean;
}

// Case-insensitive delimiter table shared by live streams and saved messages.
export const THINKING_TAGS = [
  ["<think>", "</think>"],
  ["<thinking>", "</thinking>"],
  ["<reasoning>", "</reasoning>"],
  ["<seed:think>", "</seed:think>"],
  ["◁think▷", "◁/think▷"],
  ["[THINK]", "[/THINK]"],
  ["<|begin_of_thought|>", "<|end_of_thought|>"],
  ["<|channel|>analysis<|message|>", "<|end|>"],
] as const;
const delimiters = THINKING_TAGS.flat().map((tag) => tag.toLowerCase());
const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tokenPattern = `(^ {0,3}(\u0060{3,}|~{3,})[^\\r\\n]*$)|(\u0060+)|(${delimiters
  .map(escapeRegex)
  .join("|")})`;

export function parseThinking(
  source: string,
  streaming = false,
): MessagePart[] {
  const parts: MessagePart[] = [];
  const stack: string[] = [];
  let fence = "";
  let inline = 0;
  let offset = 0;
  let literalTag = false;
  const append = (text: string) => {
    if (!text) return;
    const type = stack.length ? "thinking" : "text";
    const last = parts.at(-1);
    if (last?.type === type && (type === "text" || !last.closed))
      last.content += text;
    else parts.push({ type, content: text, closed: !stack.length });
  };
  for (const match of source.matchAll(new RegExp(tokenPattern, "gim"))) {
    const token = match[0].toLowerCase();
    if (match[1] && !inline) {
      if (!fence) fence = match[2];
      else if (
        match[2][0] === fence[0] &&
        match[2].length >= fence.length &&
        token.trim() === match[2]
      )
        fence = "";
      continue;
    }
    if (fence) continue;
    if (match[3]) {
      if (!inline) inline = token.length;
      else if (inline === token.length) inline = 0;
      continue;
    }
    if (inline || !match[4]) continue;
    const opening = THINKING_TAGS.find(
      ([open]) => open.toLowerCase() === token,
    );
    const pending = source.slice(offset, match.index);
    if (opening) {
      // Only a segment's leading tags are delimiters. Examples in body stay text.
      const hasBody = parts.some(
        (part) => part.type === "text" && part.content.trim(),
      );
      if (!stack.length && (hasBody || pending.trim())) {
        literalTag = true;
        continue;
      }
      append(pending);
      if (!stack.length)
        parts.push({ type: "thinking", content: "", closed: false });
      stack.push(opening[1].toLowerCase());
    } else if (stack.length && stack.at(-1) === token) {
      append(pending);
      stack.pop();
      if (!stack.length) parts.at(-1)!.closed = true;
    } else if (
      !stack.length &&
      !literalTag &&
      !parts.some((part) => part.type === "thinking")
    ) {
      // Some templates put the opening token in the prompt, outside the response.
      const prefix = parts.map((part) => part.content).join("") + pending;
      parts.splice(0, parts.length, {
        type: "thinking",
        content: prefix,
        closed: true,
      });
    } else continue;
    offset = match.index! + match[0].length;
  }
  let tail = source.slice(offset);
  if (streaming && !fence && !inline) {
    for (
      let length = Math.min(
        tail.length,
        Math.max(...delimiters.map((tag) => tag.length)) - 1,
      );
      length > 0;
      length--
    ) {
      if (
        delimiters.some((tag) =>
          tag.startsWith(tail.slice(-length).toLowerCase()),
        )
      ) {
        tail = tail.slice(0, -length);
        break;
      }
    }
  }
  append(tail);
  return parts;
}

export function stripThinking(content: string): string {
  const parts = parseThinking(content);
  return parts.some((part) => part.type === "thinking")
    ? parts
        .filter((part) => part.type === "text")
        .map((part) => part.content)
        .join("")
        .trim()
    : content;
}

export function thinkingToMarkdown(content: string): string {
  return parseThinking(content)
    .map((part) =>
      part.type === "text"
        ? part.content
        : part.content.trim()
        ? `\n\n> ${part.content.trim().replace(/\n/g, "\n> ")}\n\n`
        : "",
    )
    .join("")
    .trim();
}

export function stripThinkingFromMessages<T extends RequestMessage>(
  messages: T[],
): T[] {
  return messages.map((message) =>
    message.role !== "assistant"
      ? message
      : {
          ...message,
          content:
            typeof message.content === "string"
              ? stripThinking(message.content)
              : message.content.map((part) =>
                  part.type === "text"
                    ? { ...part, text: stripThinking(part.text ?? "") }
                    : part,
                ),
        },
  );
}

export function reasoningText(value: any): string {
  return (
    [
      value?.reasoning_content,
      value?.reasoning,
      value?.thinking,
      value?.ReasoningContent,
    ].find((text) => typeof text === "string" && text.length) ?? ""
  );
}

export function thinkingChunk(value: any, body = value?.content ?? "") {
  const content =
    typeof body === "string"
      ? body
      : Array.isArray(body)
      ? body.map((part) => part.text ?? "").join("")
      : "";
  const reasoning = reasoningText(value);
  return reasoning
    ? { isThinking: true, content: reasoning, followingContent: content }
    : { isThinking: false, content };
}

// Provider fields form explicit segments; literal tags only count at their start.
// Keeping full snapshots allows closing-only templates to retroactively classify text.
export class ThinkingStream {
  private segments: { content: string; thinking: boolean; closed: boolean }[] =
    [];

  append(content: string, isThinking: boolean): string {
    if (content) {
      let last = this.segments.at(-1);
      if (!last || last.closed || last.thinking !== isThinking) {
        if (last) last.closed = true;
        last = { content: "", thinking: isThinking, closed: false };
        this.segments.push(last);
      }
      last.content += content;
    }
    return this.value();
  }

  isThinking(): boolean {
    const last = this.segments.at(-1);
    if (!last || last.closed) return false;
    return (
      last.thinking ||
      parseThinking(last.content, true).some(
        (part) => part.type === "thinking" && !part.closed,
      )
    );
  }

  private value(): string {
    const thoughts: MessagePart[] = [];
    const body: string[] = [];
    for (const segment of this.segments) {
      const parsed = parseThinking(segment.content, !segment.closed);
      for (const part of parsed) {
        if (segment.thinking || part.type === "thinking") {
          const thought = {
            ...part,
            type: "thinking" as const,
            closed: segment.thinking
              ? segment.closed
              : part.closed || segment.closed,
          };
          // Providers sometimes repeat a reasoning field as a tagged content block.
          if (
            !thoughts.some(
              (prior) =>
                prior.closed &&
                (prior.content.trim() === thought.content.trim() ||
                  (!thought.closed &&
                    prior.content.trim().startsWith(thought.content.trim()))),
            )
          )
            thoughts.push(thought);
        } else body.push(part.content);
      }
    }
    // Canonical thoughts precede the answer, including after tool calls. This also
    // makes stored messages unambiguous under the leading-tags-only parsing rule.
    return (
      thoughts
        .map(
          (part) =>
            `<think>\n${part.content}${
              part.closed || body.some((text) => text.trim())
                ? "\n</think>\n\n"
                : ""
            }`,
        )
        .join("") + body.join("")
    );
  }

  endSegment(): string {
    const last = this.segments.at(-1);
    if (last) last.closed = true;
    return this.value();
  }
}

export function normalizeThinking(content: string, reasoning = ""): string {
  const stream = new ThinkingStream();
  stream.append(reasoning, true);
  stream.append(content ?? "", false);
  return stream.endSegment();
}

// Full response envelopes cover OpenAI-compatible, Alibaba, Anthropic, Gemini,
// Baidu and Tencent. The adapter's fallback preserves provider-specific outputs.
export function normalizeThinkingResponse(
  response: any,
  fallback: string | { text?: string }[] | undefined,
): string {
  const message =
    response?.choices?.[0]?.message ??
    response?.output?.choices?.[0]?.message ??
    response?.Choices?.[0]?.Message ??
    response;
  const parts =
    response?.candidates?.[0]?.content?.parts ??
    (Array.isArray(response?.content) ? response.content : undefined);
  if (parts) {
    const stream = new ThinkingStream();
    for (const part of parts)
      stream.append(
        part.thinking ?? part.text ?? "",
        part.thought === true || part.type === "thinking",
      );
    return stream.endSegment();
  }
  const body = Array.isArray(fallback)
    ? fallback.map((part) => part.text ?? "").join("")
    : fallback ?? "";
  return normalizeThinking(body, reasoningText(message));
}
