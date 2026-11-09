import React, { useRef, useState } from "react";
import { Draggable, Droppable } from "@hello-pangea/dnd";
import { useChatStore } from "../store";
import type { ChatFolder } from "../store/chat";
import { useChatFolderUI } from "../store/chat-folder-ui";
import { effectiveFolderId, orderedFolders } from "../utils/chat-folders";
import Locale from "../locales";
import { IconButton } from "./button";
import { Modal } from "./ui-lib";
import styles from "./home.module.scss";

export const FOLDER_DROP_PREFIX = "folder-drop:";
export const FOLDER_TAB_PREFIX = "folder-tab:";

function Dialog(props: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  actions?: React.ReactNode[];
}) {
  return (
    <div
      className="modal-mask"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <Modal
        title={props.title}
        onClose={props.onClose}
        actions={props.actions}
      >
        {props.children}
      </Modal>
    </div>
  );
}

function FolderNameDialog(props: {
  folder?: ChatFolder;
  onClose: () => void;
  onSaved: (folder: ChatFolder) => void;
}) {
  const [name, setName] = useState(props.folder?.name ?? "");
  const [error, setError] = useState("");
  const composing = useRef(false);
  const save = () => {
    const store = useChatStore.getState();
    const result = props.folder
      ? store.renameFolder(props.folder.id, name)
      : store.createFolder(name);
    if (result.error) {
      setError(
        result.error === "empty"
          ? Locale.Folder.EmptyName
          : result.error === "duplicate"
          ? Locale.Folder.DuplicateName
          : Locale.Folder.Missing,
      );
      return;
    }
    if (result.folder) props.onSaved(result.folder);
  };
  return (
    <Dialog
      title={props.folder ? Locale.Folder.Rename : Locale.Folder.Name}
      onClose={props.onClose}
    >
      <input
        className={styles["folder-name-input"]}
        aria-label={Locale.Folder.Name}
        aria-invalid={!!error}
        aria-describedby={error ? "folder-name-error" : undefined}
        autoFocus
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (!composing.current && !event.nativeEvent.isComposing)
              props.onClose();
          } else if (event.key === "Enter") {
            if (
              !composing.current &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              save();
            }
          }
        }}
      />
      {error && (
        <div
          id="folder-name-error"
          role="alert"
          className={styles["folder-name-error"]}
        >
          {error}
        </div>
      )}
      <div className={styles["folder-name-actions"]}>
        <IconButton text={Locale.UI.Cancel} onClick={props.onClose} bordered />
        <IconButton
          text={Locale.UI.Confirm}
          onClick={save}
          type="primary"
          bordered
        />
      </div>
    </Dialog>
  );
}

export function FolderTabs(props: {
  folders: ChatFolder[];
  selectedId?: string;
  barRef?: React.RefObject<HTMLDivElement>;
  hoveredFolder?: string | null;
}) {
  const folders = orderedFolders(props.folders);
  const [optionsId, setOptionsId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [nameDialog, setNameDialog] = useState<{ folder?: ChatFolder } | null>(
    null,
  );
  const options = folders.find((folder) => folder.id === optionsId);
  const deleting = folders.find((folder) => folder.id === deleteId);
  const sessions = useChatStore((state) => state.sessions);
  const members = deleting
    ? sessions.filter((session) => session.folderId === deleting.id)
    : [];
  const choose = (id: string | null) =>
    useChatFolderUI.getState().selectFolder(id);

  return (
    <>
      <div className={styles["folder-bar"]} ref={props.barRef} data-folder-bar>
        <button
          type="button"
          className={styles["folder-all"]}
          aria-pressed={!props.selectedId}
          onClick={() => choose(null)}
        >
          {Locale.Folder.All}
        </button>
        <Droppable
          droppableId="folder-tabs"
          direction="horizontal"
          type="FOLDER"
        >
          {(provided) => (
            <div
              className={styles["folder-tabs"]}
              ref={provided.innerRef}
              {...provided.droppableProps}
            >
              {folders.map((folder, index) => (
                <Draggable
                  key={folder.id}
                  draggableId={`${FOLDER_TAB_PREFIX}${folder.id}`}
                  index={index}
                >
                  {(drag) => (
                    <div
                      className={styles["folder-tab-wrap"]}
                      data-chat-folder-drop={folder.id}
                      data-selected={
                        props.selectedId === folder.id || undefined
                      }
                      ref={drag.innerRef}
                      {...drag.draggableProps}
                      {...drag.dragHandleProps}
                    >
                      <Droppable
                        droppableId={`${FOLDER_DROP_PREFIX}${folder.id}`}
                        direction="horizontal"
                        type="CHAT"
                      >
                        {(drop, snapshot) => (
                          <div
                            ref={drop.innerRef}
                            {...drop.droppableProps}
                            className={styles["folder-drop"]}
                            data-drop-active={
                              (props.hoveredFolder === undefined
                                ? snapshot?.isDraggingOver
                                : props.hoveredFolder === folder.id) ||
                              undefined
                            }
                          >
                            <div
                              role="button"
                              tabIndex={0}
                              aria-pressed={props.selectedId === folder.id}
                              className={styles["folder-tab"]}
                              onClick={() => choose(folder.id)}
                              onKeyDown={(event) => {
                                if (
                                  event.key === "Enter" ||
                                  event.key === " "
                                ) {
                                  event.preventDefault();
                                  choose(folder.id);
                                }
                              }}
                            >
                              {folder.name}
                            </div>
                            <span className={styles["folder-drop-placeholder"]}>
                              {drop.placeholder}
                            </span>
                          </div>
                        )}
                      </Droppable>
                      <button
                        type="button"
                        className={styles["folder-options"]}
                        aria-label={Locale.Folder.Options(folder.name)}
                        title={Locale.Folder.Options(folder.name)}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOptionsId(folder.id);
                        }}
                      >
                        ⋮
                      </button>
                    </div>
                  )}
                </Draggable>
              ))}
              {provided.placeholder}
            </div>
          )}
        </Droppable>
        <button
          type="button"
          className={styles["folder-add"]}
          title={Locale.Folder.Create}
          aria-label={Locale.Folder.Create}
          onClick={() => setNameDialog({})}
        >
          +
        </button>
      </div>
      {options && (
        <Dialog
          title={Locale.Folder.Options(options.name)}
          onClose={() => setOptionsId(null)}
        >
          <div className={styles["folder-dialog-actions"]}>
            <IconButton
              text={Locale.Folder.Rename}
              onClick={() => {
                setOptionsId(null);
                setNameDialog({ folder: options });
              }}
              bordered
            />
            <IconButton
              text={Locale.Folder.Delete}
              onClick={() => {
                setOptionsId(null);
                setDeleteId(options.id);
              }}
              bordered
            />
            <IconButton
              text={Locale.Folder.MoveLeft}
              disabled={folders[0]?.id === options.id}
              onClick={() =>
                useChatStore.getState().reorderFolders(
                  folders.findIndex((f) => f.id === options.id),
                  folders.findIndex((f) => f.id === options.id) - 1,
                )
              }
              bordered
            />
            <IconButton
              text={Locale.Folder.MoveRight}
              disabled={folders.at(-1)?.id === options.id}
              onClick={() =>
                useChatStore.getState().reorderFolders(
                  folders.findIndex((f) => f.id === options.id),
                  folders.findIndex((f) => f.id === options.id) + 1,
                )
              }
              bordered
            />
          </div>
        </Dialog>
      )}
      {deleting && (
        <Dialog title={Locale.Folder.Delete} onClose={() => setDeleteId(null)}>
          <p>
            {Locale.Folder.DeleteQuestion(
              deleting.name,
              members.length,
              members.filter((session) => session.archived).length,
            )}
          </p>
          <div className={styles["folder-dialog-actions"]}>
            <IconButton
              text={Locale.UI.Cancel}
              onClick={() => setDeleteId(null)}
              bordered
            />
            <IconButton
              text={Locale.Folder.DeleteFolderOnly}
              onClick={() => {
                useChatStore.getState().deleteFolder(deleting.id, false);
                setDeleteId(null);
              }}
              bordered
            />
            <IconButton
              text={Locale.Folder.DeleteWithChats}
              type="danger"
              onClick={() => {
                useChatStore.getState().deleteFolder(deleting.id, true);
                setDeleteId(null);
              }}
              bordered
            />
          </div>
        </Dialog>
      )}
      {nameDialog && (
        <FolderNameDialog
          folder={nameDialog.folder}
          onClose={() => setNameDialog(null)}
          onSaved={(folder) => {
            if (!nameDialog.folder) choose(folder.id);
            setNameDialog(null);
          }}
        />
      )}
    </>
  );
}

export function MoveChatFolderDialog(props: {
  sessionId: string;
  onClose: () => void;
}) {
  const folders = orderedFolders(useChatStore((state) => state.folders ?? []));
  const session = useChatStore((state) =>
    state.sessions.find((item) => item.id === props.sessionId),
  );
  const current = effectiveFolderId(session?.folderId, folders);
  const [creating, setCreating] = useState(false);
  const move = (id?: string) => {
    if (id !== current)
      useChatStore.getState().moveSessionToFolder(props.sessionId, id);
    props.onClose();
  };
  if (creating)
    return (
      <FolderNameDialog
        onClose={() => setCreating(false)}
        onSaved={(folder) => move(folder.id)}
      />
    );
  return (
    <Dialog title={Locale.Folder.MoveChat} onClose={props.onClose}>
      <div className={styles["folder-dialog-actions"]}>
        <IconButton
          text={
            current
              ? Locale.Folder.Ungrouped
              : Locale.Folder.Current(Locale.Folder.Ungrouped)
          }
          onClick={() => move()}
          bordered
        />
        {folders.map((folder) => (
          <IconButton
            key={folder.id}
            text={
              current === folder.id
                ? Locale.Folder.Current(folder.name)
                : folder.name
            }
            onClick={() => move(folder.id)}
            bordered
          />
        ))}
        <IconButton
          text={Locale.Folder.Create}
          onClick={() => setCreating(true)}
          bordered
        />
      </div>
    </Dialog>
  );
}
