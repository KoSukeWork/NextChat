import ArchiveIcon from "../icons/archive.svg";
import DeleteIcon from "../icons/delete.svg";
import FolderMoveIcon from "../icons/folder-move.svg";
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
import { useRef, useEffect, useState } from "react";
import { showConfirm } from "./ui-lib";
import { useMobileScreen } from "../utils";
import clsx from "clsx";
import { orderedVisibleSessions } from "../utils/chat-order";
import { effectiveFolderId, sessionFolder } from "../utils/chat-folders";
import { useChatFolderUI } from "../store/chat-folder-ui";
import {
  FolderTabs,
  MoveChatFolderDialog,
  FOLDER_DROP_PREFIX,
} from "./chat-folders";

export function ChatItem(props: {
  onClick?: () => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onPin?: () => void;
  onMove?: () => void;
  folderName?: string;
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
                  {props.folderName && <> · {props.folderName}</>}
                </div>
                <div className={styles["chat-item-date"]}>{props.time}</div>
              </div>
            </>
          )}

          <div className={styles["chat-item-actions"]}>
            {props.onMove && (
              <button
                type="button"
                className={styles["chat-item-move"]}
                title={Locale.Folder.MoveChat}
                aria-label={Locale.Folder.MoveChat}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onMove?.();
                }}
              >
                <div>
                  <FolderMoveIcon />
                </div>
              </button>
            )}
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
  const selection = useChatFolderUI();
  const [movingId, setMovingId] = useState<string | null>(null);
  const folderBar = useRef<HTMLDivElement>(null);
  const dragPoint = useRef<{ x: number; y: number } | null>(null);
  const draggingChat = useRef(false);
  const [draggingUnpinned, setDraggingUnpinned] = useState(false);
  const [hoveredFolder, setHoveredFolder] = useState<
    string | null | undefined
  >();
  const navigate = useNavigate();
  const isMobileScreen = useMobileScreen();

  function folderAtPoint(point: { x: number; y: number }) {
    const bar = folderBar.current;
    if (!bar) return undefined;
    const bounds = bar.getBoundingClientRect();
    if (
      point.x < bounds.left ||
      point.x > bounds.right ||
      point.y < bounds.top ||
      point.y > bounds.bottom
    )
      return undefined;
    const target = [
      ...bar.querySelectorAll<HTMLElement>("[data-chat-folder-drop]"),
    ].find((item) => {
      const rect = item.getBoundingClientRect();
      return (
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom
      );
    });
    return target?.dataset.chatFolderDrop ?? null;
  }

  useEffect(() => {
    const update = (point: { x: number; y: number }) => {
      dragPoint.current = point;
      if (draggingChat.current) setHoveredFolder(folderAtPoint(point) ?? null);
    };
    const mouse = (event: MouseEvent) =>
      update({ x: event.clientX, y: event.clientY });
    const touch = (event: TouchEvent) => {
      const point = event.changedTouches[0];
      if (point) update({ x: point.clientX, y: point.clientY });
    };
    window.addEventListener("mousemove", mouse, true);
    window.addEventListener("mouseup", mouse, true);
    window.addEventListener("touchmove", touch, true);
    window.addEventListener("touchend", touch, true);
    return () => {
      window.removeEventListener("mousemove", mouse, true);
      window.removeEventListener("mouseup", mouse, true);
      window.removeEventListener("touchmove", touch, true);
      window.removeEventListener("touchend", touch, true);
    };
  }, []);

  // Archived sessions keep their place in `sessions`, so the list works with
  // positions among the visible rows and the store with real indexes.
  const folders = chatStore.folders ?? [];
  const selectedFolder = props.narrow
    ? undefined
    : effectiveFolderId(selection.selectedFolderId, folders);
  const visible = orderedVisibleSessions(sessions).filter(
    ({ session }) => !selectedFolder || session.folderId === selectedFolder,
  );

  const onDragEnd: OnDragEndResponder = (result, provided) => {
    const { destination, source } = result;
    // A response can change the visible order during a drag. The ID still
    // identifies the item the user picked up, whereas source.index is stale.
    const dragged = result.draggableId
      ? visible.find(({ session }) => session.id === result.draggableId)
      : visible[source.index];
    // A wide chat card can overlap several small tabs simultaneously. The
    // library's collision rule picks the first one, so use the release point
    // when the pointer is actually inside the folder bar.
    const point = dragPoint.current;
    draggingChat.current = false;
    setDraggingUnpinned(false);
    setHoveredFolder(undefined);
    if (result.reason === "CANCEL") return;
    if (source.droppableId === "chat-list" && point) {
      const folderId = folderAtPoint(point);
      if (folderId !== undefined) {
        const folder = folders.find((item) => item.id === folderId);
        if (dragged && folder) {
          chatStore.moveSessionToFolder(dragged.session.id, folder.id);
          provided?.announce(Locale.Folder.MovedTo(folder.name));
        } else provided?.announce(Locale.Folder.MoveCancelled);
        return;
      }
      if (destination?.droppableId.startsWith(FOLDER_DROP_PREFIX)) {
        provided?.announce(Locale.Folder.MoveCancelled);
        return;
      }
    }
    if (!destination) {
      return;
    }

    if (
      source.droppableId === "folder-tabs" &&
      destination.droppableId === "folder-tabs"
    ) {
      chatStore.reorderFolders(source.index, destination.index);
      return;
    }
    if (
      source.droppableId === "chat-list" &&
      destination.droppableId.startsWith(FOLDER_DROP_PREFIX)
    ) {
      const folder = folders.find(
        (item) =>
          item.id === destination.droppableId.slice(FOLDER_DROP_PREFIX.length),
      );
      if (dragged && folder) {
        chatStore.moveSessionToFolder(dragged.session.id, folder.id);
        provided?.announce(Locale.Folder.MovedTo(folder.name));
      }
      return;
    }
    if (destination.droppableId !== source.droppableId) return;
    if (!dragged?.session.pinned) return;
    const pinnedCount = visible.filter(({ session }) => session.pinned).length;
    const target = Math.max(0, Math.min(pinnedCount - 1, destination.index));
    if (target === visible.indexOf(dragged) || !visible[target]) return;
    moveSession(dragged.index, visible[target].index);
  };

  return (
    <DragDropContext
      onDragStart={(start) => {
        draggingChat.current = start.source.droppableId === "chat-list";
        const dragged = start.draggableId
          ? visible.find(({ session }) => session.id === start.draggableId)
          : visible[start.source.index];
        setDraggingUnpinned(draggingChat.current && !dragged?.session.pinned);
        dragPoint.current = null;
        setHoveredFolder(undefined);
      }}
      onDragEnd={onDragEnd}
    >
      <div className={styles["chat-list-layout"]}>
        {!props.narrow && (
          <FolderTabs
            folders={folders}
            selectedId={selectedFolder}
            barRef={folderBar}
            hoveredFolder={hoveredFolder}
          />
        )}
        <Droppable
          droppableId="chat-list"
          type="CHAT"
          isDropDisabled={draggingUnpinned}
        >
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
                  onMove={() => setMovingId(item.id)}
                  folderName={
                    !selectedFolder
                      ? sessionFolder(item, folders)?.name
                      : undefined
                  }
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
              {selectedFolder && visible.length === 0 && (
                <div className={styles["folder-empty"]}>
                  {Locale.Folder.Empty}
                </div>
              )}
              {provided.placeholder}
            </div>
          )}
        </Droppable>
        {movingId && (
          <MoveChatFolderDialog
            sessionId={movingId}
            onClose={() => setMovingId(null)}
          />
        )}
      </div>
    </DragDropContext>
  );
}
