// Development-only loopback gateway. Never used by the shipped plugin/relay.
// It records raw HTTP, not TLS. The CLI runs separately in a real terminal.
import net from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { decodeRequest } from "./request-parity.mjs";

const directory = mkdtempSync(join(tmpdir(), "nextchat-interactive-capture-"));
for (const name of ["workspace", "config"]) mkdirSync(join(directory, name));
const key = `nextchat-local-dummy-${randomBytes(16).toString("hex")}`;
const document = { schema: 1, scope: "raw HTTP/1 only", captures: [] };
const target = join(directory, "captures.json");
const save = () => writeFileSync(target, JSON.stringify(document, null, 2));
save();

function response(socket, status, type, body) {
  socket.end(
    `HTTP/1.1 ${status}\r\nContent-Type: ${type}\r\nContent-Length: ${Buffer.byteLength(
      body,
    )}\r\nConnection: close\r\n\r\n${body}`,
  );
}
function reply(body, sequence) {
  const message = {
    id: `msg_capture_${sequence}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  };
  const text = `Probe reply ${sequence}.`;
  if (!body.stream)
    return [
      "application/json",
      JSON.stringify({
        ...message,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
      }),
    ];
  return [
    "text/event-stream",
    [
      { type: "message_start", message },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
  ];
}

const sockets = new Set();
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  socket.setTimeout(30000, () => socket.destroy());
  let bytes = Buffer.alloc(0),
    done = false;
  socket.on("data", (chunk) => {
    if (done) return;
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > 16 * 1024 * 1024) return socket.destroy();
    const end = bytes.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = bytes.subarray(0, end).toString("latin1");
    const length = /^Content-Length:\s*(\d+)\s*$/im.exec(head);
    if (!length) {
      done = true;
      return response(
        socket,
        "411 Length Required",
        "text/plain",
        "Content-Length required",
      );
    }
    if (bytes.length < end + 4 + Number(length[1])) return;
    done = true;
    try {
      const capture = {
        wireBase64: bytes
          .subarray(0, end + 4 + Number(length[1]))
          .toString("base64"),
      };
      const request = decodeRequest(capture);
      const headers = Object.fromEntries(
        request.headers.map(([name, value]) => [name.toLowerCase(), value]),
      );
      if (headers["x-api-key"] !== key)
        return response(
          socket,
          "401 Unauthorized",
          "text/plain",
          "Local dummy key required",
        );
      const path = request.line.split(" ")[1].split("?")[0];
      if (path === "/v1/messages/count_tokens")
        return response(
          socket,
          "200 OK",
          "application/json",
          '{"input_tokens":10}',
        );
      if (path !== "/v1/messages")
        return response(socket, "404 Not Found", "text/plain", "Not found");
      const body = JSON.parse(request.body.toString("utf8"));
      document.captures.push(capture);
      save();
      console.log(
        JSON.stringify({
          captured: document.captures.length - 1,
          bytes: request.wire.length,
        }),
      );
      response(socket, "200 OK", ...reply(body, document.captures.length));
    } catch {
      response(
        socket,
        "400 Bad Request",
        "text/plain",
        "Invalid probe request",
      );
    }
  });
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const info = {
  directory,
  captures: target,
  url: `http://127.0.0.1:${server.address().port}`,
  key,
};
writeFileSync(join(directory, "probe.json"), JSON.stringify(info, null, 2));
console.log(
  JSON.stringify({
    probe: join(directory, "probe.json"),
    captures: target,
    url: info.url,
  }),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
