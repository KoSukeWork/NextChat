import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { fetch as nativeFetch } from "../utils/stream";
import { RemoteServerConfig } from "./types";
import {
  hasManualAuthorization,
  httpUrl,
  McpOAuthProvider,
  OAuthLoginNeeded,
  OAuthPreRegisteredClientRequired,
} from "./oauth";

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
  // OAuth token requests use URLSearchParams; the Rust bridge accepts strings.
  return nativeFetch(
    String(input),
    init?.body instanceof URLSearchParams
      ? { ...init, body: init.body.toString() }
      : init,
  );
};

export async function createRemoteClient(
  id: string,
  config: RemoteServerConfig,
  fetchImpl?: FetchLike,
  authProvider?: OAuthClientProvider,
): Promise<Client> {
  const url = httpUrl(config.url);
  const manualAuthorization = hasManualAuthorization(config.headers);
  let unauthorized = false;
  let resourceMetadataUrl: URL | undefined;
  const guardedFetch: FetchLike = async (input, init) => {
    const target = httpUrl(
      input instanceof Request ? input.url : String(input),
    );
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init?.headers).forEach((value, name) =>
      headers.set(name, value),
    );
    // SDK discovery/token requests must not inherit user-supplied MCP headers.
    if (target.href !== url.href && (!authProvider || manualAuthorization)) {
      for (const name of Object.keys(config.headers ?? {}))
        headers.delete(name);
    } else if (
      target.href === url.href &&
      authProvider &&
      !manualAuthorization
    ) {
      // OAuth discovery must not inherit these headers through requestInit.
      for (const [name, value] of Object.entries(config.headers ?? {})) {
        if (!headers.has(name)) headers.set(name, value);
      }
    }
    const response = await (fetchImpl ?? fetch)(input, { ...init, headers });
    if (target.href === url.href && response.status === 401) {
      unauthorized = true;
      resourceMetadataUrl =
        extractWWWAuthenticateParams(response).resourceMetadataUrl;
      if (authProvider instanceof McpOAuthProvider)
        authProvider.setResourceMetadataUrl(resourceMetadataUrl);
    }
    return response;
  };
  const options = {
    requestInit: {
      headers: authProvider && !manualAuthorization ? {} : config.headers ?? {},
    },
    fetch: guardedFetch,
    authProvider: manualAuthorization ? undefined : authProvider,
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
        if (unauthorized && !manualAuthorization) {
          try {
            const info = await discoverOAuthServerInfo(url, {
              resourceMetadataUrl,
              fetchFn: guardedFetch,
            });
            const metadata = info.authorizationServerMetadata;
            if (metadata?.authorization_endpoint && metadata.token_endpoint) {
              httpUrl(metadata.authorization_endpoint);
              httpUrl(metadata.token_endpoint);
              if (!metadata.registration_endpoint)
                throw new OAuthPreRegisteredClientRequired();
              httpUrl(metadata.registration_endpoint);
              throw new OAuthLoginNeeded(resourceMetadataUrl?.href);
            }
          } catch (discoveryError) {
            if (
              discoveryError instanceof OAuthLoginNeeded ||
              discoveryError instanceof OAuthPreRegisteredClientRequired
            )
              throw discoveryError;
          }
        }
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
