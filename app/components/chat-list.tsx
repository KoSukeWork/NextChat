import ArchiveIcon from "../icons/archive.svg";
import DeleteIcon from "../icons/delete.svg";
import PinIcon from "../icons/pin-upright.svg";

import styles from "./home.module.scss";
import {
  DragDropContext,
  Droppable,
  Draggable,
  OnDragEndResponder,
} from "@hello-pangea/dnd";

import { useChatStore } from "../store";

import Locale from "../locales";
import { useLocation, useNavigate } from "react-router-dom";
import { Path } from "../constant";
import { MaskAvatar } from "./mask";
import { Mask } from "../store/mask";
import { useRef, useEffect } from "react";
import { showConfirm } from "./ui-lib";
import { useMobileScreen } from "../utils";
import clsx from "clsx";
import { orderedVisibleSessions } from "../utils/chat-order";

export function ChatItem(props: {
  onClick?: () => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onPin?: () => void;
  pinned?: boolean;
  title: string;
  count: number;
  time: string;
  selected: boolean;
  id: string;
  index: number;
  narrow?: boolean;
  mask: Mask;
}) {
  const draggableRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (props.selected && draggableRef.current) {
      draggableRef.current?.scrollIntoView({
        block: "center",
      });
    }
  }, [props.selected]);

  const { pathname: currentPath } = useLocation();
  const pinIndicator = props.pinned ? (
    <span
      className={styles["chat-item-pinned"]}
      title={Locale.Pin.Pinned}
      aria-label={Locale.Pin.Pinned}
    >
      <PinIcon />
    </span>
  ) : null;
  return (
    <Draggable draggableId={`${props.id}`} index={props.index}>
      {(provided) => (
        <div
          className={clsx(styles["chat-item"], {
            [styles["chat-item-selected"]]:
              props.selected &&
              (currentPath === Path.Chat || currentPath === Path.Home),
          })}
          onClick={props.onClick}
          ref={(ele) => {
            draggableRef.current = ele;
            provided.innerRef(ele);
          }}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          title={`${props.title}\n${Locale.ChatItem.ChatItemCount(
            props.count,
          )}`}
        >
          {props.narrow && pinIndicator}
          {props.narrow ? (
            <div className={styles["chat-item-narrow"]}>
              <div className={clsx(styles["chat-item-avatar"], "no-dark")}>
                <MaskAvatar
                  avatar={props.mask.avatar}
                  model={props.mask.modelConfig.model}
                />
              </div>
              <div className={styles["chat-item-narrow-count"]}>
                {props.count}
              </div>
            </div>
          ) : (
            <>
              <div className={styles["chat-item-title"]}>
                {pinIndicator}
                <span className={styles["chat-item-title-text"]}>
                  {props.title}
                </span>
              </div>
              <div className={styles["chat-item-info"]}>
                <div className={styles["chat-item-count"]}>
                  {Locale.ChatItem.ChatItemCount(props.count)}
                </div>
                <div className={styles["chat-item-date"]}>{props.time}</div>
              </div>
            </>
          )}

          <div className={styles["chat-item-actions"]}>
            {props.onPin && (
              <button
                type="button"
                className={clsx(styles["chat-item-pin"], {
                  [styles["chat-item-pin-active"]]: props.pinned,
                })}
                title={props.pinned ? Locale.Pin.Undo : Locale.Pin.Action}
                aria-label={props.pinned ? Locale.Pin.Undo : Locale.Pin.Action}
                aria-pressed={!!props.pinned}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onPin?.();
                }}
              >
                <div className={props.pinned ? "no-dark" : undefined}>
                  <PinIcon />
                </div>
              </button>
            )}
            {props.onArchive && (
              <button
                type="button"
                className={styles["chat-item-archive"]}
                title={Locale.Archive.Action}
                aria-label={Locale.Archive.Action}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onArchive?.();
                }}
              >
                <div>
                  <ArchiveIcon />
                </div>
              </button>
            )}
            <button
              type="button"
              className={styles["chat-item-delete"]}
              aria-label={Locale.Home.DeleteChat}
              onClick={(e) => {
                e.stopPropagation();
                props.onDelete?.();
              }}
            >
              <div>
                <DeleteIcon />
              </div>
            </button>
          </div>
        </div>
      )}
    </Draggable>
  );
}

export function ChatList(props: { narrow?: boolean }) {
  const [sessions, selectedIndex, selectSession, moveSession] = useChatStore(
    (state) => [
      state.sessions,
      state.currentSessionIndex,
      state.selectSession,
      state.moveSession,
    ],
  );
  const chatStore = useChatStore();
  const navigate = useNavigate();
  const isMobileScreen = useMobileScreen();

  // Archived sessions keep their place in `sessions`, so the list works with
  // positions among the visible rows and the store with real indexes.
  const visible = orderedVisibleSessions(sessions);

  const onDragEnd: OnDragEndResponder = (result) => {
    const { destination, source } = result;
    if (!destination) {
      return;
    }

    if (destination.droppableId !== source.droppableId) return;
    const dragged = visible[source.index];
    if (!dragged) return;
    const pinnedCount = visible.filter(({ session }) => session.pinned).length;
    const first = dragged.session.pinned ? 0 : pinnedCount;
    const last = dragged.session.pinned ? pinnedCount - 1 : visible.length - 1;
    const target = Math.max(first, Math.min(last, destination.index));
    if (target === source.index || !visible[target]) return;
    moveSession(dragged.index, visible[target].index);
  };

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <Droppable droppableId="chat-list">
        {(provided) => (
          <div
            className={styles["chat-list"]}
            ref={provided.innerRef}
            {...provided.droppableProps}
          >
            {visible.map(({ session: item, index: i }, position) => (
              <ChatItem
                title={item.topic}
                time={new Date(item.lastUpdate).toLocaleString()}
                count={item.messages.length}
                key={item.id}
                id={item.id}
                index={position}
                selected={i === selectedIndex}
                onClick={() => {
                  navigate(Path.Chat);
                  selectSession(i);
                }}
                onDelete={async () => {
                  if (
                    (!props.narrow && !isMobileScreen) ||
                    (await showConfirm(Locale.Home.DeleteChat))
                  ) {
                    chatStore.deleteSession(i);
                  }
                }}
                onArchive={
                  item.messages.length > 0
                    ? () => chatStore.archiveSession(item.id)
                    : undefined
                }
                pinned={item.pinned}
                onPin={
                  item.messages.length > 0 || item.pinned
                    ? () => chatStore.togglePinSession(item.id)
                    : undefined
                }
                narrow={props.narrow}
                mask={item.mask}
              />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </DragDropContext>
  );
}
