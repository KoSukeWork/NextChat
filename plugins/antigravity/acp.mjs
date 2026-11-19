import { createInterface } from "node:readline";

export function resumeUnavailable(error) {
  if (error?.code === -32601) return true;
  const message = String(error?.message || "");
  return (
    /\bsession(?: id)?(?: is| was)? (?:not found|does not exist|no longer exists)\b/i.test(
      message,
    ) ||
    /\b(?:unknown|missing) session\b/i.test(message) ||
    /\bsession\/resume\b.{0,40}\bnot (?:supported|implemented)\b/i.test(message)
  );
}

/** ACP is newline-delimited JSON-RPC over the child process's stdio. */
export class AcpConnection {
  constructor(
    child,
    {
      onUpdate = () => {},
      onRequest = () => ({ outcome: { outcome: "cancelled" } }),
    } = {},
  ) {
    this.child = child;
    this.onUpdate = onUpdate;
    this.onRequest = onRequest;
    this.pending = new Map();
    this.nextId = 0;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.receive(line));
    child.stdin.on("error", () => {});
    child.on("error", () => this.close(new Error("Cannot start Antigravity")));
    child.on("close", () =>
      this.close(new Error("Antigravity process exited")),
    );
  }
  write(message) {
    if (this.closed || !this.child.stdin.writable)
      throw new Error("Antigravity connection closed");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method, params, timeoutMs = 30000) {
    if (this.closed)
      return Promise.reject(new Error("Antigravity connection closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Antigravity ${method} timed out`));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method, params) {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
  }
  receive(line) {
    if (line.length > 8 * 1024 * 1024)
      return this.close(new Error("Antigravity event too large"));
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return this.close(new Error("Invalid Antigravity event"));
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(
          message.error.message || "Antigravity request failed",
        );
        if (typeof message.error.code === "number")
          error.code = message.error.code;
        pending.reject(error);
      } else pending.resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      Promise.resolve()
        .then(() => this.onRequest(message.method, message.params))
        .then(
          (result) => this.write({ jsonrpc: "2.0", id: message.id, result }),
          () =>
            this.write({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Unsupported request" },
            }),
        )
        .catch(() => {});
    } else if (message.method) {
      this.onUpdate(message.method, message.params);
    }
  }
  close(error = new Error("Antigravity connection closed")) {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function selectModel(options, model, requestedEffort) {
  const modelOption = options.find((item) => item.id === "model");
  const values = (modelOption?.options ?? []).flatMap(
    (item) => item.options ?? [item],
  );
  const match =
    values.find((item) => item.value === model) ||
    values
      .filter(
        (item) =>
          typeof item.value === "string" &&
          model.startsWith(item.value + "-") &&
          /^(low|medium|high|xhigh|max)$/.test(
            model.slice(item.value.length + 1),
          ),
      )
      .sort((a, b) => b.value.length - a.value.length)[0];
  if (!match) return { model, effort: requestedEffort || "" };
  const suffix = model.startsWith(match.value + "-")
    ? model.slice(match.value.length + 1)
    : "";
  const effort = requestedEffort || suffix;
  return { model: match.value, effort };
}

export function supportedEffort(desired, choices) {
  const order = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const available = choices.filter((item) => order.includes(item));
  if (!desired || !available.length || !order.includes(desired)) return "";
  return available.reduce((best, item) =>
    Math.abs(order.indexOf(item) - order.indexOf(desired)) <
    Math.abs(order.indexOf(best) - order.indexOf(desired))
      ? item
      : best,
  );
}

export function contentBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw new Error("Invalid Antigravity message");
  return content.map((part) => {
    if (part?.type === "text" && typeof part.text === "string")
      return { type: "text", text: part.text };
    const match =
      /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(
        part?.image_url?.url || "",
      );
    if (part?.type === "image_url" && match)
      return { type: "image", mimeType: match[1], data: match[2] };
    throw new Error("Antigravity images must be embedded as data URLs");
  });
}

function takeBytes(text, length, tail = false) {
  const bytes = Buffer.from(text);
  if (bytes.length <= length) return text;
  if (!tail) {
    let end = length;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8");
  }
  let start = bytes.length - length;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

/** Keep the first and most recent history when an ACP session cannot resume. */
export function promptBlocks(messages, resume) {
  const last = contentBlocks(messages.at(-1).content);
  if (resume || messages.length === 1) return last;
  const history = messages
    .slice(0, -1)
    .map((message) => {
      const text = contentBlocks(message.content)
        .map((block) => (block.type === "text" ? block.text : "[image]"))
        .join("\n");
      const bounded =
        Buffer.byteLength(text) > 16384
          ? takeBytes(text, 8192) + "\n…\n" + takeBytes(text, 8192, true)
          : text;
      return `${message.role}:\n${bounded}\n`;
    })
    .join("\n");
  const capped =
    Buffer.byteLength(history) > 112 * 1024
      ? takeBytes(history, 16 * 1024) +
        "\n…\n" +
        takeBytes(history, 96 * 1024 - 10, true)
      : history;
  return [
    {
      type: "text",
      text: `Previous conversation:\n${capped}\nCurrent user message:\n`,
    },
    ...last,
  ];
}
