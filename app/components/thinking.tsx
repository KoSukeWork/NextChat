import type { ReactNode } from "react";
import Locale from "../locales";
import { CollapsibleBlock } from "./collapsible-block";

export function ThinkingBlock(props: {
  thinking: boolean;
  children: ReactNode;
}) {
  return (
    <CollapsibleBlock
      ariaLabel={Locale.Chat.Thinking.Title}
      title={
        props.thinking ? Locale.Chat.Thinking.Active : Locale.Chat.Thinking.Done
      }
      active={props.thinking}
    >
      {props.children}
    </CollapsibleBlock>
  );
}
