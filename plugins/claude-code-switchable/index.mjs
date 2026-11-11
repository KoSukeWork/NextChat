import { prepareRequest as prepareWireRequest } from "../claude-code-wire/index.mjs";
import { prepareCliChat } from "../claude-code/prepare-cli-chat.mjs";

function mode(context) {
  const value = context.config.mode;
  if (value !== "http" && value !== "cli")
    throw new Error("Select HTTP simulation or Claude Code CLI (-p)");
  return value;
}

export function prepareChat(chat, context) {
  return mode(context) === "cli" ? prepareCliChat(chat, context) : null;
}

export function prepareRequest(request, context) {
  if (mode(context) === "http") return prepareWireRequest(request, context);
  if (context.operation === "models")
    throw new Error(
      "CLI -p 模式请手动添加模型 / Add models manually in CLI -p mode",
    );
  throw new Error(
    "CLI -p requests must use the client driver; HTTP fallback is disabled",
  );
}
