import type { ChatMessage, ChatSession } from "../store/chat";
import { stripThinking } from "./thinking";

export const SEARCH_RESULT_LIMIT = 500;

export type SearchMatch = {
  messageId: string;
  role: ChatMessage["role"];
  date: string;
  snippet: string;
};

export type SearchGroup = {
  session: ChatSession;
  titleMatched: boolean;
  matches: SearchMatch[];
};

export type SearchResult = {
  keywords: string[];
  groups: SearchGroup[];
  total: number;
  truncated: boolean;
};

const SNIPPET_RADIUS = 40;

export function parseKeywords(query: string) {
  return Array.from(
    new Set(query.trim().toLowerCase().split(/\s+/u).filter(Boolean)),
  );
}

function rawMessageText(message: ChatMessage) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

function hasAllKeywords(text: string, keywords: string[]) {
  const lowered = text.toLowerCase();
  return keywords.every((keyword) => lowered.includes(keyword));
}

// The text a person sees in the chat: no tool output and no collapsed thinking.
export function searchableMessageText(message: ChatMessage) {
  if (message.isMcpResponse) return "";
  if (message.role !== "user" && message.role !== "assistant") return "";
  const text = rawMessageText(message);
  return message.role === "assistant" ? stripThinking(text) : text;
}

// Longest first, so that overlapping keywords highlight the longer match.
function keywordPattern(keywords: string[], flags: string) {
  const alternatives = [...keywords]
    .sort((a, b) => b.length - a.length)
    .map((keyword) => keyword.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&"));
  return new RegExp(`(${alternatives.join("|")})`, flags);
}

export function buildSnippet(text: string, keywords: string[]) {
  const flat = text.replace(/\s+/g, " ").trim();
  const position = Math.max(0, flat.search(keywordPattern(keywords, "iu")));
  let start = Math.max(0, position - SNIPPET_RADIUS);
  let end = Math.min(flat.length, position + SNIPPET_RADIUS * 2);
  // Do not cut an emoji or other surrogate pair in half.
  const isLowSurrogate = (index: number) => {
    const code = flat.charCodeAt(index);
    return code >= 0xdc00 && code <= 0xdfff;
  };
  if (isLowSurrogate(start)) start -= 1;
  if (isLowSurrogate(end)) end += 1;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${
    end < flat.length ? "…" : ""
  }`;
}

export function splitHighlight(text: string, keywords: string[]) {
  if (keywords.length === 0) return [{ text, matched: false }];
  // A capturing group keeps the matches at the odd positions of the split.
  return text
    .split(keywordPattern(keywords, "giu"))
    .map((part, index) => ({ text: part, matched: index % 2 === 1 }))
    .filter((part) => part.text.length > 0);
}

export function searchSessions(
  sessions: ChatSession[],
  query: string,
  limit = SEARCH_RESULT_LIMIT,
): SearchResult {
  const keywords = parseKeywords(query);
  const result: SearchResult = {
    keywords,
    groups: [],
    total: 0,
    truncated: false,
  };
  if (keywords.length === 0) return result;

  const newestFirst = [...sessions].sort((a, b) => b.lastUpdate - a.lastUpdate);
  for (const session of newestFirst) {
    const titleMatched = hasAllKeywords(session.topic, keywords);
    if (titleMatched) {
      if (result.total >= limit) {
        result.truncated = true;
        break;
      }
      result.total++;
    }
    const matches: SearchMatch[] = [];
    for (const message of session.messages) {
      // Stripping thinking is the slow step, so filter on the raw text first.
      if (!hasAllKeywords(rawMessageText(message), keywords)) continue;
      const text = searchableMessageText(message);
      if (!hasAllKeywords(text, keywords)) continue;
      if (result.total >= limit) {
        result.truncated = true;
        break;
      }
      matches.push({
        messageId: message.id,
        role: message.role,
        date: message.date,
        snippet: buildSnippet(text, keywords),
      });
      result.total++;
    }

    if (titleMatched || matches.length > 0) {
      result.groups.push({ session, titleMatched, matches });
    }
    if (result.truncated) break;
  }
  return result;
}
