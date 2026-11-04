import type { ChatOptions } from "./api";
import { useAppConfig } from "../store/config";
import { useChatStore } from "../store/chat";
import { usePluginStore } from "../store/plugin";
import { preProcessImageContent } from "../utils/chat";
import { getTimeoutMSByModel, isVisionModel } from "../utils";
import { runEndpointChat } from "./endpoint-stream";
import type { EndpointTool } from "./endpoint-protocol";
import { fetchEndpointModels } from "./endpoint-models";
import type { Endpoint } from "../utils/endpoints";

export class EndpointClient {
  constructor(private endpoint: Endpoint) {}

  async chat(options: ChatOptions) {
    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...options.config,
    };
    const messages = await Promise.all(
      options.messages.map(async (message) => ({
        ...message,
        content: await preProcessImageContent(message.content),
      })),
    );
    const [tools, funcs] = usePluginStore
      .getState()
      .getAsTools(
        useChatStore.getState().currentSession().mask.plugin || [],
      ) as [EndpointTool[], Record<string, Function>];
    return runEndpointChat(
      this.endpoint,
      {
        model: options.config.model,
        messages,
        stream: !!options.config.stream,
        vision: isVisionModel(options.config.model),
        maxTokens: modelConfig.max_tokens,
        timeoutMs: getTimeoutMSByModel(options.config.model),
        temperature: modelConfig.temperature,
        topP: modelConfig.top_p,
        presencePenalty: modelConfig.presence_penalty,
        frequencyPenalty: modelConfig.frequency_penalty,
        tools: options.config.stream ? tools : [],
      },
      options,
      funcs,
    );
  }

  models() {
    return fetchEndpointModels(this.endpoint);
  }
}

export class ChatGPTApi extends EndpointClient {}
export class ResponsesApi extends EndpointClient {}
export class ClaudeApi extends EndpointClient {}
export class GeminiProApi extends EndpointClient {}

export function getClientApi(endpointId: string) {
  const endpoint = useAppConfig
    .getState()
    .endpoints.find((item) => item.id === endpointId);
  if (!endpoint) throw new Error("Endpoint is not configured on this device");
  switch (endpoint.protocol) {
    case "openai-chat":
      return { llm: new ChatGPTApi(endpoint) };
    case "openai-responses":
      return { llm: new ResponsesApi(endpoint) };
    case "anthropic":
      return { llm: new ClaudeApi(endpoint) };
    case "gemini":
      return { llm: new GeminiProApi(endpoint) };
  }
}
