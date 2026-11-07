import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCPClientLogger } from "./logger";
import {
  ListToolsResponse,
  McpRequestMessage,
  ServerConfig,
  isRemoteServer,
} from "./types";
import { createRemoteClient } from "./remote";
import { z } from "zod";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  McpReconnectTimeout,
  McpRequestNotSent,
  untilAborted,
} from "./reconnect";

const logger = new MCPClientLogger();

export function getMcpChildEnvironment(
  configEnv?: Record<string, string>,
): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    ...(configEnv ?? {}),
  };
}

export async function createClient(
  id: string,
  config: ServerConfig,
  authProvider?: OAuthClientProvider,
  signal?: AbortSignal,
): Promise<Client> {
  logger.info(`Creating client for ${id}...`);

  if (isRemoteServer(config))
    return createRemoteClient(id, config, undefined, authProvider, signal);

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: getMcpChildEnvironment(config.env),
  });

  const client = new Client(
    {
      name: `nextchat-mcp-client-${id}`,
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    if (transport.pid === null) throw new McpRequestNotSent("closed");
    try {
      await send(message);
    } catch (error) {
      // This exact SDK error occurs before stdin.write is called.
      if (error instanceof Error && error.message === "Not connected")
        throw new McpRequestNotSent("closed");
      throw error;
    }
  };
  if (signal?.aborted) throw new McpReconnectTimeout();
  await untilAborted(client.connect(transport), signal, () => {
    void client.close().catch(() => {});
  });
  return client;
}

export async function removeClient(client: Client) {
  logger.info(`Removing client...`);
  await client.close();
}

export async function listTools(
  client: Client,
  signal?: AbortSignal,
): Promise<ListToolsResponse> {
  return untilAborted(client.listTools(undefined, { signal }), signal, () => {
    void client.close().catch(() => {});
  });
}

export async function executeRequest(
  client: Client,
  request: McpRequestMessage,
) {
  const call = client.request as (
    request: McpRequestMessage,
    schema: unknown,
  ) => Promise<unknown>;
  return call.call(client, request, z.any());
}
