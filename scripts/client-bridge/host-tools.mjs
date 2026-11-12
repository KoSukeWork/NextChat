import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function authorized(actual, token) {
  const a = Buffer.from(actual || "");
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
const reply = (res, code, value) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(value === undefined ? undefined : JSON.stringify(value));
};

/** Per-request MCP facade. Execution stays in NextChat's registered tool executor. */
export function createHostTools() {
  const runs = new Map();
  return {
    begin(tools, server, emit, signal) {
      if (!Array.isArray(tools) || tools.length > 1000)
        throw new Error("Invalid host tools");
      const names = new Set();
      for (const tool of tools) {
        if (
          !tool ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) ||
          names.has(tool.name) ||
          !tool.inputSchema ||
          typeof tool.inputSchema !== "object"
        )
          throw new Error("Invalid host tool definition");
        names.add(tool.name);
      }
      const id = randomUUID();
      const secret = randomBytes(32).toString("hex");
      const pending = new Map();
      const dispose = () => {
        runs.delete(id);
        for (const waiter of pending.values())
          waiter.reject(new Error("Host tool request cancelled"));
        pending.clear();
        signal.removeEventListener("abort", dispose);
      };
      signal.addEventListener("abort", dispose, { once: true });
      const run = { id, secret, tools, names, pending, emit, signal };
      runs.set(id, run);
      if (signal.aborted) dispose();
      return {
        tools,
        config: {
          type: "http",
          url: `http://127.0.0.1:${server.address().port}/v1/runs/${id}/mcp`,
          headers: { Authorization: `Bearer ${secret}` },
        },
        dispose,
      };
    },
    async handle(req, res, route, bridgeToken) {
      const match =
        /^\/v1\/runs\/([a-f0-9-]{36})\/(mcp|results\/([a-f0-9-]{36}))$/.exec(
          route,
        );
      if (!match) return false;
      const run = runs.get(match[1]);
      if (!run) {
        reply(res, 404);
        return true;
      }
      if (
        !authorized(
          req.headers.authorization,
          match[2] === "mcp" ? run.secret : bridgeToken,
        )
      ) {
        reply(res, 401);
        return true;
      }
      if (req.method !== "POST") {
        reply(res, 405);
        return true;
      }
      let rpc;
      try {
        rpc = await readJson(req, 8 * 1024 * 1024);
        if (match[3]) {
          const waiter = run.pending.get(match[3]);
          if (!waiter) {
            reply(res, 404);
            return true;
          }
          if (
            typeof rpc?.content !== "string" ||
            typeof rpc?.isError !== "boolean"
          )
            throw new Error("Invalid host tool result");
          run.pending.delete(match[3]);
          waiter.resolve({
            content: [{ type: "text", text: rpc.content }],
            isError: rpc.isError,
          });
          reply(res, 204);
          return true;
        }
        if (rpc?.jsonrpc !== "2.0" || typeof rpc.method !== "string")
          throw new Error("Invalid MCP request");
        if (rpc.id === undefined) {
          reply(res, 202);
          return true;
        }
        let result;
        if (rpc.method === "initialize")
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "nextchat-tools", version: "1.0.0" },
          };
        else if (rpc.method === "ping") result = {};
        else if (rpc.method === "tools/list") result = { tools: run.tools };
        else if (rpc.method === "tools/call") {
          if (!run.names.has(rpc.params?.name) || run.signal.aborted)
            throw new Error("Tool is not enabled for this request");
          const callId = randomUUID();
          let resolve, reject;
          const completed = new Promise((ok, fail) => {
            resolve = ok;
            reject = fail;
          });
          // Attach handlers before emitting: cancellation may arrive during backpressure.
          completed.catch(() => {});
          run.pending.set(callId, { resolve, reject });
          try {
            await run.emit({
              type: "host_tool_call",
              runId: run.id,
              id: callId,
              name: rpc.params.name,
              input: rpc.params.arguments ?? {},
            });
            result = await completed;
          } finally {
            run.pending.delete(callId);
          }
        } else {
          reply(res, 200, {
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32601, message: "Method not found" },
          });
          return true;
        }
        reply(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
      } catch (error) {
        // MCP method failures are JSON-RPC responses, not HTTP transport
        // failures. Malformed requests and result uploads remain HTTP 400.
        const isRpcCall =
          !match[3] &&
          rpc?.jsonrpc === "2.0" &&
          typeof rpc.method === "string" &&
          rpc.id !== undefined;
        reply(res, isRpcCall ? 200 : 400, {
          jsonrpc: "2.0",
          id: rpc?.id ?? null,
          error: { code: -32602, message: error.message },
        });
      }
      return true;
    },
  };
}
