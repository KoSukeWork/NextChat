import {
  parseThinking,
  stripThinking,
  stripThinkingFromMessages,
  thinkingToMarkdown,
  ThinkingStream,
  THINKING_TAGS,
  normalizeThinking,
  normalizeThinkingResponse,
  thinkingChunk,
} from "../app/utils/thinking";

test("closed, unclosed and absent reasoning; ordinary quotations remain unchanged", () => {
  expect(stripThinking("<think>secret</think>\n\nAnswer\n> a real quote")).toBe(
    "Answer\n> a real quote",
  );
  expect(stripThinking("Before<think>unfinished")).toBe(
    "Before<think>unfinished",
  );
  expect(parseThinking("<think>unfinished")).toEqual([
    { type: "thinking", content: "unfinished", closed: false },
  ]);
  expect(stripThinking("> legacy text\n\nAnswer")).toBe(
    "> legacy text\n\nAnswer",
  );
  expect(parseThinking("Plain answer")).toEqual([
    { type: "text", content: "Plain answer", closed: true },
  ]);
});

test("literal tags inside fenced and inline code remain ordinary content", () => {
  const examples =
    "Use `<think>example</think>`\n\n```xml\n<think>example</think>\n```\n\n~~~text\n<think>example</think>\n~~~";
  expect(stripThinking(examples)).toBe(examples);
  expect(parseThinking(examples).every((part) => part.type === "text")).toBe(
    true,
  );
});

test("streaming reasoning-only and reasoning to body use canonical markers", () => {
  const stream = new ThinkingStream();
  expect(stream.append("First", true)).toBe("<think>\nFirst");
  expect(stream.append("\nSecond", true)).toBe("<think>\nFirst\nSecond");
  expect(stream.append("Answer", false)).toBe(
    "<think>\nFirst\nSecond\n</think>\n\nAnswer",
  );
  expect(stripThinking(stream.endSegment())).toBe("Answer");
  const only = new ThinkingStream();
  only.append("Thought only", true);
  expect(only.endSegment()).toBe("<think>\nThought only\n</think>\n\n");
});

test("multiple reasoning segments and tool boundaries close independently", () => {
  const stream = new ThinkingStream();
  stream.append("Plan", true);
  stream.endSegment();
  stream.append("Result", false);
  stream.append("Reconsider", true);
  stream.append("Final", false);
  const result = stream.endSegment();
  expect(
    parseThinking(result)
      .filter((part) => part.type === "thinking")
      .map((part) => part.content.trim()),
  ).toEqual(["Plan", "Reconsider"]);
  expect(stripThinking(result)).toContain("Result");
  expect(stripThinking(result)).toContain("Final");
  expect(stripThinking(result)).not.toMatch(/Plan|Reconsider/);
});

test("native tags can span arbitrary SSE chunks, and a chunk can contain both modes", () => {
  const input = "<think>plan</think>Answer<think>check</think>Final";
  const stream = new ThinkingStream();
  let previous = "";
  for (const character of input) {
    const current = stream.append(character, false);
    // Response animation consumes a prefix; previously emitted bytes cannot change.
    expect(current.startsWith(previous)).toBe(true);
    previous = current;
  }
  expect(stripThinking(stream.endSegment())).toContain("Answer");
  expect(stripThinking(stream.endSegment())).toContain("Final");
  const tagged = new ThinkingStream();
  tagged.append("<think>nested source</think>", true);
  const result = tagged.append("Body", false);
  expect(
    parseThinking(result).filter((part) => part.type === "thinking"),
  ).toHaveLength(1);
  expect(stripThinking(result)).toBe("Body");
});

test("history stripping covers all assistant multimodal text parts without mutating input or user data", () => {
  const messages = [
    {
      role: "assistant" as const,
      content: "<think>hidden</think>\n> Keep quotation",
    },
    { role: "user" as const, content: "Explain <think>my tag</think>" },
    {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "<think>secret</think>one" },
        { type: "image_url" as const, image_url: { url: "data:example" } },
        { type: "text" as const, text: "<think>unfinished" },
      ],
    },
  ];
  const cleaned = stripThinkingFromMessages(messages);
  expect(cleaned[0].content).toBe("> Keep quotation");
  expect(cleaned[1]).toBe(messages[1]);
  expect(cleaned[2].content).toEqual([
    { type: "text", text: "one" },
    { type: "image_url", image_url: { url: "data:example" } },
    { type: "text", text: "" },
  ]);
  expect(messages[0].content).toContain("hidden");
});

test("Markdown export retains readable reasoning while normal quotes are not modified", () => {
  expect(
    thinkingToMarkdown("<think>step 1\nstep 2</think>\nAnswer\n> quote"),
  ).toBe("> step 1\n> step 2\n\n\nAnswer\n> quote");
  expect(thinkingToMarkdown("> old thought\nAnswer")).toBe(
    "> old thought\nAnswer",
  );
});

test.each(THINKING_TAGS)(
  "normalizes %s, case variants and every chunk split",
  (open, close) => {
    const input = `  ${open.toUpperCase()}private${close.toUpperCase()}Answer`;
    expect(stripThinking(input)).toBe("Answer");
    for (let split = 0; split <= input.length; split++) {
      const stream = new ThinkingStream();
      stream.append(input.slice(0, split), false);
      stream.append(input.slice(split), false);
      expect(stream.endSegment()).toContain("<think>\nprivate\n</think>");
      expect(stripThinking(stream.endSegment())).toBe("Answer");
    }
    expect(normalizeThinking(`${open}unfinished`)).toBe(
      "<think>\nunfinished\n</think>\n\n",
    );
    const example = `Explanation: ${open}example${close}`;
    expect(stripThinking(example)).toBe(example);
  },
);

test.each(THINKING_TAGS)(
  "retroactively classifies a closing-only %s template",
  (_open, close) => {
    const stream = new ThinkingStream();
    for (const character of `private${close}Answer`)
      stream.append(character, false);
    expect(stream.endSegment()).toBe("<think>\nprivate\n</think>\n\nAnswer");
  },
);

test("tool boundaries permit fresh leading tags; body tags remain literal", () => {
  const stream = new ThinkingStream();
  stream.append("First body", false);
  stream.endSegment();
  const live = stream.append("<thinking>second plan", false);
  expect(stream.isThinking()).toBe(true);
  expect(stripThinking(live)).toBe("First body");
  stream.append("</thinking>", false);
  stream.append("Second body", false);
  expect(stream.isThinking()).toBe(false);
  expect(stripThinking(stream.endSegment())).toBe("First bodySecond body");
  expect(stream.endSegment()).toContain("<think>\nsecond plan\n</think>");
  expect(normalizeThinking("Answer <think>XML example</think>")).toBe(
    "Answer <think>XML example</think>",
  );
});

test.each(["reasoning_content", "reasoning", "thinking"])(
  "normalizes %s in streaming and complete API fields, without tagged duplicates",
  (field) => {
    const value = {
      [field]: "secret",
      content: "<thinking>secret</thinking>Body",
    };
    const chunk = thinkingChunk(value);
    const stream = new ThinkingStream();
    stream.append(chunk.content, chunk.isThinking);
    stream.append(chunk.followingContent ?? "", false);
    expect(stream.endSegment()).toBe("<think>\nsecret\n</think>\n\nBody");
    expect(
      normalizeThinkingResponse(
        { choices: [{ message: value }] },
        value.content,
      ),
    ).toBe(stream.endSegment());
  },
);

test("complete Anthropic and Gemini responses retain thoughts and all text parts", () => {
  const anthropic = {
    content: [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "A" },
      { type: "text", text: "B" },
    ],
  };
  const gemini = {
    candidates: [
      {
        content: {
          parts: [
            { thought: true, text: "plan" },
            { text: "A" },
            { text: "B" },
          ],
        },
      },
    ],
  };
  for (const response of [anthropic, gemini])
    expect(normalizeThinkingResponse(response, "")).toBe(
      "<think>\nplan\n</think>\n\nAB",
    );
});

test("Alibaba multimodal non-streaming text is normalized without object coercion", () => {
  const message = {
    reasoning_content: "plan",
    content: [{ text: "A" }, { text: "B" }],
  };
  expect(
    normalizeThinkingResponse(
      { output: { choices: [{ message }] } },
      message.content,
    ),
  ).toBe("<think>\nplan\n</think>\n\nAB");
});
