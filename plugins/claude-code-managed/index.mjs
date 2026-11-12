import { prepareCliChat } from "../claude-code/prepare-cli-chat.mjs";

export function prepareChat(chat, context) {
  if (context.config.connection === "builtin") {
    if (!context.hostDrivers?.includes("claude-code"))
      throw new Error(
        "内置 CLI 仅在桌面版可用，请配置外部桥接服务 / Built-in CLI requires the desktop app; configure an external bridge",
      );
    return { hostDriver: "claude-code" };
  }
  if (context.config.connection !== "external")
    throw new Error("Select a CLI connection");
  const effort = context.config.nativeEffort || chat.reasoningEffort;
  return prepareCliChat(
    { ...chat, ...(effort ? { reasoningEffort: effort } : {}) },
    context,
  );
}

export function prepareRequest(_request, context) {
  if (context.operation === "models")
    throw new Error(
      "CLI -p 模式请手动添加模型 / Add models manually in CLI -p mode",
    );
  throw new Error("CLI -p requests must use the client driver");
}
