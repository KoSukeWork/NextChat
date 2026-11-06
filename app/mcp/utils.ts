import type { RequestMessage } from "../client/api";

const callPattern = /```json:mcp:([^\r\n]+)\r?\n([\s\S]*?)```/g;
const responsePattern = /```json:mcp-response:([^\r\n]+)\r?\n([\s\S]*?)```/g;

export function findMcpCall(content: string) {
  const match = new RegExp(callPattern.source).exec(content);
  return (
    match && {
      clientId: match[1].trim(),
      raw: match[2].trim(),
      start: match.index,
      end: match.index + match[0].length,
      block: match[0],
    }
  );
}

/** Remove old tool transcripts from outbound context, without touching saved messages. */
export function cleanMcpHistory<
  T extends RequestMessage & { isMcpResponse?: boolean },
>(messages: T[]): T[] {
  return messages
    .filter((message) => !message.isMcpResponse)
    .flatMap((message) => {
      if (message.role !== "assistant") return [message];
      const clean = (text: string) =>
        text.replace(new RegExp(callPattern.source, "g"), "").trim();
      const content =
        typeof message.content === "string"
          ? clean(message.content)
          : message.content.map((part) =>
              part.type === "text"
                ? { ...part, text: clean(part.text ?? "") }
                : part,
            );
      if (
        typeof content === "string"
          ? !content
          : content.every((part) => part.type === "text" && !part.text)
      )
        return [];
      return [{ ...message, content }];
    });
}

export function splitLegacyMcpCalls(content: string) {
  const parts: (
    | { type: "text"; content: string }
    | { type: "call"; clientId: string; raw: string }
  )[] = [];
  let offset = 0;
  for (const match of content.matchAll(new RegExp(callPattern.source, "g"))) {
    if (match.index! > offset)
      parts.push({ type: "text", content: content.slice(offset, match.index) });
    parts.push({
      type: "call",
      clientId: match[1].trim(),
      raw: match[2].trim(),
    });
    offset = match.index! + match[0].length;
  }
  if (offset < content.length || !parts.length)
    parts.push({ type: "text", content: content.slice(offset) });
  return parts;
}

export function parseLegacyMcpResponse(content: string) {
  const match = new RegExp(responsePattern.source).exec(content);
  return match
    ? { clientId: match[1].trim(), content: match[2].trim() }
    : { clientId: "", content };
}
