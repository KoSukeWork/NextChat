import { useId, useState, type ReactNode } from "react";
import DownIcon from "../icons/down.svg";
import styles from "./collapsible-block.module.scss";

export function CollapsibleBlock({
  title,
  status,
  active = false,
  ariaLabel,
  children,
}: {
  title: ReactNode;
  status?: ReactNode;
  active?: boolean;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return (
    <section className={styles.block} aria-label={ariaLabel}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={styles.chevron} data-expanded={expanded}>
          <DownIcon />
        </span>
        <span className={styles.title}>{title}</span>
        {status && <span className={styles.status}>{status}</span>}
        {active && (
          <span className={styles.pulse} aria-hidden="true">
            ●
          </span>
        )}
      </button>
      {expanded && (
        <div id={contentId} className={styles.content}>
          {children}
        </div>
      )}
    </section>
  );
}
