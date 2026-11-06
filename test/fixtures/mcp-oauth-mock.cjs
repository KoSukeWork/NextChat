const http = require("node:http");
const crypto = require("node:crypto");

/** Loopback-only OAuth + MCP server for tests; it never logs codes or tokens. */
function createMock() {
  let origin = "";
  let next = 0;
  const clients = new Map();
  const codes = new Map();
  const tokens = new Set();
  const refreshTokens = new Set();
  const stats = {
    metadata: 0,
    registrations: 0,
    authorizations: 0,
    exchanges: 0,
    refreshes: 0,
    mcp: 0,
    metadataHeaderLeaks: 0,
  };
  const options = {
    metadata: true,
    dcr: true,
    denied: false,
    badState: false,
    refreshFail: false,
  };
  const makeId = () => crypto.randomBytes(18).toString("base64url");
  const json = (res, status, body) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  };
  const read = async (req) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    return body;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const resource = `${origin}/mcp`;
      if (url.pathname !== "/mcp" && req.headers["x-mcp-secret"])
        stats.metadataHeaderLeaks++;
      if (url.pathname === "/control" && req.method === "POST") {
        const update = JSON.parse(await read(req));
        for (const key of Object.keys(options))
          if (typeof update[key] === "boolean") options[key] = update[key];
        if (update.expire === true) tokens.clear();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/stats") return json(res, 200, { ...stats });
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        stats.metadata++;
        return options.metadata
          ? json(res, 200, { resource, authorization_servers: [origin] })
          : json(res, 404, {});
      }
      if (
        url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
        url.pathname.startsWith("/.well-known/openid-configuration")
      ) {
        stats.metadata++;
        if (!options.metadata) return json(res, 404, {});
        return json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          ...(options.dcr
            ? { registration_endpoint: `${origin}/register` }
            : {}),
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && req.method === "POST") {
        stats.registrations++;
        if (!options.dcr) return json(res, 404, {});
        const metadata = JSON.parse(await read(req));
        if (
          !Array.isArray(metadata.redirect_uris) ||
          metadata.redirect_uris.length !== 1
        )
          return json(res, 400, { error: "invalid_redirect_uri" });
        const client_id = `client-${++next}`;
        clients.set(client_id, metadata.redirect_uris[0]);
        return json(res, 201, { client_id, ...metadata });
      }
      if (url.pathname === "/authorize" && req.method === "GET") {
        stats.authorizations++;
        const clientId = url.searchParams.get("client_id");
        const redirect = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state");
        const challenge = url.searchParams.get("code_challenge");
        if (
          !clientId ||
          clients.get(clientId) !== redirect ||
          !state ||
          !challenge ||
          url.searchParams.get("code_challenge_method") !== "S256"
        )
          return json(res, 400, { error: "invalid_request" });
        const target = new URL(redirect);
        target.searchParams.set(
          "state",
          options.badState ? "incorrect-state" : state,
        );
        if (options.denied) target.searchParams.set("error", "access_denied");
        else {
          const code = makeId();
          codes.set(code, { clientId, redirect, challenge });
          target.searchParams.set("code", code);
        }
        res.writeHead(302, {
          location: target.href,
          "cache-control": "no-store",
        });
        return res.end();
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const params = new URLSearchParams(await read(req));
        const grant = params.get("grant_type");
        if (grant === "authorization_code") {
          stats.exchanges++;
          const code = params.get("code");
          const pending = codes.get(code);
          codes.delete(code);
          const challenge = crypto
            .createHash("sha256")
            .update(params.get("code_verifier") || "")
            .digest("base64url");
          if (
            !pending ||
            pending.clientId !== params.get("client_id") ||
            pending.redirect !== params.get("redirect_uri") ||
            pending.challenge !== challenge
          )
            return json(res, 400, { error: "invalid_grant" });
        } else if (grant === "refresh_token") {
          stats.refreshes++;
          if (
            options.refreshFail ||
            !refreshTokens.has(params.get("refresh_token"))
          )
            return json(res, 400, { error: "invalid_grant" });
        } else return json(res, 400, { error: "unsupported_grant_type" });
        const access = makeId(),
          refresh = makeId();
        tokens.add(access);
        refreshTokens.add(refresh);
        return json(res, 200, {
          access_token: access,
          token_type: "Bearer",
          refresh_token: refresh,
          expires_in: 3600,
        });
      }
      if (url.pathname === "/mcp") {
        stats.mcp++;
        const token = (req.headers.authorization || "").replace(
          /^Bearer\s+/i,
          "",
        );
        if (!tokens.has(token)) {
          res.writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          });
          return res.end();
        }
        if (req.method === "GET") {
          res.writeHead(405);
          return res.end();
        }
        if (req.method !== "POST") {
          res.writeHead(405);
          return res.end();
        }
        const message = JSON.parse(await read(req));
        if (message.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "oauth-mock", version: "1" },
              }
            : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "echo",
                    description: "Synthetic echo",
                    inputSchema: {
                      type: "object",
                      properties: { text: { type: "string" } },
                    },
                  },
                ],
              }
            : {
                content: [
                  {
                    type: "text",
                    text: message.params?.arguments?.text || "ok",
                  },
                ],
              };
        return json(res, 200, { jsonrpc: "2.0", id: message.id, result });
      }
      return json(res, 404, {});
    } catch {
      return json(res, 500, { error: "mock_error" });
    }
  });
  return {
    server,
    async start(port = 0) {
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      origin = `http://127.0.0.1:${server.address().port}`;
      return origin;
    },
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

module.exports = { createMock };
if (require.main === module) {
  const mock = createMock();
  mock
    .start(Number(process.env.NEXTCHAT_MOCK_PORT || 0))
    .then((origin) => console.log(JSON.stringify({ origin })));
}
