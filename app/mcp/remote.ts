import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { fetch as nativeFetch } from "../utils/stream";
import { RemoteServerConfig } from "./types";

function statusOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "number" && code >= 400 && code <= 599) return code;
  const message = error instanceof Error ? error.message : String(error);
  if (/unauthorized/i.test(message)) return 401;
  const match = message.match(/(?:HTTP\s*|status(?: code)?\s*\(?)([45]\d\d)/i);
  return match ? Number(match[1]) : undefined;
}

// Never return the server's text or a raw exception: either can echo credentials.
export function safeRemoteError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = statusOf(error);
  if (status && status !== 599)
    return `Remote MCP connection failed (HTTP ${status})`;
  if (/NETWORK_TIMEOUT|timed? ?out/i.test(message))
    return "Remote MCP network request timed out";
  if (/NETWORK_REFUSED|ECONNREFUSED|connection (?:was )?refused/i.test(message))
    return "Remote MCP network connection was refused";
  if (/NETWORK_DNS|ENOTFOUND|DNS/i.test(message))
    return "Remote MCP DNS lookup failed";
  if (/NETWORK_TLS|certificate|TLS/i.test(message))
    return "Remote MCP TLS connection failed";
  if (/NETWORK_CONNECT/i.test(message))
    return "Remote MCP network connection failed";
  return "Remote MCP network or protocol request failed";
}

/** Adapt the SDK's FetchLike interface to the native, streaming Rust HTTP bridge. */
export const nativeMcpFetch: FetchLike = async (input, init) => {
  if (input instanceof Request) {
    const request = new Request(input, init);
    return nativeFetch(request.url, {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      redirect: request.redirect,
      body: request.body ? await request.text() : undefined,
    });
  }
  return nativeFetch(String(input), init);
};

export async function createRemoteClient(
  id: string,
  config: RemoteServerConfig,
  fetchImpl?: FetchLike,
): Promise<Client> {
  const url = new URL(config.url);
  const options = {
    requestInit: { headers: config.headers ?? {} },
    fetch: fetchImpl,
  };
  const newClient = () =>
    new Client(
      { name: `nextchat-mcp-client-${id}`, version: "1.0.0" },
      { capabilities: {} },
    );
  let firstError: unknown;
  for (const transport of [
    () => new StreamableHTTPClientTransport(url, options),
    () => new SSEClientTransport(url, options),
  ]) {
    const client = newClient();
    try {
      await client.connect(transport());
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      if (firstError === undefined) {
        firstError = error;
      } else {
        const firstStatus = statusOf(firstError);
        const secondStatus = statusOf(error);
        const chosen =
          firstStatus === 401 ||
          firstStatus === 403 ||
          firstStatus === 599 ||
          (firstStatus && firstStatus >= 500 && secondStatus === 404)
            ? firstError
            : error;
        throw new Error(safeRemoteError(chosen));
      }
    }
  }
  throw new Error(safeRemoteError(firstError));
}
