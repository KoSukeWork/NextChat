import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import http from "node:http";
import net from "node:net";
import { gzipSync } from "node:zlib";
import { mockAnthropic } from "./fixtures/anthropic-http.mjs";
import { inspectClientHello } from "./fixtures/client-hello.mjs";
import {
  parseEnvelope,
  verifyRuntime,
  RUNTIME_PROFILE,
} from "../scripts/wire-relay/server.mjs";

const executable = resolve(
  process.env.NEXTCHAT_TEST_WIRE_EXE || "build/nextchat-wire-relay.exe",
);
const enabled = process.platform === "win32" && existsSync(executable);
const token = "nextchat-wire-local-test-token";
let child, relay;
before(async () => {
  if (!enabled) return;
  child = spawn(executable, [], {
    env: {
      ...process.env,
      NEXTCHAT_WIRE_PORT: "0",
      NEXTCHAT_WIRE_HOST: "127.0.0.1",
      NEXTCHAT_WIRE_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  relay = await new Promise((resolve, reject) => {
    let output = "",
      errors = "";
    const timeout = setTimeout(
      () => reject(new Error("Relay startup timed out")),
      10000,
    );
    child.stderr.on("data", (b) => (errors += b));
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Relay exited ${code}: ${errors}`));
    });
    child.stdout.on("data", (b) => {
      output += b;
      const line = output.split("\n").find((s) => s.startsWith("{"));
      if (!line || !output.includes("\n")) return;
      const info = JSON.parse(line);
      clearTimeout(timeout);
      resolve(info.listening);
    });
  });
});
after(() => child?.kill());
const envelope = (url, extra = {}) => ({
  version: 1,
  profile: RUNTIME_PROFILE,
  url,
  method: "POST",
  headers: [
    ["Accept", "application/json"],
    ["Content-Type", "application/json"],
    ["User-Agent", "claude-cli/2.1.322 (external, cli)"],
    ["X-Claude-Code-Session-Id", "local-session"],
    ["X-Stainless-OS", "Windows"],
    ["anthropic-version", "2023-06-01"],
    ["x-api-key", "dummy-upstream-key"],
  ],
  body: '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"你好"}],"stream":true}',
  ...extra,
});
const send = (value, options = {}) =>
  fetch(relay + "/v1/requests", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(value),
    ...options,
  });
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });

test("Node cannot silently substitute for the pinned runtime", () => {
  assert.throws(verifyRuntime, /Unsupported wire runtime/);
});
test("envelopes reject duplicate/hop-by-hop headers, unexpected profiles and malformed bodies", () => {
  for (const change of [
    { profile: "unknown" },
    { headers: [["Host", "other.test"]] },
    {
      headers: [
        ["A", "1"],
        ["a", "2"],
      ],
    },
    { headers: [["x-api-key", "a\r\nb"]] },
    { method: "GET" },
    { url: "https://name:pass@example.test" },
    { body: {} },
  ])
    assert.throws(() =>
      parseEnvelope(envelope("https://gateway.test", change), 1024),
    );
  assert.equal(
    parseEnvelope(envelope("https://gateway.test"), 1024).headers[
      "X-Stainless-OS"
    ],
    "Windows",
  );
});

test(
  "standalone service authenticates and exposes its actual runtime",
  { skip: !enabled },
  async () => {
    assert.equal((await fetch(relay + "/v1/info")).status, 401);
    const info = await (
      await fetch(relay + "/v1/info", {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    assert.deepEqual(info.profiles, [RUNTIME_PROFILE]);
    assert.equal(info.revision, "38afee6c84fcf48c0edb2466aa4b27d287a59c30");
  },
);

test(
  "compiled independent relay matches the captured interactive ClientHello",
  { skip: !enabled },
  async () => {
    let captured;
    const received = new Promise((resolve) => (captured = resolve));
    const listener = net.createServer((socket) => {
      let data = Buffer.alloc(0);
      socket.on("error", () => {});
      socket.on("data", (b) => {
        data = Buffer.concat([data, b]);
        if (data.length < 5 || data.length < 5 + data.readUInt16BE(3)) return;
        socket.removeAllListeners("data");
        captured(
          inspectClientHello(data.subarray(0, 5 + data.readUInt16BE(3))),
        );
        socket.end(Buffer.from([21, 3, 3, 0, 2, 2, 40]));
      });
    });
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    try {
      const response = await send(
        envelope(
          `https://localhost:${listener.address().port}/v1/messages?beta=true`,
        ),
      );
      assert.equal(response.status, 502); // Probe deliberately terminates the handshake.
      const expected = JSON.parse(
        readFileSync("test/fixtures/claude-wire-2.1.322-windows.json", "utf8"),
      );
      assert.deepEqual(await received, expected.clientHello.normalizedFields);
    } finally {
      await close(listener);
    }
  },
);

test(
  "opaque transport preserves header spelling/order and exact serialized UTF-8 body",
  { skip: !enabled },
  async () => {
    let received;
    const ready = new Promise((resolve) => (received = resolve));
    const upstream = http.createServer(async (req, res) => {
      const parts = [];
      for await (const part of req) parts.push(part);
      received({
        method: req.method,
        path: req.url,
        headers: req.rawHeaders,
        body: Buffer.concat(parts).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    try {
      const input = envelope(
        `http://127.0.0.1:${upstream.address().port}/v1/messages?beta=true`,
      );
      const response = await send(input);
      assert.match(await response.text(), /message_stop/);
      assert.equal(
        response.headers.get("x-nextchat-wire-profile"),
        RUNTIME_PROFILE,
      );
      const captured = await ready;
      assert.equal(captured.method, input.method);
      assert.equal(captured.path, "/v1/messages?beta=true");
      assert.equal(captured.body, input.body);
      const names = captured.headers.filter((_, i) => i % 2 === 0);
      assert.deepEqual(
        names.slice(0, input.headers.length),
        input.headers.map(([name]) => name),
      );
      assert.ok(!captured.headers.includes(`Bearer ${token}`));
    } finally {
      await close(upstream);
    }
  },
);

test(
  "relay streams thinking and signatures without interpreting the model protocol",
  { skip: !enabled },
  async () => {
    const upstream = await mockAnthropic();
    try {
      const text = await (
        await send(envelope(upstream.url + "/v1/messages?beta=true"))
      ).text();
      assert.match(text, /thinking_delta/);
      assert.match(text, /local-fixture-signature/);
      assert.match(text, /Reply 1/);
    } finally {
      await upstream.close();
    }
  },
);

test(
  "upstream errors, redirects and compressed responses retain their meaning",
  { skip: !enabled },
  async () => {
    let calls = 0;
    const upstream = http.createServer((req, res) => {
      calls++;
      if (req.url === "/redirect") {
        res.writeHead(307, { location: "/never-follow" });
        res.end();
      } else if (req.url === "/error") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end('{"error":"rate limited"}');
      } else {
        res.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });
        res.end(gzipSync('{"text":"你好"}'));
      }
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${upstream.address().port}`;
      const redirect = await send(envelope(url + "/redirect"), {
        redirect: "manual",
      });
      assert.equal(redirect.status, 307);
      await redirect.text();
      assert.equal(calls, 1);
      const error = await send(envelope(url + "/error"));
      assert.equal(error.status, 429);
      assert.equal((await error.json()).error, "rate limited");
      const zipped = await send(envelope(url + "/gzip"));
      assert.equal(zipped.headers.get("content-encoding"), null);
      assert.deepEqual(await zipped.json(), { text: "你好" });
    } finally {
      await close(upstream);
    }
  },
);

test(
  "cancelling the caller aborts a stalled upstream connection",
  { skip: !enabled },
  async () => {
    const upstream = await mockAnthropic({ stall: true });
    try {
      const controller = new AbortController();
      const pending = send(envelope(upstream.url + "/v1/messages"), {
        signal: controller.signal,
      }).then((r) => r.text());
      await upstream.received;
      controller.abort();
      await assert.rejects(pending, /abort/i);
      await Promise.race([
        upstream.disconnected,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("upstream did not cancel")),
            4000,
          ).unref(),
        ),
      ]);
    } finally {
      await upstream.close();
    }
  },
);
