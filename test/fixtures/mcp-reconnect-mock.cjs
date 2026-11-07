const http = require("node:http");

/** Loopback-only stateful Streamable HTTP MCP fixture. */
function createMock() {
  const stats = { initialize: 0, rejectedSessions: 0, calls: 0 };
  let session = "";
  let serial = 0;
  let toolMode = "ok";
  let requireLogin = false;
  let initGate;
  let initStarted;
  let initClosed;
  const server = http.createServer(async (req, res) => {
    const origin = `http://${req.headers.host}`;
    if (req.url.startsWith("/.well-known/oauth-protected-resource")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
    }
    if (req.url.startsWith("/.well-known/oauth-authorization-server") || req.url.startsWith("/.well-known/openid-configuration")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"] }));
    }
    if (requireLogin) {
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
      return res.end();
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      return res.end();
    }
    let data = "";
    for await (const part of req) data += part;
    const message = JSON.parse(data);
    if (message.method === "initialize") {
      stats.initialize++;
      session = `synthetic-${++serial}`;
      const thisSession = session;
      initStarted?.();
      if (initGate) {
        const notifyClosed = initClosed;
        res.once("close", () => notifyClosed?.());
        await initGate;
      }
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": thisSession });
      return res.end(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } },
      }));
    }
    if (req.headers["mcp-session-id"] !== session) {
      stats.rejectedSessions++;
      res.writeHead(404);
      return res.end();
    }
    if (message.id === undefined) {
      res.writeHead(202);
      return res.end();
    }
    let result;
    if (message.method === "tools/list") {
      result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
    } else {
      stats.calls++;
      if (toolMode === "disconnect") return req.socket.destroy();
      if (toolMode === "body-disconnect") {
        res.writeHead(200, { "content-type": "application/json", "content-length": "4096" });
        res.write('{"jsonrpc":"2.0",');
        setTimeout(() => res.destroy(), 30);
        return;
      }
      if (toolMode === "http-500") {
        res.writeHead(500);
        return res.end();
      }
      if (toolMode === "invalid" || toolMode === "rpc-closed") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: {
          code: toolMode === "invalid" ? -32602 : -32000,
          message: "synthetic RPC error",
        } }));
      }
      result = toolMode === "error"
        ? { isError: true, content: [{ type: "text", text: "synthetic tool error" }] }
        : { content: [{ type: "text", text: "synthetic result" }] };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  return {
    stats,
    async start(port) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      return `http://127.0.0.1:${server.address().port}/mcp`;
    },
    invalidateSession() { session = "expired"; },
    setToolMode(value) { toolMode = value; },
    requireLogin() { requireLogin = true; },
    holdInitialize() {
      let release;
      let started;
      let closed;
      initGate = new Promise((resolve) => { release = resolve; });
      const startedPromise = new Promise((resolve) => { started = resolve; });
      const closedPromise = new Promise((resolve) => { closed = resolve; });
      initStarted = started;
      initClosed = closed;
      return { started: startedPromise, closed: closedPromise, release() { initGate = undefined; initStarted = undefined; initClosed = undefined; release(); } };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createMock };
