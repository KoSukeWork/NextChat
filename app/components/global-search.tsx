import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { create } from "zustand";
import { Path } from "../constant";
import Locale from "../locales";
import { useChatStore } from "../store";
import { useSearchJump } from "../store/search-jump";
import {
  searchSessions,
  SearchGroup,
  SearchMatch,
  SEARCH_RESULT_LIMIT,
} from "../utils/chat-search";
import { SearchHighlight } from "./search-highlight";
import styles from "./global-search.module.scss";

const SEARCH_DELAY = 150;
const MATCHES_PER_SESSION = 5;

export const useGlobalSearch = create<{
  open: boolean;
  setOpen: (open: boolean) => void;
}>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

type Row =
  | { kind: "session"; group: SearchGroup }
  | { kind: "message"; group: SearchGroup; match: SearchMatch }
  | { kind: "more"; group: SearchGroup; hidden: number };

function SearchPanel(props: { onClose: () => void }) {
  const { onClose } = props;
  const navigate = useNavigate();
  const text = Locale.SearchChat;
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [selected, setSelected] = useState(0);
  const selectedRow = useRef<HTMLDivElement>(null);

  // Pinyin letters in an unfinished IME composition are not a search yet.
  useEffect(() => {
    if (composing) return;
    const timer = setTimeout(() => setQuery(input), SEARCH_DELAY);
    return () => clearTimeout(timer);
  }, [input, composing]);

  // Read the store once per query so a streaming reply does not search again.
  const result = useMemo(
    () =>
      searchSessions(
        useChatStore.getState().sessions.filter((session) => !session.archived),
        query,
      ),
    [query],
  );

  useEffect(() => {
    setExpanded(new Set());
    setSelected(0);
  }, [result]);

  const rows = useMemo(() => {
    const list: Row[] = [];
    for (const group of result.groups) {
      list.push({ kind: "session", group });
      const limit = expanded.has(group.session.id)
        ? group.matches.length
        : MATCHES_PER_SESSION;
      for (const match of group.matches.slice(0, limit)) {
        list.push({ kind: "message", group, match });
      }
      if (group.matches.length > limit) {
        list.push({
          kind: "more",
          group,
          hidden: group.matches.length - limit,
        });
      }
    }
    return list;
  }, [result, expanded]);

  useEffect(() => {
    selectedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  // Runs first so pages listening for Escape, such as settings, stay open.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  // Closing lets the user go on typing where they were. Read during the first
  // render, before autoFocus moves the focus to the search box.
  const [previousFocus] = useState(() => document.activeElement);
  useEffect(() => {
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [previousFocus]);

  function activate(row: Row | undefined) {
    if (!row) return;
    if (row.kind === "more") {
      setExpanded((set) => new Set(set).add(row.group.session.id));
      return;
    }
    onClose();
    if (!useChatStore.getState().selectSessionById(row.group.session.id)) {
      return;
    }
    useSearchJump
      .getState()
      .setRequest(
        row.kind === "message"
          ? { sessionId: row.group.session.id, messageId: row.match.messageId }
          : null,
      );
    navigate(Path.Chat);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (composing || e.nativeEvent.isComposing || rows.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setSelected((index) => (index + delta + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(rows[selected]);
    }
  }

  return (
    <div
      className={clsx("modal-mask", styles.mask)}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.panel} role="dialog" aria-label={text.Page.Title}>
        <input
          className={styles.input}
          type="text"
          autoFocus
          aria-label={text.Page.Title}
          placeholder={text.Page.Search}
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={onKeyDown}
        />
        <div className={styles.results}>
          {result.keywords.length === 0 && (
            <div className={styles.notice}>{text.Hint}</div>
          )}
          {result.keywords.length > 0 && rows.length === 0 && (
            <div className={styles.notice}>{text.Page.NoResult}</div>
          )}
          {rows.map((row, index) => (
            <div
              key={
                row.kind === "message"
                  ? `${row.group.session.id}:${row.match.messageId}`
                  : `${row.group.session.id}:${row.kind}`
              }
              ref={index === selected ? selectedRow : undefined}
              className={clsx(styles.row, {
                [styles["row-selected"]]: index === selected,
              })}
              onMouseMove={() => setSelected(index)}
              onClick={() => activate(row)}
            >
              {row.kind === "session" && (
                <div className={styles.group}>
                  <div className={styles["group-title"]}>
                    <SearchHighlight
                      text={row.group.session.topic}
                      keywords={result.keywords}
                    />
                  </div>
                  <div className={styles["group-meta"]}>
                    {text.MatchCount(
                      row.group.matches.length + Number(row.group.titleMatched),
                    )}
                  </div>
                  <div className={styles["group-meta"]}>
                    {new Date(row.group.session.lastUpdate).toLocaleString()}
                  </div>
                </div>
              )}
              {row.kind === "message" && (
                <div className={styles.match}>
                  <div className={styles["match-meta"]}>
                    {row.match.role === "user" ? text.Role.User : text.Role.Bot}
                    {" · "}
                    {row.match.date}
                  </div>
                  <SearchHighlight
                    text={row.match.snippet}
                    keywords={result.keywords}
                  />
                </div>
              )}
              {row.kind === "more" && (
                <div className={styles.more}>{text.More(row.hidden)}</div>
              )}
            </div>
          ))}
          {result.truncated && (
            <div className={styles.notice}>
              {text.TooMany(SEARCH_RESULT_LIMIT)}
            </div>
          )}
        </div>
        <div className={styles.footer}>
          {result.keywords.length > 0 && !result.truncated
            ? `${text.Page.SubTitle(result.total)} · `
            : ""}
          {text.Keys}
        </div>
      </div>
    </div>
  );
}

export function GlobalSearch() {
  const { open, setOpen } = useGlobalSearch();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        const search = useGlobalSearch.getState();
        search.setOpen(!search.open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return open ? <SearchPanel onClose={() => setOpen(false)} /> : null;
}
