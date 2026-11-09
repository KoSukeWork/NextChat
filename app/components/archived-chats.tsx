import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Path } from "../constant";
import Locale from "../locales";
import { useChatStore } from "../store";
import { useSearchJump } from "../store/search-jump";
import { SEARCH_RESULT_LIMIT, searchSessions } from "../utils/chat-search";
import { sessionFolder } from "../utils/chat-folders";
import { validTimestamp } from "../utils/chat-deletion";
import { IconButton } from "./button";
import { SearchHighlight } from "./search-highlight";
import { ErrorBoundary } from "./error";
import styles from "./mask.module.scss";
import archiveStyles from "./archived-chats.module.scss";
import { showConfirm } from "./ui-lib";
import CloseIcon from "../icons/close.svg";
import DeleteIcon from "../icons/delete.svg";
import EyeIcon from "../icons/eye.svg";
import ReturnIcon from "../icons/return.svg";

export function ArchivedChatsPage() {
  const navigate = useNavigate();
  const chatStore = useChatStore();
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const text = Locale.Archive;

  useEffect(() => {
    if (composing) return;
    const timer = setTimeout(() => setQuery(filter), 150);
    return () => clearTimeout(timer);
  }, [filter, composing]);

  // Zustand replaces the store object on updates, even when the sessions
  // array is mutated in place by an archive, restore, or streaming response.
  const archived = useMemo(
    () =>
      chatStore.sessions
        .filter((session) => session.archived)
        .sort(
          (a, b) => validTimestamp(b.lastUpdate) - validTimestamp(a.lastUpdate),
        ),
    [chatStore],
  );
  const result = useMemo(
    () => searchSessions(archived, query),
    [archived, query],
  );
  const byId = new Map(result.groups.map((group) => [group.session.id, group]));
  const searching = result.keywords.length > 0;
  const visible = searching
    ? archived.filter((session) => byId.has(session.id))
    : archived;

  return (
    <ErrorBoundary>
      <div className={styles["mask-page"]}>
        <div className="window-header">
          <div className="window-header-title">
            <div className="window-header-main-title">{text.Page.Title}</div>
            <div className="window-header-submai-title">
              {text.Page.SubTitle(archived.length)}
            </div>
          </div>
          <div className="window-actions">
            <div className="window-action-button">
              <IconButton
                icon={<CloseIcon />}
                bordered
                onClick={() => navigate(-1)}
              />
            </div>
          </div>
        </div>

        <div className={styles["mask-page-body"]}>
          <div className={styles["mask-filter"]}>
            <input
              type="text"
              className={styles["search-bar"]}
              placeholder={text.Page.Search}
              aria-label={text.Page.Search}
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.currentTarget.value)}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
            />
          </div>

          {visible.length === 0 && (
            <div>{searching ? text.Page.NoResult : text.Page.Empty}</div>
          )}
          {result.truncated && (
            <p>{Locale.SearchChat.TooMany(SEARCH_RESULT_LIMIT)}</p>
          )}

          <div>
            {visible.map((session) => {
              const match = byId.get(session.id)?.matches[0];
              return (
                <div className={styles["mask-item"]} key={session.id}>
                  <div
                    className={`${styles["mask-header"]} ${archiveStyles.header}`}
                  >
                    <div className={styles["mask-title"]}>
                      <div className={styles["mask-name"]}>
                        <SearchHighlight
                          text={session.topic}
                          keywords={result.keywords}
                        />
                      </div>
                      <div>
                        {Locale.ChatItem.ChatItemCount(session.messages.length)}
                        {" · "}
                        {new Date(session.lastUpdate).toLocaleString()}
                        {sessionFolder(session, chatStore.folders)?.name && (
                          <>
                            {" · "}
                            {sessionFolder(session, chatStore.folders)?.name}
                          </>
                        )}
                      </div>
                      {match && (
                        <div className={archiveStyles.snippet}>
                          {match.role === "user"
                            ? Locale.SearchChat.Role.User
                            : Locale.SearchChat.Role.Bot}
                          {" · "}
                          <SearchHighlight
                            text={match.snippet}
                            keywords={result.keywords}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  <div className={styles["mask-actions"]}>
                    <IconButton
                      icon={<EyeIcon />}
                      text={text.View}
                      onClick={() => {
                        if (!chatStore.selectSessionById(session.id)) return;
                        useSearchJump.getState().setRequest(
                          match
                            ? {
                                sessionId: session.id,
                                messageId: match.messageId,
                              }
                            : null,
                        );
                        navigate(Path.Chat);
                      }}
                    />
                    <IconButton
                      icon={<ReturnIcon />}
                      text={text.Restore}
                      onClick={() => chatStore.unarchiveSession(session.id)}
                    />
                    <IconButton
                      icon={<DeleteIcon />}
                      text={text.Delete}
                      onClick={async () => {
                        if (await showConfirm(Locale.Home.DeleteChat)) {
                          const state = useChatStore.getState();
                          const index = state.sessions.findIndex(
                            (s) => s.id === session.id,
                          );
                          if (index >= 0) state.deleteSession(index);
                        }
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
