import type { ChatMessageTool } from "../store/chat";
import Locale from "../locales";
import { CollapsibleBlock } from "./collapsible-block";
import styles from "./tool-card.module.scss";

function pretty(value?: string) {
  if (!value) return "";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function ToolCard({
  tool,
  historical = false,
  active = true,
}: {
  tool: ChatMessageTool;
  historical?: boolean;
  active?: boolean;
}) {
  const labels = Locale.Chat.ToolCard;
  const status =
    tool.isError === true
      ? labels.Failed
      : tool.isError === false
      ? labels.Succeeded
      : active
      ? labels.Running
      : labels.Stopped;
  return (
    <CollapsibleBlock
      title={
        <>
          {tool.display?.server ? `${tool.display.server} / ` : ""}
          {tool.display?.name ?? tool.function?.name ?? labels.Tool}
        </>
      }
      status={historical ? undefined : status}
    >
      <div className={styles.body}>
        {tool.display?.server && (
          <div>
            <strong>
              {labels.Server}
              {labels.Separator}
            </strong>
            {tool.display.server}
          </div>
        )}
        {tool.function?.arguments && (
          <>
            <strong>{labels.Arguments}</strong>
            <pre>{pretty(tool.function.arguments)}</pre>
          </>
        )}
        {(tool.content || tool.errorMsg) && (
          <>
            <strong>{tool.isError ? labels.Error : labels.Result}</strong>
            <pre>{pretty(tool.content ?? tool.errorMsg)}</pre>
          </>
        )}
      </div>
    </CollapsibleBlock>
  );
}
