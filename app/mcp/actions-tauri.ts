import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import type * as ServerActions from "./actions";
import type {
  McpConfigData,
  ServerStatusResponse,
  ListToolsResponse,
} from "./types";
import { invoke, isTauri } from "./tauri-api";
import { TauriStdioTransport } from "./tauri-transport";

interface Entry {
  client: Client;
  tools: ListToolsResponse | null;
  status: "initializing" | "active" | "error";
  errorMsg: string | null;
}
const clients = new Map<string, Entry>();
let mutations: Promise<unknown> = Promise.resolve();

// Keep read/modify/write and start/stop operations ordered, including concurrent UI clicks.
function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutations.then(operation);
  mutations = result.catch(() => {});
  return result;
}

const readConfig = () => invoke<McpConfigData>("mcp_read_config");
const writeConfig = (config: McpConfigData) =>
  invoke<void>("mcp_write_config", { config });

async function stop(id: string) {
  const entry = clients.get(id);
  clients.delete(id);
  if (entry) await entry.client.close();
  else await invoke("mcp_kill", { id });
}

async function start(id: string) {
  await stop(id);
  const client = new Client(
    { name: `nextchat-mcp-client-${id}`, version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new TauriStdioTransport(id);
  const entry: Entry = {
    client,
    tools: null,
    status: "initializing",
    errorMsg: null,
  };
  clients.set(id, entry);
  client.onerror = (error) => {
    entry.errorMsg = error.message;
  };
  client.onclose = () => {
    if (clients.get(id) === entry) {
      entry.status = "error";
      entry.tools = null;
      entry.errorMsg ??= "MCP server disconnected";
    }
  };
  try {
    await client.connect(transport);
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
    entry.status = "error";
    entry.errorMsg = error instanceof Error ? error.message : String(error);
    await client.close().catch(() => {});
    throw new Error(entry.errorMsg);
  }
}

async function startConfigured(config: McpConfigData) {
  await Promise.all(
    Object.entries(config.mcpServers)
      .filter(([id, server]) => server.status !== "paused" && !clients.has(id))
      .map(([id]) =>
        start(id).catch(() => {
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
    result[id] =
      server.status === "paused"
        ? { status: "paused", errorMsg: null }
        : {
            status: entry?.status ?? "undefined",
            errorMsg: entry?.errorMsg ?? null,
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
    .filter(([, entry]) => entry.status === "active")
    .map(([clientId, entry]) => ({ clientId, tools: entry.tools }));

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
    config.mcpServers[id] = { ...server, status: server.status ?? "active" };
    // Native approval happens before changing a running connection.
    await writeConfig(config);
    if (server.status === "paused") await stop(id);
    else await start(id).catch(() => {});
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
    await writeConfig(config);
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
    await writeConfig(config);
    await start(id);
  });

export const removeMcpServer: typeof ServerActions.removeMcpServer = async (
  id,
  _accessCode,
) =>
  mutate(async () => {
    const config = await readConfig();
    delete config.mcpServers[id];
    await writeConfig(config);
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
  return entry.client.request(request, z.any());
};
