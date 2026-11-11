// SDK v1: intentionally independent of React, stores, and native APIs.
export interface PluginRequest {
  url: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  /** SDK 2: use the configured independent relay; never fall back to fetch. */
  transport?: { profile: string };
}

export interface PluginContext {
  operation: "chat" | "models";
  protocol: string;
  endpoint: { id: string; baseUrl: string; apiKey: string };
  config: Record<string, string>;
  sessionId: string;
  requestId: string;
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
  ): PluginRequest | null | Promise<PluginRequest | null>;
}
