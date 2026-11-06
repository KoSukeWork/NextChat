import type { ChatOptions } from "./api";
import { useAppConfig } from "../store/config";
import { usePluginStore } from "../store/plugin";
import { useAccessStore } from "../store/access";
import { executeMcpAction, getAllTools, isMcpEnabled } from "../mcp/actions";
import { createToolRegistry, formatMcpResult } from "../mcp/tool-runtime";
import type { McpToolGroup, PluginToolGroup } from "../mcp/tool-runtime";
import { MCP_SYSTEM_TEMPLATE, MCP_TOOLS_TEMPLATE } from "../constant";
import { preProcessImageContent } from "../utils/chat";
import { getTimeoutMSByModel } from "../utils";
import { runEndpointChat } from "./endpoint-stream";
import type { EndpointTool } from "./endpoint-protocol";
import { fetchEndpointModels } from "./endpoint-models";
import type { Endpoint } from "../utils/endpoints";

export class EndpointClient {
  constructor(private endpoint: Endpoint) {}

  async chat(options: ChatOptions) {
    try {
      const modelConfig = {
        ...useAppConfig.getState().modelConfig,
        ...options.config,
      };
      const pluginIds = options.enableTools ? options.pluginIds ?? [] : [];
      const messages = await Promise.all(
        options.messages.map(async (message) => ({
          ...message,
          content: await preProcessImageContent(message.content),
        })),
      );
      const accessCode = useAccessStore.getState().accessCode;
      const mcp =
        options.enableTools && (await isMcpEnabled())
          ? ((await getAllTools(accessCode)) as unknown as McpToolGroup[])
          : [];
      const pluginStore = usePluginStore.getState();
      const plugins: PluginToolGroup[] = pluginIds.flatMap((id) => {
        const plugin = pluginStore.get(id);
        if (!plugin) return [];
        const [tools, funcs] = pluginStore.getAsTools([id]) as [
          EndpointTool[],
          Record<string, Function>,
        ];
        return [{ id, name: plugin.title, tools, funcs }];
      });
      const registry = createToolRegistry(
        mcp,
        plugins,
        (clientId, name, args) =>
          executeMcpAction(
            clientId,
            { method: "tools/call", params: { name, arguments: args } },
            accessCode,
          ),
      );
      const descriptions = mcp
        .map((group) =>
          MCP_TOOLS_TEMPLATE.replace("{{ clientId }}", group.clientId).replace(
            "{{ tools }}",
            (group.tools?.tools ?? [])
              .map((tool) => JSON.stringify(tool, null, 2))
              .join("\n"),
          ),
        )
        .join("");
      const textPrompt = descriptions
        ? MCP_SYSTEM_TEMPLATE.replace("{{ MCP_TOOLS }}", descriptions)
        : "";
      return await runEndpointChat(
        this.endpoint,
        {
          model: options.config.model,
          messages,
          stream: !!options.config.stream,
          maxTokens: modelConfig.max_tokens,
          timeoutMs: getTimeoutMSByModel(options.config.model),
          temperature: modelConfig.temperature,
          topP: modelConfig.top_p,
          presencePenalty: modelConfig.presence_penalty,
          frequencyPenalty: modelConfig.frequency_penalty,
          enableTemperature:
            !!options.enableTools && options.config.enableTemperature === true,
          enableTopP:
            !!options.enableTools && options.config.enableTopP === true,
          enableMaxTokens:
            !!options.enableTools && options.config.enableMaxTokens === true,
          enablePresencePenalty:
            !!options.enableTools &&
            options.config.enablePresencePenalty === true,
          enableFrequencyPenalty:
            !!options.enableTools &&
            options.config.enableFrequencyPenalty === true,
          enableReasoningSummary:
            !!options.enableTools &&
            options.config.enableReasoningSummary !== false,
          reasoningEffort: options.enableTools
            ? options.config.reasoningEffort
            : undefined,
          tools: options.enableTools ? registry.tools : [],
          toolDisplay: registry.display,
          textOnly: options.enableTools && this.endpoint.toolCalling === "text",
          textToolPrompt: textPrompt,
          hasPlugins: plugins.some((plugin) => plugin.tools.length > 0),
          executeTextTool: options.enableTools
            ? async (clientId, request) =>
                formatMcpResult(
                  await executeMcpAction(clientId, request as any, accessCode),
                )
            : undefined,
        },
        options,
        registry.funcs,
      );
    } catch (error) {
      options.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
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
