import { parseMcpConfig, parsePastedMcpConfig } from "../app/mcp/config";
import { safeRemoteError } from "../app/mcp/remote";

test("accepts old local and remote configurations and supplies local defaults", () => {
  expect(
    parseMcpConfig({
      mcpServers: {
        local: { command: "node" },
        remote: {
          url: "https://example.test/mcp/",
          headers: { Authorization: "Bearer secret" },
        },
      },
    }),
  ).toEqual({
    mcpServers: {
      local: { command: "node", args: [] },
      remote: {
        url: "https://example.test/mcp/",
        headers: { Authorization: "Bearer secret" },
      },
    },
  });
});

test("paste accepts common metadata, maps disabled and keeps stored fields only", () => {
  const sample = {
    version: 1,
    mcpServers: {
      remote: {
        type: "streamable-http",
        transport: "http",
        name: "example",
        description: "unused",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer test" },
        disabled: true,
      },
      local: {
        type: "stdio",
        name: "local",
        command: "node",
        args: ["server.js"],
        env: { MODE: "test" },
        disabled: false,
      },
    },
  };
  expect(parsePastedMcpConfig(sample)).toEqual({
    mcpServers: {
      remote: {
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer test" },
        status: "paused",
      },
      local: { command: "node", args: ["server.js"], env: { MODE: "test" } },
    },
  });
  expect(() => parseMcpConfig(sample)).toThrow();
});

test.each([
  { mcpServers: { remote: { type: "sse", url: "file:///etc/passwd" } } },
  { mcpServers: { remote: { url: "https://example.test", command: "node" } } },
  {
    mcpServers: {
      remote: {
        url: "https://example.test",
        headers: { Authorization: "bad\r\nheader" },
      },
    },
  },
  JSON.parse('{"mcpServers":{"__proto__":{"command":"node","type":"stdio"}}}'),
])("paste rejects unsafe or ambiguous configuration", (value) => {
  expect(() => parsePastedMcpConfig(value)).toThrow();
});

test.each([
  { mcpServers: { a: { url: "file:///tmp/server" } } },
  { mcpServers: { a: { url: "https://example.test", command: "node" } } },
  {
    mcpServers: {
      a: { url: "https://example.test", headers: { "Bad Header": "value" } },
    },
  },
  {
    mcpServers: {
      a: {
        url: "https://example.test",
        headers: { Authorization: "bad\r\nvalue" },
      },
    },
  },
  { mcpServers: { a: { command: "node", args: "not an array" } } },
  JSON.parse('{"mcpServers":{"__proto__":{"command":"node"}}}'),
])("rejects malformed or unsafe MCP config", (value) => {
  expect(() => parseMcpConfig(value)).toThrow(
    "Invalid MCP server configuration",
  );
});

test("remote errors expose status and network category but not server-provided secrets", () => {
  const error = Object.assign(
    new Error("HTTP 401 reflected Bearer private-token"),
    { code: 401 },
  );
  expect(safeRemoteError(error)).toContain("401");
  expect(safeRemoteError(error)).not.toContain("private-token");
  expect(safeRemoteError(new Error("NETWORK_REFUSED private-token"))).toContain(
    "refused",
  );
  expect(
    safeRemoteError(new Error("NETWORK_REFUSED private-token")),
  ).not.toContain("private-token");
});
