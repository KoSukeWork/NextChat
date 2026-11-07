import { jest } from "@jest/globals";

const attempts: string[] = [];
const options: any[] = [];
let closeCount = 0;
let failure: "first" | "both" | "refused" = "first";
const { McpRequestNotSent } = await import("../app/mcp/reconnect");
jest.unstable_mockModule("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(transport: { kind: string }) {
      attempts.push(transport.kind);
      if (failure === "refused") throw new McpRequestNotSent("refused");
      if (transport.kind === "http" || failure === "both") {
        throw Object.assign(new Error("HTTP 401 Bearer do-not-log"), {
          code: failure === "both" ? 401 : 405,
        });
      }
    }
    async close() {
      closeCount++;
    }
  },
}));
jest.unstable_mockModule(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
  () => ({
    StreamableHTTPClientTransport: class {
      kind = "http";
      constructor(_url: URL, opts: unknown) {
        options.push(opts);
      }
    },
  }),
);
jest.unstable_mockModule("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    kind = "sse";
    constructor(_url: URL, opts: unknown) {
      options.push(opts);
    }
  },
}));
const { createRemoteClient, safeRemoteError } = await import(
  "../app/mcp/remote"
);

beforeEach(() => {
  attempts.length = 0;
  options.length = 0;
  closeCount = 0;
  failure = "first";
});

test("does not try SSE when Streamable HTTP proves the connection was refused", async () => {
  failure = "refused";
  await expect(createRemoteClient("id", { url: "http://127.0.0.1:45670/mcp" }))
    .rejects.toBeInstanceOf(McpRequestNotSent);
  expect(attempts).toEqual(["http"]);
  expect(closeCount).toBe(1);
});

test("tries Streamable HTTP before SSE and forwards request headers to both", async () => {
  await createRemoteClient("id", {
    url: "https://example.test/mcp",
    headers: { Authorization: "Bearer test" },
  });
  expect(attempts).toEqual(["http", "sse"]);
  expect(closeCount).toBe(1);
  expect(options).toHaveLength(2);
  expect(
    options.every(
      (option) => option.requestInit.headers.Authorization === "Bearer test",
    ),
  ).toBe(true);
});

test("failed connection reports 401 without exposing server-provided credentials", async () => {
  failure = "both";
  await expect(
    createRemoteClient("id", {
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer do-not-log" },
    }),
  ).rejects.toThrow("HTTP 401");
  try {
    await createRemoteClient("id", { url: "https://example.test/mcp" });
  } catch (error) {
    expect(String(error)).not.toContain("do-not-log");
  }
  expect(closeCount).toBe(4);
});

test("sanitized connection errors retain their reason when sanitized again", () => {
  const once = safeRemoteError(new Error("NETWORK_REFUSED secret"));
  expect(once).toBe("Remote MCP network connection was refused");
  expect(safeRemoteError(new Error(once))).toBe(once);
});
