// SDK v1: intentionally independent of React, stores, and native APIs.
export interface PluginRequest {
  url: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface PluginContext {
  operation: "chat" | "models";
  protocol: string;
  endpoint: { id: string; baseUrl: string; apiKey: string };
  config: Record<string, string>;
  sessionId: string;
  requestId: string;
  /** Host-owned driver registry; a plugin cannot register its own driver. */
  hostDrivers?: string[];
}

export interface PluginChat {
  messages: { role: string; content: unknown }[];
  model: string;
  enableTools: boolean;
  reasoningEffort?: string;
}

export type DriverEvent =
  | { type: "text" | "thinking"; text: string }
  | { type: "done"; sessionId?: string }
  | { type: "error"; message: string }
  | {
      type: "host_tool_call";
      runId: string;
      id: string;
      name: string;
      input: unknown;
    }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; content: string; isError?: boolean };

/** Optional exports of a plugin's self-contained ESM source. */
export interface RequestPluginSDK {
  prepareRequest?(
    request: PluginRequest,
    context: PluginContext,
  ): PluginRequest | Promise<PluginRequest>;
  prepareChat?(
    chat: PluginChat,
    context: PluginContext,
  ):
    | PluginRequest
    | { hostDriver: string }
    | null
    | Promise<PluginRequest | { hostDriver: string } | null>;
}
