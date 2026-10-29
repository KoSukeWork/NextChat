import { isTauri } from "../../mcp/tauri-api";
import { getClientConfig } from "../../config/client";

export const isDesktopSync = () => isTauri() || !!getClientConfig()?.isApp;

export class SyncError extends Error {
  constructor(
    public code: string,
    public status?: number,
  ) {
    super(code);
  }
}

export function validateEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new SyncError("INVALID_ENDPOINT");
  }
}

export function assertStatus(status: number) {
  if (status < 200 || status >= 300) throw new SyncError("HTTP", status);
}

export async function cloudRequest(options: {
  endpoint: string;
  path: string;
  proxyPath: string;
  method: string;
  proxyMethod?: string;
  headers: Record<string, string>;
  credentials: { username?: string; password?: string; token?: string };
  body?: string;
}): Promise<{ status: number; body: string }> {
  validateEndpoint(options.endpoint);
  try {
    if (isDesktopSync()) {
      // The v1 global IPC retains structured errors, unlike stream_fetch's 599.
      return await window.__TAURI__!.invoke("sync_http", {
        request: {
          endpoint: options.endpoint,
          path: options.path,
          method: options.method,
          ...options.credentials,
          body: options.body,
        },
      });
    }
    const response = await fetch(options.proxyPath, {
      method: options.proxyMethod ?? options.method,
      headers: options.headers,
      body: options.body,
      redirect: "error",
    });
    return {
      status: response.status,
      body: response.ok ? await response.text() : "",
    };
  } catch (error) {
    // Never expose raw errors, URLs, credentials, or server-provided text.
    const code = (error as { code?: unknown })?.code;
    const known = [
      "NETWORK_TIMEOUT",
      "NETWORK_DNS",
      "NETWORK_TLS",
      "NETWORK_REFUSED",
      "NETWORK_CONNECT",
      "INVALID_ENDPOINT",
    ];
    throw new SyncError(
      typeof code === "string" && known.includes(code)
        ? code
        : "NETWORK_FAILED",
    );
  }
}

export function proxyPath(
  prefix: string,
  path: string,
  endpoint: string,
  proxy = "",
  method?: string,
) {
  const query = new URLSearchParams({ endpoint });
  if (method) query.set("proxy_method", method);
  return `${proxy.replace(/\/$/, "")}${prefix}${path}?${query}`;
}
