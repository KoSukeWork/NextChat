import {
  buildSnippet,
  parseKeywords,
  searchSessions,
  searchableMessageText,
  splitHighlight,
} from "../app/utils/chat-search";
import type { ChatMessage, ChatSession } from "../app/store/chat";

let nextId = 0;
const message = (
  role: ChatMessage["role"],
  content: ChatMessage["content"],
  extra: Partial<ChatMessage> = {},
) =>
  ({
    id: `m${nextId++}`,
    date: "2026/11/4 10:00:00",
    role,
    content,
    ...extra,
  }) as ChatMessage;
const session = (
  topic: string,
  messages: ChatMessage[],
  extra: Partial<ChatSession> = {},
) =>
  ({
    id: `s${nextId++}`,
    topic,
    messages,
    lastUpdate: 1,
    ...extra,
  }) as ChatSession;

test("keywords are lowercased, unique and split on any whitespace", () => {
  expect(parseKeywords("  Docker   docker\t报错　API ")).toEqual([
    "docker",
    "报错",
    "api",
  ]);
  expect(parseKeywords("   ")).toEqual([]);
});

test("all keywords must appear in the same message, in any case", () => {
  const hit = message("user", "The DOCKER build 报错了");
  const split = session("t", [
    message("user", "docker only"),
    message("assistant", "报错 only"),
  ]);
  const found = searchSessions(
    [split, session("t", [hit])],
    "docker 报错",
  ).groups;
  expect(found).toHaveLength(1);
  expect(found[0].matches[0].messageId).toBe(hit.id);
});

test("a title hit needs every keyword in the title and keeps message hits apart", () => {
  const titled = session("Docker 部署", [message("user", "nothing here")]);
  const [group] = searchSessions([titled], "docker 部署").groups;
  expect(group.titleMatched).toBe(true);
  expect(group.matches).toEqual([]);
  expect(searchSessions([titled], "docker 报错").groups).toEqual([]);
});

test("a title can match even when the session has no messages", () => {
  const result = searchSessions([session("新的聊天", [])], "新的");
  expect(result.total).toBe(1);
  expect(result.groups[0].titleMatched).toBe(true);
});

test("title-only hits count towards the result limit", () => {
  const sessions = Array.from({ length: 4 }, () => session("needle", []));
  const result = searchSessions(sessions, "needle", 2);
  expect(result.total).toBe(2);
  expect(result.groups).toHaveLength(2);
  expect(result.truncated).toBe(true);
});

test("newest sessions come first and archived sessions are included", () => {
  const older = session("old", [message("user", "needle")], { lastUpdate: 1 });
  const newer = session("new", [message("user", "needle")], {
    lastUpdate: 2,
    archived: true,
  });
  const sessions = [older, newer];
  expect(
    searchSessions(sessions, "needle").groups.map((g) => g.session.id),
  ).toEqual([newer.id, older.id]);
  expect(sessions).toEqual([older, newer]);
});

test("searchable text skips thinking, tool output and system messages", () => {
  const thinking = message(
    "assistant",
    "<think>secretplan</think>the visible answer",
  );
  expect(searchableMessageText(thinking)).not.toContain("secretplan");
  expect(searchSessions([session("t", [thinking])], "secretplan").total).toBe(
    0,
  );
  expect(searchSessions([session("t", [thinking])], "visible").total).toBe(1);

  const mcp = message("user", "tool-output", { isMcpResponse: true });
  const system = message("system", "tool-output");
  expect(searchSessions([session("t", [mcp, system])], "tool").total).toBe(0);

  // Thinking tags typed by the user are the user's own words.
  const typed = message("user", "<think>my note</think>");
  expect(searchSessions([session("t", [typed])], "note").total).toBe(1);
});

test("every text part of a multimodal message is searched", () => {
  const multimodal = message("user", [
    { type: "text", text: "first part" },
    { type: "image_url", image_url: { url: "data:needle" } },
    { type: "text", text: "second part" },
  ]);
  const find = (query: string) =>
    searchSessions([session("t", [multimodal])], query).total;
  expect(find("second")).toBe(1);
  expect(find("first second")).toBe(1);
  expect(find("needle")).toBe(0);
});

test("the result limit keeps the newest matches and reports truncation", () => {
  const older = session("old", [message("user", "needle")], { lastUpdate: 1 });
  const newer = session(
    "new",
    [message("user", "needle"), message("user", "needle")],
    { lastUpdate: 2 },
  );
  const result = searchSessions([older, newer], "needle", 2);
  expect(result.total).toBe(2);
  expect(result.truncated).toBe(true);
  expect(result.groups.map((g) => g.session.id)).toEqual([newer.id]);
  expect(searchSessions([older, newer], "needle", 10).truncated).toBe(false);
});

test("snippets centre on the first match and flatten whitespace", () => {
  const text = `${"前".repeat(100)}\n\n  needle  \n${"后".repeat(100)}`;
  const snippet = buildSnippet(text, ["needle"]);
  expect(snippet.startsWith("…")).toBe(true);
  expect(snippet.endsWith("…")).toBe(true);
  expect(snippet).toContain("前 needle 后");
  expect(snippet.length).toBeLessThan(130);
  expect(buildSnippet("short needle", ["needle"])).toBe("short needle");
});

test("snippets never cut a surrogate pair in half", () => {
  const snippet = buildSnippet(`${"😀".repeat(40)}needle${"😀".repeat(60)}`, [
    "needle",
  ]);
  expect(snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  expect(snippet).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});

test("highlight keeps the original case and treats keywords as plain text", () => {
  expect(splitHighlight("Use DOCKER and docker", ["docker"])).toEqual([
    { text: "Use ", matched: false },
    { text: "DOCKER", matched: true },
    { text: " and ", matched: false },
    { text: "docker", matched: true },
  ]);
  expect(splitHighlight("a.b axb (c)", ["a.b", "(c)"])).toEqual([
    { text: "a.b", matched: true },
    { text: " axb ", matched: false },
    { text: "(c)", matched: true },
  ]);
  expect(splitHighlight("<b>x</b>", [])).toEqual([
    { text: "<b>x</b>", matched: false },
  ]);
  expect(buildSnippet("price c++ now", ["c++"])).toBe("price c++ now");
});

test("regex syntax and hyphens in a query never throw", () => {
  const text = session("t", [
    message("user", "a-b [x] \\d (y) {z} ^$ | / ? * +"),
  ]);
  for (const query of [
    "a-b",
    "[x]",
    "\\d",
    "(y)",
    "{z}",
    "^$",
    "|",
    "/",
    "?",
  ]) {
    expect(searchSessions([text], query).total).toBe(1);
  }
});
