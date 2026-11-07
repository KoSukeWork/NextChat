import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  FetchLike,
  Transport,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  fetch as nativeFetch,
  getNativeNetworkError,
  isNativeRequestNotSent,
} from "../utils/stream";
import { RemoteServerConfig } from "./types";
import {
  hasManualAuthorization,
  httpUrl,
  McpOAuthProvider,
  OAuthLoginNeeded,
  OAuthPreRegisteredClientRequired,
} from "./oauth";
import {
  McpConnectionError,
  McpReconnectTimeout,
  McpRequestNotSent,
  untilAborted,
} from "./reconnect";

function rpcRequestId(
  body: BodyInit | null | undefined,
): string | number | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const value = JSON.parse(body);
    return value &&
      typeof value.method === "string" &&
      (typeof value.id === "string" || typeof value.id === "number")
      ? value.id
      : undefined;
  } catch {
    return undefined;
  }
}

function connectionRefused(error: unknown) {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth++
  ) {
    const value = current as { code?: unknown; cause?: unknown };
    if (value.code === "ECONNREFUSED") return true;
    current = value.cause;
  }
  return false;
}

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
  if (error instanceof McpRequestNotSent && error.reason === "session")
    return "Remote MCP connection failed (HTTP 404)";
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
    return nativeFetch(
      request.url,
      {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        redirect: request.redirect,
        body: request.body ? await request.text() : undefined,
      },
      { failOnBodyError: true },
    );
  }
  // OAuth token requests use URLSearchParams; the Rust bridge accepts strings.
  return nativeFetch(
    String(input),
    init?.body instanceof URLSearchParams
      ? { ...init, body: init.body.toString() }
      : init,
    { failOnBodyError: true },
  );
};

export async function createRemoteClient(
  id: string,
  config: RemoteServerConfig,
  fetchImpl?: FetchLike,
  authProvider?: OAuthClientProvider,
  signal?: AbortSignal,
): Promise<Client> {
  const url = httpUrl(config.url);
  const manualAuthorization = hasManualAuthorization(config.headers);
  let unauthorized = false;
  let connected = false;
  let resourceMetadataUrl: URL | undefined;
  const dispatches = new Map<string | number, { attempted: boolean }>();
  async function requireDiscoverableOAuth() {
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
    } catch (error) {
      if (
        error instanceof OAuthLoginNeeded ||
        error instanceof OAuthPreRegisteredClientRequired
      )
        throw error;
    }
  }
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
    const requestId = rpcRequestId(init?.body);
    const dispatch =
      requestId === undefined ? undefined : dispatches.get(requestId);
    const firstDispatch = !!dispatch && !dispatch.attempted;
    if (dispatch) dispatch.attempted = true;
    let response: Response;
    try {
      response = await (fetchImpl ?? fetch)(input, { ...init, headers });
    } catch (error) {
      if (firstDispatch && connectionRefused(error))
        throw new McpRequestNotSent("refused");
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      )
        throw error;
      throw new McpConnectionError(error);
    }
    // Native IPC marks a refused connection separately; HTTP 599 and its body
    // alone are untrusted and must never justify replaying a tool request.
    const nativeNetworkError = getNativeNetworkError(response);
    if (
      firstDispatch &&
      nativeNetworkError === "NETWORK_REFUSED" &&
      isNativeRequestNotSent(response)
    ) {
      void response.body?.cancel().catch(() => {});
      throw new McpRequestNotSent("refused");
    }
    if (response.status >= 500) {
      void response.body?.cancel().catch(() => {});
      throw new McpConnectionError(
        nativeNetworkError ?? `Remote MCP HTTP ${response.status}`,
        response.status,
      );
    }
    // A Streamable HTTP 404 with a session id means the server rejected the
    // expired session before processing the JSON-RPC request.
    if (
      firstDispatch &&
      response.status === 404 &&
      target.href === url.href &&
      headers.has("mcp-session-id")
    ) {
      void response.body?.cancel().catch(() => {});
      throw new McpRequestNotSent("session");
    }
    if (target.href === url.href && response.status === 401) {
      unauthorized = true;
      resourceMetadataUrl =
        extractWWWAuthenticateParams(response).resourceMetadataUrl;
      if (authProvider instanceof McpOAuthProvider)
        authProvider.setResourceMetadataUrl(resourceMetadataUrl);
      if (
        connected &&
        requestId !== undefined &&
        !manualAuthorization &&
        !authProvider
      ) {
        try {
          await requireDiscoverableOAuth();
        } catch (error) {
          void response.body?.cancel().catch(() => {});
          throw error;
        }
      }
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
    if (signal?.aborted) throw new McpReconnectTimeout();
    const client = newClient();
    try {
      const instance: Transport = transport();
      if (typeof instance.send === "function") {
        const send = instance.send.bind(instance);
        instance.send = async (message, options) => {
          const id =
            "method" in message && "id" in message ? message.id : undefined;
          const owner = id !== undefined && !dispatches.has(id);
          if (owner) dispatches.set(id, { attempted: false });
          try {
            await send(message, options);
          } finally {
            if (owner) dispatches.delete(id);
          }
        };
      }
      await untilAborted(client.connect(instance), signal, () => {
        void client.close().catch(() => {});
      });
      connected = true;
      return client;
    } catch (error) {
      if (signal?.aborted) {
        void client.close().catch(() => {});
        throw new McpReconnectTimeout();
      }
      await client.close().catch(() => {});
      // The HTTP endpoint could not be reached at all; SSE at the same host
      // and port cannot help. Other failures still try the legacy transport.
      if (error instanceof McpRequestNotSent && error.reason === "refused")
        throw error;
      if (firstError === undefined) {
        firstError = error;
      } else {
        if (unauthorized && !manualAuthorization) {
          await requireDiscoverableOAuth();
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
