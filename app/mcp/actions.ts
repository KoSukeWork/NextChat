"use server";
import {
  createClient,
  executeRequest,
  listTools,
  removeClient,
} from "./client";
import { MCPClientLogger } from "./logger";
import {
  DEFAULT_MCP_CONFIG,
  McpClientData,
  McpConfigData,
  McpRequestMessage,
  ServerConfig,
  ServerStatusResponse,
  isRemoteServer,
} from "./types";
import { parseMcpConfig } from "./config";
import { safeRemoteError } from "./remote";
import {
  hasManualAuthorization,
  httpUrl,
  OAuthLoginNeeded,
  OAuthPreRegisteredClientRequired,
} from "./oauth";
import {
  backgroundServerOAuth,
  beginServerOAuth,
  invalidateServerOAuth,
  oauthRuntime,
} from "./oauth-server";
import { MCP_CONFIG_PATH as CONFIG_PATH, MCP_OAUTH_PATH } from "./server-paths";
import { headers as requestHeaders } from "next/headers";
import fs from "fs/promises";
import path from "path";
import md5 from "spark-md5";
import {
  isLocalMcpRequestTimeout,
  isMcpConnectionFailure,
  McpCallTracker,
  McpReconnectTimeout,
  McpRequestNotSent,
  ReconnectCoordinator,
  untilAborted,
} from "./reconnect";

const logger = new MCPClientLogger("MCP Actions");
const oauth = oauthRuntime(MCP_OAUTH_PATH);

const clientMapsKey = Symbol.for("nextchat.mcp.server.clients");
const sharedClients = globalThis as typeof globalThis & {
  [clientMapsKey]?: Map<string, Map<string, McpClientData>>;
};
const clientMaps: Map<string, Map<string, McpClientData>> = (sharedClients[
  clientMapsKey
] ??= new Map<string, Map<string, McpClientData>>());
const clientsMap: Map<string, McpClientData> =
  clientMaps.get(CONFIG_PATH) ?? new Map();
clientMaps.set(CONFIG_PATH, clientsMap);
const callsKey = Symbol.for("nextchat.mcp.server.calls");
const callsShared = globalThis as typeof globalThis & {
  [callsKey]?: Map<
    string,
    {
      tracker: McpCallTracker;
      safeOrigins: WeakSet<McpClientData>;
      closedOrigins: WeakMap<McpClientData, McpClientData>;
    }
  >;
};
const callsMaps = (callsShared[callsKey] ??= new Map());
const callsState = callsMaps.get(CONFIG_PATH) ?? {
  tracker: new McpCallTracker(),
  safeOrigins: new WeakSet<McpClientData>(),
  closedOrigins: new WeakMap<McpClientData, McpClientData>(),
};
callsState.closedOrigins ??= new WeakMap();
callsMaps.set(CONFIG_PATH, callsState);

async function isCurrentOAuthServer(clientId: string, serverUrl: string) {
  try {
    const current = parseMcpConfig(
      JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")),
    ).mcpServers[clientId];
    return (
      !!current &&
      isRemoteServer(current) &&
      httpUrl(current.url).href === serverUrl &&
      current.status !== "paused" &&
      !hasManualAuthorization(current.headers)
    );
  } catch {
    return false;
  }
}

// Every exported function in this "use server" module is directly callable over
// HTTP. MCP therefore requires both an explicit feature flag and a configured,
// valid deployment access code before exposing config or starting child processes.
async function assertMcpAuthorized(accessCode: string) {
  if (!(await isMcpEnabled())) {
    throw new Error("MCP is not enabled");
  }

  const allowedCodes = new Set(
    (process.env.CODE ?? "")
      .split(",")
      .map((code) => code.trim())
      .filter(Boolean)
      .map((code) => md5.hash(code)),
  );

  if (allowedCodes.size === 0) {
    throw new Error("MCP requires CODE to be configured");
  }

  if (!accessCode || !allowedCodes.has(md5.hash(accessCode.trim()))) {
    throw new Error("Unauthorized MCP request");
  }
}

// 获取客户端状态
export async function getClientsStatus(
  accessCode: string,
): Promise<Record<string, ServerStatusResponse>> {
  await assertMcpAuthorized(accessCode);
  const config = await getMcpConfigFromFile(accessCode);
  const result: Record<string, ServerStatusResponse> = {};

  for (const clientId of Object.keys(config.mcpServers)) {
    const status = clientsMap.get(clientId);
    const serverConfig = config.mcpServers[clientId];

    if (!serverConfig) {
      result[clientId] = { status: "undefined", errorMsg: null };
      continue;
    }

    if (serverConfig.status === "paused") {
      const saved =
        isRemoteServer(serverConfig) &&
        !hasManualAuthorization(serverConfig.headers)
          ? await oauth.store.read(clientId, httpUrl(serverConfig.url).href)
          : undefined;
      result[clientId] = {
        status: "paused",
        errorMsg: null,
        ...(saved?.tokens && saved.client ? { oauthAuthenticated: true } : {}),
      };
      continue;
    }

    if (!status) {
      result[clientId] = { status: "undefined", errorMsg: null };
      continue;
    }

    if (status.oauthStatus) {
      result[clientId] = {
        status: status.oauthStatus,
        errorMsg: null,
        ...(status.oauthAuthenticated ? { oauthAuthenticated: true } : {}),
      };
      continue;
    }

    if (
      status.client === null &&
      status.tools === null &&
      status.errorMsg === null
    ) {
      result[clientId] = { status: "initializing", errorMsg: null };
      continue;
    }

    if (status.errorMsg) {
      result[clientId] = { status: "error", errorMsg: status.errorMsg };
      continue;
    }

    if (status.client) {
      result[clientId] = {
        status: "active",
        errorMsg: null,
        ...(status.oauthAuthenticated ? { oauthAuthenticated: true } : {}),
      };
      continue;
    }

    result[clientId] = { status: "error", errorMsg: "Client not found" };
  }

  return result;
}

// 获取客户端工具
export async function getClientTools(clientId: string, accessCode: string) {
  await assertMcpAuthorized(accessCode);
  return clientsMap.get(clientId)?.tools ?? null;
}

// 获取可用客户端数量
export async function getAvailableClientsCount(accessCode: string) {
  await assertMcpAuthorized(accessCode);
  let count = 0;
  clientsMap.forEach((map) => map.client && !map.errorMsg && count++);
  return count;
}

// 获取所有客户端工具
export async function getAllTools(
  accessCode: string,
  excludedIds: string[] = [],
) {
  await assertMcpAuthorized(accessCode);
  const excluded = new Set(excludedIds);
  await retryFailed(undefined, "message", excluded);
  const result = [];
  for (const [clientId, status] of clientsMap.entries()) {
    if (
      excluded.has(clientId) ||
      !status.client ||
      status.errorMsg ||
      !status.tools
    )
      continue;
    result.push({
      clientId,
      tools: status.tools,
    });
  }
  return result;
}

/** Called once when the MCP page opens; status polling itself never reconnects. */
export async function reconnectMcpErrors(accessCode: string) {
  await assertMcpAuthorized(accessCode);
  await retryFailed();
}

// 初始化单个客户端
async function initializeSingleClient(
  clientId: string,
  serverConfig: ServerConfig,
  signal?: AbortSignal,
) {
  // 如果服务器状态是暂停，则不初始化
  if (serverConfig.status === "paused") {
    logger.info(`Skipping initialization for paused client [${clientId}]`);
    return;
  }

  logger.info(`Initializing client [${clientId}]...`);

  const previous = clientsMap.get(clientId)?.client;
  const pending: McpClientData = {
    client: null,
    tools: null,
    errorMsg: null,
  };
  clientsMap.set(clientId, pending);
  let client: Awaited<ReturnType<typeof createClient>> | undefined;
  let oauthAuthenticated = false;
  try {
    if (signal?.aborted) throw new McpReconnectTimeout();
    if (previous) await untilAborted(removeClient(previous), signal);
    // A pause, removal or newer start can supersede this background operation.
    if (clientsMap.get(clientId) !== pending) return;
    const provider =
      isRemoteServer(serverConfig) &&
      !hasManualAuthorization(serverConfig.headers)
        ? await untilAborted(
            backgroundServerOAuth(
              oauth,
              clientId,
              httpUrl(serverConfig.url).href,
              () =>
                isCurrentOAuthServer(clientId, httpUrl(serverConfig.url).href),
            ),
            signal,
          )
        : undefined;
    if (clientsMap.get(clientId) !== pending) return;
    oauthAuthenticated = !!provider;
    if (signal?.aborted) throw new McpReconnectTimeout();
    const connecting = createClient(clientId, serverConfig, provider, signal);
    client = await untilAborted(connecting, signal, () => {
      void connecting.then((late) => removeClient(late)).catch(() => {});
    });
    if (clientsMap.get(clientId) !== pending) {
      await removeClient(client);
      return;
    }
    const tools = await untilAborted(listTools(client, signal), signal, () => {
      if (client) void removeClient(client).catch(() => {});
    });
    if (signal?.aborted) throw new McpReconnectTimeout();
    if (clientsMap.get(clientId) !== pending) {
      await removeClient(client);
      return;
    }
    clientsMap.set(clientId, {
      client,
      tools,
      errorMsg: null,
      oauthAuthenticated,
    });
    const connectedClient = client;
    connectedClient.onerror = (error) => {
      const current = clientsMap.get(clientId);
      if (
        (error instanceof OAuthLoginNeeded ||
          error instanceof OAuthPreRegisteredClientRequired) &&
        current?.client === connectedClient
      ) {
        clientsMap.set(clientId, {
          client: null,
          tools: null,
          errorMsg:
            error instanceof OAuthLoginNeeded
              ? "OAuth login required"
              : "OAuth server requires a pre-registered client",
          oauthStatus:
            error instanceof OAuthLoginNeeded
              ? "login-required"
              : "oauth-unsupported",
          oauthAuthenticated,
          oauthMetadataUrl:
            error instanceof OAuthLoginNeeded
              ? error.resourceMetadataUrl
              : undefined,
        });
        void removeClient(connectedClient).catch(() => {});
      } else if (
        current?.client === connectedClient &&
        isMcpConnectionFailure(error, connectedClient)
      ) {
        const failed: McpClientData = {
          client: null,
          tools: null,
          errorMsg: isRemoteServer(serverConfig)
            ? safeRemoteError(error)
            : error.message,
          oauthAuthenticated,
        };
        callsState.closedOrigins.set(current, failed);
        clientsMap.set(clientId, failed);
        callsState.tracker.retire(connectedClient, () => {
          void removeClient(connectedClient).catch(() => {});
        });
      }
    };
    connectedClient.onclose = () => {
      const previous = clientsMap.get(clientId);
      if (previous?.client === connectedClient) {
        const closed: McpClientData = {
          client: null,
          tools: null,
          errorMsg: "MCP server disconnected",
          oauthAuthenticated,
        };
        callsState.closedOrigins.set(previous, closed);
        clientsMap.set(clientId, closed);
      }
    };
    reconnects.reset(clientId);
    logger.success(`Client [${clientId}] initialized successfully`);
    return true;
  } catch (error) {
    if (client) {
      if (signal?.aborted) void removeClient(client).catch(() => {});
      else await removeClient(client).catch(() => {});
    }
    if (clientsMap.get(clientId) !== pending) return;
    const message = isRemoteServer(serverConfig)
      ? safeRemoteError(error)
      : error instanceof Error
      ? error.message
      : String(error);
    const oauthStatus =
      error instanceof OAuthLoginNeeded
        ? "login-required"
        : error instanceof OAuthPreRegisteredClientRequired
        ? "oauth-unsupported"
        : undefined;
    clientsMap.set(clientId, {
      client: null,
      tools: null,
      errorMsg: message,
      oauthStatus,
      oauthAuthenticated,
      oauthMetadataUrl:
        error instanceof OAuthLoginNeeded
          ? error.resourceMetadataUrl
          : undefined,
    });
    logger.error(`Failed to initialize client [${clientId}]: ${message}`);
    return false;
  }
}

const reconnectKey = Symbol.for("nextchat.mcp.server.reconnects");
const reconnectShared = globalThis as typeof globalThis & {
  [reconnectKey]?: Map<string, ReconnectCoordinator>;
};
const reconnectMaps = (reconnectShared[reconnectKey] ??= new Map());
const reconnects =
  reconnectMaps.get(CONFIG_PATH) ??
  new ReconnectCoordinator(async (ids, signal) => {
    const config = await untilAborted(readMcpConfig(), signal);
    const id = ids[0];
    const server = config.mcpServers[id];
    const current = clientsMap.get(id);
    if (
      signal.aborted ||
      !server ||
      server.status === "paused" ||
      !current?.errorMsg ||
      current.oauthStatus
    )
      return "skipped";
    const outcome = await initializeSingleClient(id, server, signal);
    return outcome === true
      ? "success"
      : outcome === false
      ? "failure"
      : "skipped";
  });
reconnectMaps.set(CONFIG_PATH, reconnects);

function retryFailed(
  ids?: string[],
  mode: "message" | "force" = "force",
  excluded: Set<string> = new Set(),
) {
  const selected = ids ?? [
    ...new Set([
      ...[...clientsMap.entries()]
        .filter(([, entry]) => !!entry.errorMsg && !entry.oauthStatus)
        .map(([id]) => id),
      ...reconnects.pendingIds(),
    ]),
  ];
  return reconnects.reconnect(
    selected.filter((id) => !excluded.has(id)),
    mode,
  );
}

// 初始化系统
export async function initializeMcpSystem(accessCode: string) {
  await assertMcpAuthorized(accessCode);
  logger.info("MCP Actions starting...");
  try {
    // 检查是否已有活跃的客户端
    if (clientsMap.size > 0) {
      logger.info("MCP system already initialized, skipping...");
      return;
    }

    const config = await getMcpConfigFromFile(accessCode);
    // 初始化所有客户端
    for (const [clientId, serverConfig] of Object.entries(config.mcpServers)) {
      await initializeSingleClient(clientId, serverConfig);
    }
    return config;
  } catch (error) {
    logger.error(`Failed to initialize MCP system: ${error}`);
    throw error;
  }
}

// 添加服务器
export async function addMcpServer(
  clientId: string,
  config: ServerConfig,
  accessCode: string,
) {
  await assertMcpAuthorized(accessCode);
  try {
    const validated = parseMcpConfig({ mcpServers: { [clientId]: config } });
    config = validated.mcpServers[clientId];
    reconnects.cancel(clientId);
    const currentConfig = await getMcpConfigFromFile(accessCode);
    const isNewServer = !(clientId in currentConfig.mcpServers);

    // 如果是新服务器，设置默认状态为 active
    if (isNewServer && !config.status) {
      config.status = "active";
    }

    const newConfig = {
      ...currentConfig,
      mcpServers: {
        ...currentConfig.mcpServers,
        [clientId]: config,
      },
    };
    await updateMcpConfig(newConfig);
    reconnects.cancel(clientId);

    // 只有新服务器或状态为 active 的服务器才初始化
    if (config.status !== "paused") {
      await initializeSingleClient(clientId, config);
    } else {
      // An edit can retain a paused status while an older reconnect is pending.
      const previous = clientsMap.get(clientId);
      clientsMap.delete(clientId);
      if (previous?.client) await removeClient(previous.client);
    }

    return newConfig;
  } catch (error) {
    logger.error(`Failed to add server [${clientId}]: ${error}`);
    throw error;
  }
}

// 暂停服务器
export async function pauseMcpServer(clientId: string, accessCode: string) {
  await assertMcpAuthorized(accessCode);
  reconnects.cancel(clientId);
  try {
    const currentConfig = await getMcpConfigFromFile(accessCode);
    const serverConfig = currentConfig.mcpServers[clientId];
    if (!serverConfig) {
      throw new Error(`Server ${clientId} not found`);
    }

    // 先更新配置
    const newConfig: McpConfigData = {
      ...currentConfig,
      mcpServers: {
        ...currentConfig.mcpServers,
        [clientId]: {
          ...serverConfig,
          status: "paused",
        },
      },
    };
    await updateMcpConfig(newConfig);
    reconnects.cancel(clientId);

    // 然后关闭客户端
    const client = clientsMap.get(clientId);
    clientsMap.delete(clientId);
    if (client?.client) {
      await removeClient(client.client);
    }

    return newConfig;
  } catch (error) {
    logger.error(`Failed to pause server [${clientId}]: ${error}`);
    throw error;
  }
}

// 恢复服务器
export async function resumeMcpServer(
  clientId: string,
  accessCode: string,
): Promise<void> {
  await assertMcpAuthorized(accessCode);
  reconnects.cancel(clientId);
  try {
    const currentConfig = await getMcpConfigFromFile(accessCode);
    const serverConfig = currentConfig.mcpServers[clientId];
    if (!serverConfig) {
      throw new Error(`Server ${clientId} not found`);
    }

    logger.info(`Trying to initialize client [${clientId}]...`);
    try {
      const newConfig: McpConfigData = {
        ...currentConfig,
        mcpServers: {
          ...currentConfig.mcpServers,
          [clientId]: {
            ...serverConfig,
            status: "active" as const,
          },
        },
      };
      await updateMcpConfig(newConfig);
      reconnects.cancel(clientId);
      await initializeSingleClient(clientId, newConfig.mcpServers[clientId]);
      const started = clientsMap.get(clientId);
      if (!started?.client)
        throw new Error(started?.errorMsg ?? "MCP server disconnected");
      logger.success(`Client [${clientId}] initialized successfully`);
    } catch (error) {
      const currentConfig = await getMcpConfigFromFile(accessCode);
      const serverConfig = currentConfig.mcpServers[clientId];

      // 如果配置中存在该服务器，则更新其状态为 error
      if (serverConfig) {
        serverConfig.status = "error";
        await updateMcpConfig(currentConfig);
      }

      // 初始化失败
      const message =
        serverConfig && isRemoteServer(serverConfig)
          ? safeRemoteError(error)
          : error instanceof Error
          ? error.message
          : String(error);
      if (!clientsMap.has(clientId))
        clientsMap.set(clientId, {
          client: null,
          tools: null,
          errorMsg: message,
        });
      logger.error(`Failed to initialize client [${clientId}]: ${message}`);
      throw new Error(message);
    }
  } catch (error) {
    logger.error(`Failed to resume server [${clientId}]: ${error}`);
    throw error;
  }
}

// 移除服务器
export async function removeMcpServer(clientId: string, accessCode: string) {
  await assertMcpAuthorized(accessCode);
  reconnects.cancel(clientId);
  try {
    const currentConfig = await getMcpConfigFromFile(accessCode);
    const { [clientId]: _, ...rest } = currentConfig.mcpServers;
    const newConfig = {
      ...currentConfig,
      mcpServers: rest,
    };
    await updateMcpConfig(newConfig);
    reconnects.cancel(clientId);

    // 关闭并移除客户端
    const client = clientsMap.get(clientId);
    clientsMap.delete(clientId);
    if (client?.client) {
      await removeClient(client.client);
    }

    return newConfig;
  } catch (error) {
    logger.error(`Failed to remove server [${clientId}]: ${error}`);
    throw error;
  }
}

// 重启所有客户端
export async function restartAllClients(accessCode: string) {
  await assertMcpAuthorized(accessCode);
  reconnects.cancel();
  logger.info("Restarting all clients...");
  try {
    // 关闭所有客户端
    const previous = [...clientsMap.values()];
    clientsMap.clear();
    for (const client of previous) {
      if (client.client) {
        await removeClient(client.client);
      }
    }

    // 重新初始化
    const config = await getMcpConfigFromFile(accessCode);
    for (const [clientId, serverConfig] of Object.entries(config.mcpServers)) {
      await initializeSingleClient(clientId, serverConfig);
    }
    return config;
  } catch (error) {
    logger.error(`Failed to restart clients: ${error}`);
    throw error;
  }
}

// 执行 MCP 请求
export async function executeMcpAction(
  clientId: string,
  request: McpRequestMessage,
  accessCode: string,
) {
  await assertMcpAuthorized(accessCode);
  const config = await readMcpConfig();
  const server = config.mcpServers[clientId];
  const initialEpoch = oauth.epochs.get(clientId) ?? 0;
  let entry = clientsMap.get(clientId);
  if (
    server?.status !== "paused" &&
    ((entry?.errorMsg && !entry.oauthStatus) ||
      reconnects.pendingIds().includes(clientId))
  ) {
    await retryFailed([clientId]);
    entry = clientsMap.get(clientId);
  }
  if (
    !server ||
    server.status === "paused" ||
    !entry?.client ||
    entry.errorMsg ||
    entry.oauthStatus
  )
    throw new Error(`Client ${clientId} not found`);

  const remote = isRemoteServer(server);
  const messageFor = (error: unknown) =>
    remote
      ? safeRemoteError(error)
      : error instanceof Error
      ? error.message
      : String(error);
  const markError = (current: McpClientData, error: unknown) => {
    if (clientsMap.get(clientId) !== current || current.oauthStatus)
      return false;
    const client = current.client;
    const oauthStatus =
      error instanceof OAuthLoginNeeded
        ? "login-required"
        : error instanceof OAuthPreRegisteredClientRequired
        ? "oauth-unsupported"
        : undefined;
    if (!oauthStatus && !isMcpConnectionFailure(error, client ?? undefined))
      return false;
    clientsMap.set(clientId, {
      client: null,
      tools: null,
      errorMsg:
        oauthStatus === "login-required"
          ? "OAuth login required"
          : oauthStatus === "oauth-unsupported"
          ? "OAuth server requires a pre-registered client"
          : messageFor(error),
      oauthStatus,
      oauthAuthenticated: current.oauthAuthenticated,
      oauthMetadataUrl:
        error instanceof OAuthLoginNeeded
          ? error.resourceMetadataUrl
          : undefined,
    });
    if (client)
      callsState.tracker.retire(client, () => {
        void removeClient(client).catch(() => {});
      });
    return !oauthStatus;
  };
  const callOnce = async (current: McpClientData) => {
    const client = current.client!;
    return callsState.tracker.run(client, async () => {
      if (
        clientsMap.get(clientId) !== current ||
        current.errorMsg ||
        current.oauthStatus
      )
        throw new Error("MCP server changed");
      if ("transport" in client && !client.transport)
        throw new McpRequestNotSent("closed");
      return await executeRequest(client, request);
    });
  };
  try {
    return await callOnce(entry);
  } catch (error) {
    const marked = markError(entry, error);
    const closedEntry = callsState.closedOrigins.get(entry);
    const closedByTransport =
      !!closedEntry && closedEntry === clientsMap.get(clientId);
    if ((marked || closedByTransport) && error instanceof McpRequestNotSent)
      callsState.safeOrigins.add(entry);
    const retry =
      error instanceof McpRequestNotSent &&
      callsState.safeOrigins.has(entry) &&
      (marked ||
        closedByTransport ||
        reconnects.pendingIds().includes(clientId));
    if (retry) {
      await retryFailed([clientId]);
      const replacement = clientsMap.get(clientId);
      const latest = (await readMcpConfig()).mcpServers[clientId];
      if (
        replacement?.client &&
        !replacement.errorMsg &&
        !replacement.oauthStatus &&
        latest &&
        latest.status !== "paused" &&
        JSON.stringify(latest) === JSON.stringify(server) &&
        (oauth.epochs.get(clientId) ?? 0) === initialEpoch
      ) {
        try {
          return await callOnce(replacement);
        } catch (retryError) {
          markError(replacement, retryError);
          if (isLocalMcpRequestTimeout(retryError)) throw retryError;
          throw new Error(messageFor(retryError));
        }
      }
    }
    const message = messageFor(error);
    logger.error(`Failed to execute request for [${clientId}]: ${message}`);
    if (isLocalMcpRequestTimeout(error)) throw error;
    throw new Error(message);
  }
}

async function readMcpConfig(): Promise<McpConfigData> {
  try {
    const configStr = await fs.readFile(CONFIG_PATH, "utf-8");
    return parseMcpConfig(JSON.parse(configStr));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      return DEFAULT_MCP_CONFIG;
    throw new Error("Invalid or unreadable MCP configuration");
  }
}

// 获取 MCP 配置文件
export async function getMcpConfigFromFile(
  accessCode: string,
): Promise<McpConfigData> {
  await assertMcpAuthorized(accessCode);
  return readMcpConfig();
}

/** Merge an imported or pasted config only after authorization and validation. */
export async function mergeMcpServers(
  incoming: McpConfigData,
  accessCode: string,
) {
  await assertMcpAuthorized(accessCode);
  const additions = parseMcpConfig(incoming);
  for (const id of Object.keys(additions.mcpServers)) reconnects.cancel(id);
  const current = await getMcpConfigFromFile(accessCode);
  const merged = parseMcpConfig({
    mcpServers: { ...current.mcpServers, ...additions.mcpServers },
  });
  await updateMcpConfig(merged);
  for (const [id, server] of Object.entries(additions.mcpServers)) {
    reconnects.cancel(id);
    if (server.status === "paused") {
      const old = clientsMap.get(id)?.client;
      clientsMap.delete(id);
      if (old) void removeClient(old).catch(() => {});
    } else {
      // Connection can take arbitrarily long; the approved config is already saved.
      void initializeSingleClient(id, server);
    }
  }
  return merged;
}

/** Begin only from a code-authorized request for a server that challenged us. */
export async function beginMcpOAuth(
  clientId: string,
  origin: string,
  accessCode: string,
) {
  await assertMcpAuthorized(accessCode);
  reconnects.cancel(clientId);
  const config = await getMcpConfigFromFile(accessCode);
  const server = config.mcpServers[clientId];
  const entry = clientsMap.get(clientId);
  if (
    !server ||
    !isRemoteServer(server) ||
    hasManualAuthorization(server.headers) ||
    entry?.oauthStatus !== "login-required"
  )
    throw new Error("OAuth login is unavailable");
  const requestedOrigin = httpUrl(origin).origin;
  const request = requestHeaders();
  const headerOrigin = request.get("origin");
  const host = (request.get("x-forwarded-host") ?? request.get("host") ?? "")
    .split(",")[0]
    .trim();
  if (
    !headerOrigin ||
    httpUrl(headerOrigin).origin !== requestedOrigin ||
    new URL(requestedOrigin).host.toLowerCase() !== host.toLowerCase()
  )
    throw new Error("Invalid OAuth callback origin");
  const serverUrl = httpUrl(server.url).href;
  const isCurrent = () => isCurrentOAuthServer(clientId, serverUrl);
  try {
    const url = await beginServerOAuth(oauth, {
      id: clientId,
      serverUrl,
      redirectUri: `${requestedOrigin}/api/mcp/oauth/callback`,
      resourceMetadataUrl: entry.oauthMetadataUrl,
      isCurrent,
      onSuccess: async () => {
        if (await isCurrent()) {
          const current = parseMcpConfig(
            JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")),
          ).mcpServers[clientId];
          if (current) {
            reconnects.cancel(clientId);
            await initializeSingleClient(clientId, current);
          }
        }
      },
    });
    return { url };
  } catch (error) {
    if (error instanceof OAuthPreRegisteredClientRequired)
      throw new Error("OAuth server requires a pre-registered client");
    throw new Error("OAuth login could not start");
  }
}

export async function cancelMcpOAuth(clientId: string, accessCode: string) {
  await assertMcpAuthorized(accessCode);
  reconnects.cancel(clientId);
  invalidateServerOAuth(oauth, clientId);
}

export async function logoutMcpOAuth(clientId: string, accessCode: string) {
  await assertMcpAuthorized(accessCode);
  reconnects.cancel(clientId);
  const config = await getMcpConfigFromFile(accessCode);
  const server = config.mcpServers[clientId];
  if (!server || !isRemoteServer(server))
    throw new Error("OAuth login is unavailable");
  invalidateServerOAuth(oauth, clientId);
  await oauth.store.remove(clientId);
  reconnects.cancel(clientId);
  const old = clientsMap.get(clientId)?.client;
  clientsMap.delete(clientId);
  if (old) await removeClient(old).catch(() => {});
  if (server.status !== "paused")
    await initializeSingleClient(clientId, server);
}

// 更新 MCP 配置文件
async function updateMcpConfig(config: McpConfigData): Promise<void> {
  await oauth.store.withConfiguration(async (removeCredentials) => {
    let old: McpConfigData = DEFAULT_MCP_CONFIG;
    try {
      old = parseMcpConfig(JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    const removed: string[] = [];
    for (const [id, previous] of Object.entries(old.mcpServers)) {
      const next = config.mcpServers[id];
      if (!next || next.status === "paused") invalidateServerOAuth(oauth, id);
      if (
        isRemoteServer(previous) &&
        (!next ||
          !isRemoteServer(next) ||
          httpUrl(next.url).href !== httpUrl(previous.url).href ||
          (!hasManualAuthorization(previous.headers) &&
            hasManualAuthorization(next.headers)))
      ) {
        invalidateServerOAuth(oauth, id);
        removed.push(id);
      }
    }
    await removeCredentials(removed);
    // 确保目录存在
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  });
}

// 检查 MCP 是否启用
export async function isMcpEnabled() {
  return process.env.ENABLE_MCP === "true";
}
