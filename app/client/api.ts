import { thinkingToMarkdown } from "../utils/thinking";
import { getClientConfig } from "../config/client";
import type { ChatMessage, ChatMessageTool, ModelType } from "../store";

export const ROLES = ["system", "user", "assistant"] as const;
export type MessageRole = (typeof ROLES)[number];
export type ChatModel = ModelType;

export interface MultimodalContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface RequestMessage {
  role: MessageRole;
  content: string | MultimodalContent[];
}

export interface LLMConfig {
  model: string;
  endpointId?: string;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  presence_penalty?: number;
  frequency_penalty?: number;
}

export interface ChatOptions {
  messages: RequestMessage[];
  config: LLMConfig;
  pluginIds?: string[];
  onUpdate?: (message: string, chunk: string, thinkingActive?: boolean) => void;
  onFinish: (message: string, response: Response) => void;
  onError?: (err: Error) => void;
  onController?: (controller: AbortController) => void;
  onBeforeTool?: (tool: ChatMessageTool) => void;
  onAfterTool?: (tool: ChatMessageTool) => void;
}

export function validString(value: string): boolean {
  return value?.length > 0;
}

export function getBearerToken(apiKey: string, noBearer = false): string {
  return validString(apiKey)
    ? `${noBearer ? "" : "Bearer "}${apiKey.trim()}`
    : "";
}

export class ClientApi {
  async share(messages: ChatMessage[], avatarUrl: string | null = null) {
    const items = messages.map((message) => ({
      from: message.role === "user" ? "human" : "gpt",
      value:
        message.role !== "assistant"
          ? message.content
          : typeof message.content === "string"
          ? thinkingToMarkdown(message.content)
          : message.content.map((part) =>
              part.type === "text"
                ? { ...part, text: thinkingToMarkdown(part.text ?? "") }
                : part,
            ),
    }));
    const url = getClientConfig()?.isApp
      ? "https://sharegpt.com/api/conversations"
      : "/sharegpt";
    const response = await fetch(url, {
      body: JSON.stringify({ avatarUrl, items }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const value = await response.json();
    if (value.id) return `https://shareg.pt/${value.id}`;
  }
}
