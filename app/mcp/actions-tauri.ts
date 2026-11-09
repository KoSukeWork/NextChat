import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import type * as ServerActions from "./actions";
import type {
  McpConfigData,
  ServerConfig,
  ServerStatusResponse,
  ListToolsResponse,
} from "./types";
import { isRemoteServer } from "./types";
import { parseMcpConfig } from "./config";
import { createRemoteClient, nativeMcpFetch, safeRemoteError } from "./remote";
import {
  auth,
  discoverOAuthServerInfo,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  hasManualAuthorization,
  httpUrl,
  McpOAuthProvider,
  OAuthLoginNeeded,
  OAuthPreRegisteredClientRequired,
  type OAuthCredentials,
} from "./oauth";
import { invoke, isTauri } from "./tauri-api";
import { TauriStdioTransport } from "./tauri-transport";
import { getLang } from "../locales";
import {
  isLocalMcpRequestTimeout,
  isMcpConnectionFailure,
  McpCallTracker,
  McpReconnectTimeout,
  McpRequestNotSent,
  ReconnectCoordinator,
  untilAborted,
} from "./reconnect";

interface Entry {
  client: Client | null;
  remote: boolean;
  tools: ListToolsResponse | null;
  status:
    | "initializing"
    | "active"
    | "error"
    | "login-required"
    | "oauth-unsupported";
  errorMsg: string | null;
  oauthAuthenticated?: boolean;
  oauthMetadataUrl?: string;
}
const clients = new Map<string, Entry>();
const pendingOAuth = new Map<string, string>();
const oauthEpochs = new Map<string, number>();
const callTracker = new McpCallTracker();
const safeOrigins = new WeakSet<Entry>();
let mutations: Promise<unknown> = Promise.resolve();
let oauthMutations: Promise<unknown> = Promise.resolve();
let pendingUserMutations = 0;
const allServers = Symbol("all MCP servers");

// Keep read/modify/write and start/stop operations ordered, including concurrent UI clicks.
function mutate<T>(
  operation: () => Promise<T>,
  preempt?: string | string[] | typeof allServers,
): Promise<T> {
  if (Array.isArray(preempt)) preempt.forEach((id) => reconnects.cancel(id));
  else if (preempt === allServers) reconnects.cancel();
  else if (preempt !== undefined) reconnects.cancel(preempt);
  pendingUserMutations++;
  const result = mutations.then(operation).finally(() => {
    pendingUserMutations--;
  });
  mutations = result.catch(() => {});
  return result;
}

function mutateOAuth<T>(operation: () => Promise<T>): Promise<T> {
  const result = oauthMutations.then(operation);
  oauthMutations = result.catch(() => {});
  return result;
}

async function invalidateOAuth(id: string) {
  oauthEpochs.set(id, (oauthEpochs.get(id) ?? 0) + 1);
  const pending = pendingOAuth.get(id);
  if (pending) {
    pendingOAuth.delete(id);
    await invoke("mcp_oauth_cancel", { id: pending });
  }
}

const readConfig = async () =>
  parseMcpConfig(await invoke<McpConfigData>("mcp_read_config"));
const writeConfig = (config: McpConfigData) =>
  invoke<void>("mcp_write_config", { config, language: getLang() });

async function stop(id: string) {
  const entry = clients.get(id);
  clients.delete(id);
  if (entry?.client) await entry.client.close();
  else await invoke("mcp_kill", { id });
}

async function start(id: string, server: ServerConfig, signal?: AbortSignal) {
  const remote = isRemoteServer(server);
  const entry: Entry = {
    client: null,
    remote,
    tools: null,
    status: "initializing",
    errorMsg: null,
  };
  let client: Client | null = null;
  try {
    if (signal) {
      if (signal.aborted) throw new McpReconnectTimeout();
      const previous = clients.get(id);
      clients.set(id, entry);
      // Close only the old client generation. A future native spawn itself
      // replaces any stale process, without an unscoped late kill.
      if (previous?.client) {
        if (previous.remote) {
          const old = previous.client;
          callTracker.retire(old, () => {
            void old.close().catch(() => {});
          });
        } else await untilAborted(previous.client.close(), signal);
      }
    } else {
      await stop(id);
      clients.set(id, entry);
    }
    if (signal?.aborted) throw new McpReconnectTimeout();
    if (remote) {
      const url = httpUrl(server.url).href;
      const epoch = oauthEpochs.get(id) ?? 0;
      const credentials = !hasManualAuthorization(server.headers)
        ? await untilAborted(
            invoke<OAuthCredentials | null>("mcp_oauth_read", { id, url }),
            signal,
          )
        : null;
      const provider =
        credentials?.tokens &&
        credentials.client &&
        (oauthEpochs.get(id) ?? 0) === epoch
          ? new McpOAuthProvider(
              credentials,
              (next) =>
                mutateOAuth(async () => {
                  if ((oauthEpochs.get(id) ?? 0) !== epoch)
                    throw new Error("MCP server changed");
                  await invoke("mcp_oauth_write", {
                    id,
                    url,
                    credentials: next,
                  });
                }),
              false,
            )
          : undefined;
      entry.oauthAuthenticated = !!provider;
      const connecting = createRemoteClient(
        id,
        server,
        nativeMcpFetch,
        provider,
        signal,
      );
      client = await untilAborted(connecting, signal, () => {
        void connecting.then((late) => late.close()).catch(() => {});
      });
    } else {
      client = new Client(
        { name: `nextchat-mcp-client-${id}`, version: "1.0.0" },
        { capabilities: {} },
      );
      await untilAborted(
        client.connect(new TauriStdioTransport(id)),
        signal,
        () => {
          void client?.close().catch(() => {});
        },
      );
    }
    if (signal?.aborted) throw new McpReconnectTimeout();
    entry.client = client;
    client.onerror = (error) => {
      if (error instanceof OAuthLoginNeeded) {
        entry.status = "login-required";
        entry.oauthMetadataUrl = error.resourceMetadataUrl;
        entry.tools = null;
        entry.errorMsg = "OAuth login required";
      } else if (error instanceof OAuthPreRegisteredClientRequired) {
        entry.status = "oauth-unsupported";
        entry.tools = null;
        entry.errorMsg = "OAuth server requires a pre-registered client";
      } else if (
        clients.get(id) === entry &&
        isMcpConnectionFailure(error, client ?? undefined)
      ) {
        entry.status = "error";
        entry.tools = null;
        entry.errorMsg = remote ? safeRemoteError(error) : error.message;
      }
    };
    client.onclose = () => {
      if (clients.get(id) === entry) {
        if (
          entry.status !== "login-required" &&
          entry.status !== "oauth-unsupported"
        )
          entry.status = "error";
        entry.tools = null;
        entry.errorMsg ??= "MCP server disconnected";
      }
    };
    const tools = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await untilAborted(
        client.listTools(cursor ? { cursor } : undefined, { signal }),
        signal,
        () => {
          void client?.close().catch(() => {});
        },
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor))
        throw new Error("Invalid MCP tool pagination");
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (entry.status === "error")
      throw new Error(entry.errorMsg ?? "MCP server disconnected");
    entry.tools = { tools };
    entry.status = "active";
    entry.errorMsg = null;
    reconnects.reset(id);
  } catch (error) {
    entry.status =
      error instanceof OAuthLoginNeeded
        ? "login-required"
        : error instanceof OAuthPreRegisteredClientRequired
        ? "oauth-unsupported"
        : "error";
    entry.oauthMetadataUrl =
      error instanceof OAuthLoginNeeded ? error.resourceMetadataUrl : undefined;
    entry.errorMsg = remote
      ? safeRemoteError(error)
      : error instanceof Error
      ? error.message
      : String(error);
    if (signal?.aborted) void client?.close().catch(() => {});
    else await client?.close().catch(() => {});
    throw new Error(entry.errorMsg);
  }
}

async function startConfigured(config: McpConfigData) {
  await Promise.all(
    Object.entries(config.mcpServers)
      .filter(([id, server]) => server.status !== "paused" && !clients.has(id))
      .map(([id, server]) =>
        start(id, server).catch(() => {
          /* Expose startup errors through getClientsStatus. */
        }),
      ),
  );
}

const reconnects = new ReconnectCoordinator(async (ids, signal) => {
  if (signal.aborted || pendingUserMutations) return "skipped";
  const config = await untilAborted(readConfig(), signal);
  const id = ids[0];
  const server = config.mcpServers[id];
  if (
    signal.aborted ||
    pendingUserMutations ||
    !server ||
    server.status === "paused" ||
    clients.get(id)?.status !== "error"
  )
    return "skipped";
  try {
    await start(id, server, signal);
    return "success";
  } catch {
    return signal.aborted ? "skipped" : "failure";
  }
});

function retryFailed(
  ids?: string[],
  mode: "message" | "force" = "force",
  excluded: Set<string> = new Set(),
) {
  const selected = ids ?? [
    ...new Set([
      ...[...clients.entries()]
        .filter(([, entry]) => entry.status === "error")
        .map(([id]) => id),
      ...reconnects.pendingIds(),
    ]),
  ];
  return reconnects.reconnect(
    selected.filter((id) => !excluded.has(id)),
    mode,
  );
}

export const isMcpEnabled: typeof ServerActions.isMcpEnabled = async () =>
  isTauri();

export const getMcpConfigFromFile: typeof ServerActions.getMcpConfigFromFile =
  async (_accessCode) => readConfig();

export const getClientsStatus: typeof ServerActions.getClientsStatus = async (
  _accessCode,
) => {
  const config = await readConfig();
  const result: Record<string, ServerStatusResponse> = {};
  for (const [id, server] of Object.entries(config.mcpServers)) {
    const entry = clients.get(id);
    const saved =
      server.status === "paused" &&
      isRemoteServer(server) &&
      !hasManualAuthorization(server.headers)
        ? await invoke<OAuthCredentials | null>("mcp_oauth_read", {
            id,
            url: httpUrl(server.url).href,
          })
        : null;
    result[id] =
      server.status === "paused"
        ? {
            status: "paused",
            errorMsg: null,
            ...(saved?.tokens && saved.client
              ? { oauthAuthenticated: true }
              : {}),
          }
        : {
            status: entry?.status ?? "undefined",
            errorMsg: entry?.errorMsg ?? null,
            ...(entry?.oauthAuthenticated ? { oauthAuthenticated: true } : {}),
          };
  }
  return result;
};

export const getClientTools: typeof ServerActions.getClientTools = async (
  id,
  _accessCode,
) => clients.get(id)?.tools ?? null;
export const getAvailableClientsCount: typeof ServerActions.getAvailableClientsCount =
  async (_accessCode) =>
    [...clients.values()].filter((entry) => entry.status === "active").length;
export const getAllTools: typeof ServerActions.getAllTools = async (
  _accessCode,
  excludedIds = [],
) => {
  const excluded = new Set(excludedIds);
  await retryFailed(undefined, "message", excluded);
  return [...clients.entries()]
    .filter(
      ([id, entry]) =>
        !excluded.has(id) && entry.status === "active" && entry.tools !== null,
    )
    .map(([clientId, entry]) => ({ clientId, tools: entry.tools! }));
};

export const reconnectMcpErrors: typeof ServerActions.reconnectMcpErrors =
  async (_accessCode) => retryFailed();

export const initializeMcpSystem: typeof ServerActions.initializeMcpSystem =
  async (_accessCode) =>
    mutate(async () => {
      const config = await readConfig();
      await startConfigured(config);
      return config;
    });

export const addMcpServer: typeof ServerActions.addMcpServer = async (
  id,
  server,
  _accessCode,
) =>
  mutate(async () => {
    const config = await readConfig();
    const incoming = parseMcpConfig({ mcpServers: { [id]: server } });
    config.mcpServers[id] = {
      ...incoming.mcpServers[id],
      status: server.status ?? "active",
    };
    // Native approval happens before changing a running connection.
    await mutateOAuth(async () => {
      await writeConfig(config);
      await invalidateOAuth(id);
    });
    if (server.status === "paused") await stop(id);
    else await start(id, config.mcpServers[id]).catch(() => {});
    return config;
  }, id);

export const pauseMcpServer: typeof ServerActions.pauseMcpServer = async (
  id,
  _accessCode,
) =>
  mutate(async () => {
    const config = await readConfig();
    if (!config.mcpServers[id]) throw new Error(`Server ${id} not found`);
    config.mcpServers[id].status = "paused";
    await mutateOAuth(async () => {
      await writeConfig(config);
      await invalidateOAuth(id);
    });
    await stop(id);
    return config;
  }, id);

export const resumeMcpServer: typeof ServerActions.resumeMcpServer = async (
  id,
  _accessCode,
) =>
  mutate(async () => {
    const config = await readConfig();
    if (!config.mcpServers[id]) throw new Error(`Server ${id} not found`);
    config.mcpServers[id].status = "active";
    await mutateOAuth(async () => {
      await writeConfig(config);
      await invalidateOAuth(id);
    });
    await start(id, config.mcpServers[id]);
  }, id);

export const removeMcpServer: typeof ServerActions.removeMcpServer = async (
  id,
  _accessCode,
) =>
  mutate(async () => {
    const config = await readConfig();
    delete config.mcpServers[id];
    await mutateOAuth(async () => {
      await writeConfig(config);
      await invalidateOAuth(id);
    });
    await stop(id);
    return config;
  }, id);

export const restartAllClients: typeof ServerActions.restartAllClients = async (
  _accessCode,
) =>
  mutate(async () => {
    for (const id of [...clients.keys()]) await stop(id);
    const config = await readConfig();
    await startConfigured(config);
    return config;
  }, allServers);

export const executeMcpAction: typeof ServerActions.executeMcpAction = async (
  id,
  request,
  _accessCode,
) => {
  const initialServer = (await readConfig()).mcpServers[id];
  if (!initialServer || initialServer.status === "paused")
    throw new Error(`MCP server ${id} is not connected`);
  const initialEpoch = oauthEpochs.get(id) ?? 0;
  let entry = clients.get(id);
  if (entry?.status === "error" || reconnects.pendingIds().includes(id)) {
    await retryFailed([id]);
    entry = clients.get(id);
  }
  if (!entry || entry.status !== "active")
    throw new Error(`MCP server ${id} is not connected`);
  const markError = (current: Entry, error: unknown) => {
    if (
      clients.get(id) !== current ||
      current.status === "login-required" ||
      current.status === "oauth-unsupported"
    )
      return false;
    if (error instanceof OAuthLoginNeeded) {
      current.status = "login-required";
      current.oauthMetadataUrl = error.resourceMetadataUrl;
      current.errorMsg = "OAuth login required";
      current.tools = null;
      return false;
    }
    if (error instanceof OAuthPreRegisteredClientRequired) {
      current.status = "oauth-unsupported";
      current.errorMsg = "OAuth server requires a pre-registered client";
      current.tools = null;
      return false;
    }
    if (!isMcpConnectionFailure(error, current.client ?? undefined))
      return false;
    current.status = "error";
    current.tools = null;
    current.errorMsg = current.remote
      ? safeRemoteError(error)
      : error instanceof Error
      ? error.message
      : String(error);
    return true;
  };
  const callOnce = async (current: Entry) => {
    const client = current.client!;
    return callTracker.run(client, async () => {
      if (clients.get(id) !== current || current.status !== "active")
        throw new Error("MCP server changed");
      if ("transport" in client && !client.transport)
        throw new McpRequestNotSent("closed");
      const call = client.request as (
        requestMessage: typeof request,
        schema: unknown,
      ) => Promise<unknown>;
      return await call.call(client, request, z.any());
    });
  };
  try {
    return await callOnce(entry);
  } catch (error) {
    const marked = markError(entry, error);
    if (marked && error instanceof McpRequestNotSent) safeOrigins.add(entry);
    const retry =
      error instanceof McpRequestNotSent &&
      safeOrigins.has(entry) &&
      (marked || reconnects.pendingIds().includes(id));
    if (retry) {
      await retryFailed([id]);
      const replacement = clients.get(id);
      const latest = (await readConfig()).mcpServers[id];
      if (
        replacement?.status === "active" &&
        latest &&
        latest.status !== "paused" &&
        JSON.stringify(latest) === JSON.stringify(initialServer) &&
        (oauthEpochs.get(id) ?? 0) === initialEpoch
      ) {
        try {
          return await callOnce(replacement);
        } catch (retryError) {
          markError(replacement, retryError);
          if (isLocalMcpRequestTimeout(retryError)) throw retryError;
          if (replacement.remote) throw new Error(safeRemoteError(retryError));
          throw retryError;
        }
      }
    }
    if (isLocalMcpRequestTimeout(error)) throw error;
    if (entry.remote) throw new Error(safeRemoteError(error));
    throw error;
  }
};

export const mergeMcpServers: typeof ServerActions.mergeMcpServers = async (
  incoming,
  _accessCode,
) =>
  mutate(
    async () => {
      const additions = parseMcpConfig(incoming);
      const config = await readConfig();
      const merged = parseMcpConfig({
        mcpServers: { ...config.mcpServers, ...additions.mcpServers },
      });
      await mutateOAuth(async () => {
        await writeConfig(merged);
        for (const id of Object.keys(additions.mcpServers))
          await invalidateOAuth(id);
      });
      // Queue connection work after this mutation without holding up the import.
      // Keeping it on the same queue serializes it with later edits and stops.
      void mutate(async () => {
        await Promise.all(
          Object.entries(additions.mcpServers).map(async ([id, server]) => {
            if (server.status === "paused") await stop(id).catch(() => {});
            else await start(id, server).catch(() => {});
          }),
        );
      }).catch(() => {});
      return merged;
    },
    Object.keys(incoming?.mcpServers ?? {}),
  );

export const beginMcpOAuth: typeof ServerActions.beginMcpOAuth = async (
  id,
  _origin,
  _accessCode,
) => {
  reconnects.cancel(id);
  const epoch = await mutateOAuth(async () => {
    await invalidateOAuth(id);
    return oauthEpochs.get(id) ?? 0;
  });
  const checkCurrent = () => {
    if ((oauthEpochs.get(id) ?? 0) !== epoch)
      throw new Error("OAuth login cancelled");
  };
  let listener: { id: string; redirectUri: string } | undefined;
  try {
    const config = await readConfig();
    checkCurrent();
    const server = config.mcpServers[id];
    const entry = clients.get(id);
    if (
      !server ||
      !isRemoteServer(server) ||
      hasManualAuthorization(server.headers) ||
      entry?.status !== "login-required"
    )
      throw new Error("OAuth login is unavailable");
    const url = httpUrl(server.url).href;
    const resourceMetadataUrl = entry.oauthMetadataUrl
      ? httpUrl(entry.oauthMetadataUrl)
      : undefined;
    const info = await discoverOAuthServerInfo(url, {
      resourceMetadataUrl,
      fetchFn: nativeMcpFetch,
    });
    checkCurrent();
    const metadata = info.authorizationServerMetadata;
    if (!metadata?.authorization_endpoint || !metadata.token_endpoint)
      throw new Error("OAuth metadata unavailable");
    httpUrl(metadata.authorization_endpoint);
    httpUrl(metadata.token_endpoint);
    if (!metadata.registration_endpoint)
      throw new OAuthPreRegisteredClientRequired();
    httpUrl(metadata.registration_endpoint);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const nonce = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    listener = await invoke("mcp_oauth_listen", { nonce });
    checkCurrent();
    pendingOAuth.set(id, listener!.id);
    const previous = await invoke<OAuthCredentials | null>("mcp_oauth_read", {
      id,
      url,
    });
    checkCurrent();
    const credentials: OAuthCredentials =
      previous?.redirectUri === listener!.redirectUri
        ? { ...previous, tokens: undefined }
        : { serverUrl: url, redirectUri: listener!.redirectUri };
    const provider = new McpOAuthProvider(
      credentials,
      (next) =>
        mutateOAuth(async () => {
          if ((oauthEpochs.get(id) ?? 0) !== epoch)
            throw new Error("MCP server changed");
          await invoke("mcp_oauth_write", { id, url, credentials: next });
        }),
      true,
      nonce,
    );
    const result = await auth(provider, {
      serverUrl: url,
      resourceMetadataUrl,
      fetchFn: nativeMcpFetch,
    });
    checkCurrent();
    const target = provider.takeAuthorizationUrl();
    if (result !== "REDIRECT" || !target)
      throw new Error("OAuth login could not start");
    await invoke("mcp_oauth_open", {
      authorizationUrl: target.href,
      callbackUri: listener!.redirectUri,
    });
    checkCurrent();
    const code = await invoke<string>("mcp_oauth_wait", { id: listener!.id });
    checkCurrent();
    const current = (await readConfig()).mcpServers[id];
    checkCurrent();
    if (
      !current ||
      !isRemoteServer(current) ||
      httpUrl(current.url).href !== url ||
      current.status === "paused" ||
      hasManualAuthorization(current.headers)
    )
      throw new Error("MCP server changed");
    if (
      (await auth(provider, {
        serverUrl: url,
        authorizationCode: code,
        resourceMetadataUrl,
        fetchFn: nativeMcpFetch,
      })) !== "AUTHORIZED"
    )
      throw new Error("OAuth login failed");
    checkCurrent();
    await mutate(async () => {
      checkCurrent();
      const latest = (await readConfig()).mcpServers[id];
      checkCurrent();
      if (
        !latest ||
        !isRemoteServer(latest) ||
        httpUrl(latest.url).href !== url ||
        latest.status === "paused"
      )
        throw new Error("MCP server changed");
      await start(id, latest);
      checkCurrent();
    });
    return { url: "" };
  } catch (error) {
    checkCurrent();
    if (error instanceof OAuthPreRegisteredClientRequired)
      throw new Error("OAuth server requires a pre-registered client");
    if (error instanceof Error && error.message === "OAuth login timed out")
      throw new Error("OAuth login timed out");
    throw new Error("OAuth login could not start");
  } finally {
    if (listener) {
      if (pendingOAuth.get(id) === listener.id) pendingOAuth.delete(id);
      await invoke("mcp_oauth_cancel", { id: listener.id }).catch(() => {});
    }
  }
};

export const cancelMcpOAuth: typeof ServerActions.cancelMcpOAuth = async (
  id,
  _accessCode,
) => {
  reconnects.cancel(id);
  return mutateOAuth(() => invalidateOAuth(id));
};

export const logoutMcpOAuth: typeof ServerActions.logoutMcpOAuth = async (
  id,
  _accessCode,
) =>
  mutate(async () => {
    const config = await readConfig();
    const server = config.mcpServers[id];
    if (!server || !isRemoteServer(server))
      throw new Error("OAuth login is unavailable");
    await mutateOAuth(async () => {
      await invalidateOAuth(id);
      await invoke("mcp_oauth_remove", { id });
    });
    await stop(id);
    if (server.status !== "paused") await start(id, server).catch(() => {});
  }, id);
