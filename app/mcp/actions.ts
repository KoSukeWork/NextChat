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
export async function getAllTools(accessCode: string) {
  await assertMcpAuthorized(accessCode);
  const result = [];
  for (const [clientId, status] of clientsMap.entries()) {
    if (!status.client || status.errorMsg || !status.tools) continue;
    result.push({
      clientId,
      tools: status.tools,
    });
  }
  return result;
}

// 初始化单个客户端
async function initializeSingleClient(
  clientId: string,
  serverConfig: ServerConfig,
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
    if (previous) await removeClient(previous);
    // A pause, removal or newer start can supersede this background operation.
    if (clientsMap.get(clientId) !== pending) return;
    const provider =
      isRemoteServer(serverConfig) &&
      !hasManualAuthorization(serverConfig.headers)
        ? await backgroundServerOAuth(
            oauth,
            clientId,
            httpUrl(serverConfig.url).href,
            () =>
              isCurrentOAuthServer(clientId, httpUrl(serverConfig.url).href),
          )
        : undefined;
    if (clientsMap.get(clientId) !== pending) return;
    oauthAuthenticated = !!provider;
    client = await createClient(clientId, serverConfig, provider);
    if (clientsMap.get(clientId) !== pending) {
      await removeClient(client);
      return;
    }
    const tools = await listTools(client);
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
      if (
        error instanceof OAuthLoginNeeded &&
        clientsMap.get(clientId)?.client === connectedClient
      ) {
        clientsMap.set(clientId, {
          client: null,
          tools: null,
          errorMsg: "OAuth login required",
          oauthStatus: "login-required",
          oauthAuthenticated: true,
          oauthMetadataUrl: error.resourceMetadataUrl,
        });
        void removeClient(connectedClient).catch(() => {});
      }
    };
    logger.success(`Client [${clientId}] initialized successfully`);
  } catch (error) {
    if (client) await removeClient(client).catch(() => {});
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
  }
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

    // 只有新服务器或状态为 active 的服务器才初始化
    if (config.status !== "paused") {
      await initializeSingleClient(clientId, config);
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
  try {
    const currentConfig = await getMcpConfigFromFile(accessCode);
    const { [clientId]: _, ...rest } = currentConfig.mcpServers;
    const newConfig = {
      ...currentConfig,
      mcpServers: rest,
    };
    await updateMcpConfig(newConfig);

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
  try {
    const client = clientsMap.get(clientId);
    if (!client?.client) {
      throw new Error(`Client ${clientId} not found`);
    }
    logger.info(`Executing request for [${clientId}]`);
    return await executeRequest(client.client, request);
  } catch (error) {
    const config = await getMcpConfigFromFile(accessCode);
    const server = config.mcpServers[clientId];
    const message =
      server && isRemoteServer(server)
        ? safeRemoteError(error)
        : error instanceof Error
        ? error.message
        : String(error);
    logger.error(`Failed to execute request for [${clientId}]: ${message}`);
    throw new Error(message);
  }
}

// 获取 MCP 配置文件
export async function getMcpConfigFromFile(
  accessCode: string,
): Promise<McpConfigData> {
  await assertMcpAuthorized(accessCode);
  try {
    const configStr = await fs.readFile(CONFIG_PATH, "utf-8");
    return parseMcpConfig(JSON.parse(configStr));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      return DEFAULT_MCP_CONFIG;
    throw new Error("Invalid or unreadable MCP configuration");
  }
}

/** Merge an imported or pasted config only after authorization and validation. */
export async function mergeMcpServers(
  incoming: McpConfigData,
  accessCode: string,
) {
  await assertMcpAuthorized(accessCode);
  const additions = parseMcpConfig(incoming);
  const current = await getMcpConfigFromFile(accessCode);
  const merged = parseMcpConfig({
    mcpServers: { ...current.mcpServers, ...additions.mcpServers },
  });
  await updateMcpConfig(merged);
  for (const [id, server] of Object.entries(additions.mcpServers)) {
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
          if (current) await initializeSingleClient(clientId, current);
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
  invalidateServerOAuth(oauth, clientId);
}

export async function logoutMcpOAuth(clientId: string, accessCode: string) {
  await assertMcpAuthorized(accessCode);
  const config = await getMcpConfigFromFile(accessCode);
  const server = config.mcpServers[clientId];
  if (!server || !isRemoteServer(server))
    throw new Error("OAuth login is unavailable");
  invalidateServerOAuth(oauth, clientId);
  await oauth.store.remove(clientId);
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
