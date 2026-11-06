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
let mutations: Promise<unknown> = Promise.resolve();
let oauthMutations: Promise<unknown> = Promise.resolve();

// Keep read/modify/write and start/stop operations ordered, including concurrent UI clicks.
function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutations.then(operation);
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

async function start(id: string, server: ServerConfig) {
  await stop(id);
  const remote = isRemoteServer(server);
  const entry: Entry = {
    client: null,
    remote,
    tools: null,
    status: "initializing",
    errorMsg: null,
  };
  clients.set(id, entry);
  let client: Client | null = null;
  try {
    if (remote) {
      const url = httpUrl(server.url).href;
      const epoch = oauthEpochs.get(id) ?? 0;
      const credentials = !hasManualAuthorization(server.headers)
        ? await invoke<OAuthCredentials | null>("mcp_oauth_read", { id, url })
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
      client = await createRemoteClient(id, server, nativeMcpFetch, provider);
    } else {
      client = new Client(
        { name: `nextchat-mcp-client-${id}`, version: "1.0.0" },
        { capabilities: {} },
      );
      await client.connect(new TauriStdioTransport(id));
    }
    entry.client = client;
    client.onerror = (error) => {
      if (error instanceof OAuthLoginNeeded) {
        entry.status = "login-required";
        entry.oauthMetadataUrl = error.resourceMetadataUrl;
        entry.tools = null;
        entry.errorMsg = "OAuth login required";
      } else {
        entry.errorMsg = remote ? safeRemoteError(error) : error.message;
      }
    };
    client.onclose = () => {
      if (clients.get(id) === entry) {
        if (entry.status !== "login-required") entry.status = "error";
        entry.tools = null;
        entry.errorMsg ??= "MCP server disconnected";
      }
    };
    const tools = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
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
    await client?.close().catch(() => {});
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
) =>
  [...clients.entries()]
    .filter(([, entry]) => entry.status === "active" && entry.tools !== null)
    .map(([clientId, entry]) => ({ clientId, tools: entry.tools! }));

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
  });

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
  });

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
  });

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
  });

export const restartAllClients: typeof ServerActions.restartAllClients = async (
  _accessCode,
) =>
  mutate(async () => {
    for (const id of [...clients.keys()]) await stop(id);
    const config = await readConfig();
    await startConfigured(config);
    return config;
  });

export const executeMcpAction: typeof ServerActions.executeMcpAction = async (
  id,
  request,
  _accessCode,
) => {
  const entry = clients.get(id);
  if (!entry || entry.status !== "active")
    throw new Error(`MCP server ${id} is not connected`);
  try {
    const call = entry.client!.request as (
      requestMessage: typeof request,
      schema: unknown,
    ) => Promise<unknown>;
    return await call.call(entry.client, request, z.any());
  } catch (error) {
    if (entry.remote) throw new Error(safeRemoteError(error));
    throw error;
  }
};

export const mergeMcpServers: typeof ServerActions.mergeMcpServers = async (
  incoming,
  _accessCode,
) =>
  mutate(async () => {
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
  });

export const beginMcpOAuth: typeof ServerActions.beginMcpOAuth = async (
  id,
  _origin,
  _accessCode,
) => {
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
) => mutateOAuth(() => invalidateOAuth(id));

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
  });
