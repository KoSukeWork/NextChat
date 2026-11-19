// ACP only accepts stdio MCP servers. This process forwards one request's
// MCP messages to the host's short-lived loopback facade.
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";

const address = new URL(process.env.NEXTCHAT_MCP_URL || "");
const token = process.env.NEXTCHAT_MCP_TOKEN || "";
if (
  address.protocol !== "http:" ||
  address.hostname !== "127.0.0.1" ||
  !address.port ||
  address.username ||
  address.password ||
  token.length < 16
)
  throw new Error("Invalid NextChat MCP endpoint");

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let request;
  try {
    if (line.length > 8 * 1024 * 1024) throw new Error("MCP request too large");
    request = JSON.parse(line);
    if (request?.jsonrpc !== "2.0" || typeof request.method !== "string")
      throw new Error("Invalid MCP request");
    if (request.method === "server/discover") {
      if (request.id !== undefined)
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: "Method not found" },
          }) + "\n",
        );
      continue;
    }
    const response = await fetch(address, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(180000),
    });
    if (request.id !== undefined) {
      if (!response.ok)
        throw new Error("NextChat tool endpoint is unavailable");
      let body = await response.text();
      if (body.length > 8 * 1024 * 1024)
        throw new Error("MCP response too large");
      if (request.method === "tools/list") {
        const value = JSON.parse(body);
        if (!Array.isArray(value?.result?.tools))
          throw new Error("Invalid tool list");
        value.result.tools = value.result.tools.map((tool) => ({
          ...tool,
          _meta: { ...tool._meta, "antigravity/alwaysLoad": true },
        }));
        body = JSON.stringify(value);
        if (process.env.NEXTCHAT_MCP_READY)
          await writeFile(process.env.NEXTCHAT_MCP_READY, "ready", {
            mode: 0o600,
          });
      }
      process.stdout.write(body + "\n");
    }
  } catch {
    if (request?.id !== undefined)
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: "NextChat tool endpoint failed" },
        }) + "\n",
      );
  }
}
