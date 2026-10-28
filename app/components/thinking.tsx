import { useId, useState, type ReactNode } from "react";
import Locale from "../locales";
import DownIcon from "../icons/down.svg";
import styles from "./thinking.module.scss";

export function ThinkingBlock(props: {
  thinking: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return (
    <section className={styles.block} aria-label={Locale.Chat.Thinking.Title}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded(!expanded)}
      >
        <span className={styles.chevron} data-expanded={expanded}>
          <DownIcon />
        </span>
        <span>
          {props.thinking
            ? Locale.Chat.Thinking.Active
            : Locale.Chat.Thinking.Done}
        </span>
        {props.thinking && (
          <span className={styles.pulse} aria-hidden="true">
            ●
          </span>
        )}
      </button>
      {expanded && (
        <div id={contentId} className={styles.content}>
          {props.children}
        </div>
      )}
    </section>
  );
}
