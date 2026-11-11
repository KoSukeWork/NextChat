import { stripThinking, stripThinkingFromMessages } from "../utils/thinking";
import {
  getMessageTextContentForContext,
  safeLocalStorage,
  trimTopic,
} from "../utils";

import { indexedDBStorage } from "@/app/utils/indexedDB-storage";
import { nanoid } from "nanoid";
import type { MultimodalContent, RequestMessage } from "../client/api";
import { getClientApi } from "../client/endpoint-client";
import { ChatControllerPool } from "../client/controller";
import { showToast } from "../components/ui-lib";
import {
  DEFAULT_INPUT_TEMPLATE,
  DEFAULT_SYSTEM_TEMPLATE,
  KnowledgeCutOffDate,
  StoreKey,
} from "../constant";
import Locale, { getLang } from "../locales";
import { prettyObject } from "../utils/format";
import { createPersistStore } from "../utils/store";
import { estimateTokenLength } from "../utils/token";
import { ModelConfig, ModelType, useAppConfig } from "./config";
import { resolveConfiguredModel } from "../utils/endpoint-resolution";
import {
  deletionTimestamp,
  restoredTimestamp,
  validTimestamp,
  sessionIsSyncable,
} from "../utils/chat-deletion";
import {
  orderedNeighbourIds,
  orderedVisibleSessions,
} from "../utils/chat-order";
import { createEmptyMask, Mask } from "./mask";
import { cleanMcpHistory } from "../mcp/utils";
import type { ToolDisplay } from "../mcp/tool-runtime";
import { useChatFolderUI } from "./chat-folder-ui";
import {
  orderedFolders,
  uniqueFolderName,
  visibleFolderId,
} from "../utils/chat-folders";

const localStorage = safeLocalStorage();

// Server error bodies and transport exceptions can contain keys or request URLs.
function titleRefreshError(error: Error) {
  const status = (error as Error & { status?: unknown }).status;
  const fromMessage = /^HTTP ([45]\d\d)(?:\D|$)/.exec(error.message);
  const httpStatus =
    typeof status === "number" ? status : Number(fromMessage?.[1]);
  if (Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599)
    return `HTTP ${httpStatus}`;
  const network = Locale.Settings.Sync.Errors;
  const safeMessages = [
    network.NETWORK_DNS,
    network.NETWORK_TLS,
    network.NETWORK_TIMEOUT,
    network.NETWORK_REFUSED,
    network.NETWORK_CONNECT,
    network.NETWORK_FAILED,
  ];
  if (safeMessages.includes(error.message)) return error.message;
  if (
    error instanceof TypeError ||
    /^(failed to fetch|networkerror|network request failed)/i.test(
      error.message,
    )
  )
    return network.NETWORK_FAILED;
  return Locale.Chat.Actions.RefreshTitleUnknownError;
}

export type ChatMessageTool = {
  id: string;
  index?: number;
  type?: string;
  function?: {
    name: string;
    arguments?: string;
  };
  content?: string;
  isError?: boolean;
  errorMsg?: string;
  display?: ToolDisplay;
};

export type ChatMessage = RequestMessage & {
  date: string;
  streaming?: boolean;
  thinkingActive?: boolean;
  isError?: boolean;
  id: string;
  model?: ModelType;
  tools?: ChatMessageTool[];
  audio_url?: string;
  isMcpResponse?: boolean;
  toolMode?: "native" | "text";
};

export function createMessage(override: Partial<ChatMessage>): ChatMessage {
  return {
    id: nanoid(),
    date: new Date().toLocaleString(),
    role: "user",
    content: "",
    ...override,
  };
}

export interface ChatStat {
  tokenCount: number;
  wordCount: number;
  charCount: number;
}

export interface ChatSession {
  id: string;
  topic: string;

  memoryPrompt: string;
  messages: ChatMessage[];
  stat: ChatStat;
  lastUpdate: number;
  lastSummarizeIndex: number;
  clearContextIndex?: number;

  mask: Mask;

  // Archived sessions stay in `sessions`, hidden from the list but still
  // openable and searchable. The newer archive or restore wins when syncing.
  archived?: boolean;
  archiveUpdatedAt?: number;
  pinned?: boolean;
  pinUpdatedAt?: number;
  folderId?: string;
  folderUpdatedAt?: number;
}

export interface ChatFolder {
  id: string;
  name: string;
  order: number;
  updatedAt: number;
}

export const DEFAULT_TOPIC = Locale.Store.DefaultTopic;
export const BOT_HELLO: ChatMessage = createMessage({
  role: "assistant",
  content: Locale.Store.BotHello,
});

export function createEmptySession(): ChatSession {
  return {
    id: nanoid(),
    topic: DEFAULT_TOPIC,
    memoryPrompt: "",
    messages: [],
    stat: {
      tokenCount: 0,
      wordCount: 0,
      charCount: 0,
    },
    lastUpdate: Date.now(),
    lastSummarizeIndex: 0,

    mask: createEmptyMask(),
  };
}

type SessionRemoval = {
  items: { session: ChatSession; index: number; deletedAt?: number }[];
  selectedId?: string;
  fallbackId?: string;
  fallbackInitial?: string;
  placeholder?: { id: string; initial: string };
};

type SessionState = {
  sessions: ChatSession[];
  currentSessionIndex: number;
  deletedSessions: Record<string, number>;
};

// Both single and folder deletion use the same tombstone and selection rules.
function removeSessions(
  state: SessionState,
  ids: Set<string>,
  folderId?: string,
) {
  const selectedId = state.sessions[state.currentSessionIndex]?.id;
  const neighbours = orderedNeighbourIds(
    state.sessions,
    state.currentSessionIndex,
    folderId,
  );
  const deletedSessions: Record<string, number> = Object.assign(
    Object.create(null),
    state.deletedSessions ?? {},
  );
  const items: SessionRemoval["items"] = [];
  const sessions = state.sessions.filter((session, index) => {
    if (!ids.has(session.id)) return true;
    const deletedAt = sessionIsSyncable(session)
      ? deletionTimestamp(session, deletedSessions[session.id])
      : undefined;
    if (deletedAt !== undefined) deletedSessions[session.id] = deletedAt;
    items.push({ session, index, deletedAt });
    return false;
  });

  let placeholder: SessionRemoval["placeholder"];
  if (items.length && sessions.every((session) => session.archived)) {
    const empty = createEmptySession();
    sessions.unshift(empty);
    placeholder = { id: empty.id, initial: JSON.stringify(empty) };
  }
  let selected = sessions.findIndex((session) => session.id === selectedId);
  if (selected < 0) {
    const next = neighbours.find((id) => !ids.has(id));
    selected = next ? sessions.findIndex((session) => session.id === next) : 0;
  }
  const snapshot: SessionRemoval = {
    items,
    selectedId,
    fallbackId: sessions[selected]?.id,
    fallbackInitial: JSON.stringify(sessions[selected]),
    placeholder,
  };
  return {
    state: { sessions, currentSessionIndex: selected, deletedSessions },
    snapshot,
  };
}

function restoreSessions(state: SessionState, snapshot: SessionRemoval) {
  const current = state.sessions[state.currentSessionIndex];
  const currentId = current?.id;
  const sessions = state.sessions.filter(
    (session) =>
      session.id !== snapshot.placeholder?.id ||
      JSON.stringify(session) !== snapshot.placeholder.initial,
  );
  const deletedSessions: Record<string, number> = Object.assign(
    Object.create(null),
    state.deletedSessions ?? {},
  );
  for (const { session, index, deletedAt } of snapshot.items) {
    const existing = sessions.findIndex((item) => item.id === session.id);
    const previous = existing >= 0 ? sessions[existing] : session;
    const restored = {
      ...previous,
      lastUpdate: restoredTimestamp(
        previous,
        Math.max(deletedAt ?? 0, validTimestamp(deletedSessions[session.id])),
      ),
    };
    if (existing >= 0) sessions[existing] = restored;
    else sessions.splice(Math.min(index, sessions.length), 0, restored);
    delete deletedSessions[session.id];
  }
  const selectedId =
    currentId === snapshot.fallbackId &&
    JSON.stringify(current) === snapshot.fallbackInitial &&
    snapshot.items.some(({ session }) => session.id === snapshot.selectedId)
      ? snapshot.selectedId
      : currentId;
  const selected = sessions.findIndex((session) => session.id === selectedId);
  return {
    sessions,
    currentSessionIndex: Math.max(0, selected),
    deletedSessions,
  };
}

function setArchived(session: ChatSession, archived: boolean) {
  session.archived = archived;
  // Stay ahead of a timestamp written by a device whose clock runs fast.
  session.archiveUpdatedAt = Math.max(
    Date.now(),
    (session.archiveUpdatedAt ?? 0) + 1,
  );
}

function countMessages(msgs: ChatMessage[]) {
  return msgs.reduce(
    (pre, cur) =>
      pre + estimateTokenLength(getMessageTextContentForContext(cur)),
    0,
  );
}

function fillTemplateWith(input: string, modelConfig: ModelConfig) {
  const cutoff =
    KnowledgeCutOffDate[modelConfig.model] ?? KnowledgeCutOffDate.default;
  const vars = {
    endpoint:
      useAppConfig
        .getState()
        .endpoints.find((item) => item.id === modelConfig.endpointId)?.name ??
      "",
    cutoff,
    model: modelConfig.model,
    time: new Date().toString(),
    lang: getLang(),
    input: input,
  };

  let output = modelConfig.template ?? DEFAULT_INPUT_TEMPLATE;

  // remove duplicate
  if (input.startsWith(output)) {
    output = "";
  }

  // must contains {{input}}
  const inputVar = "{{input}}";
  if (!output.includes(inputVar)) {
    output += "\n" + inputVar;
  }

  Object.entries(vars).forEach(([name, value]) => {
    const regex = new RegExp(`{{${name}}}`, "g");
    output = output.replace(regex, value.toString()); // Ensure value is a string
  });

  return output;
}

const DEFAULT_CHAT_STATE = {
  sessions: [createEmptySession()],
  deletedSessions: {} as Record<string, number>,
  folders: [] as ChatFolder[],
  deletedFolders: {} as Record<string, number>,
  currentSessionIndex: 0,
  lastInput: "",
};

export const useChatStore = createPersistStore(
  DEFAULT_CHAT_STATE,
  (set, _get) => {
    function get() {
      return {
        ..._get(),
        ...methods,
      };
    }

    const methods = {
      createFolder(name: string) {
        const clean = name.trim();
        if (!clean) return { error: "empty" as const };
        if (
          (get().folders ?? []).some(
            (folder) => folder.name.toLowerCase() === clean.toLowerCase(),
          )
        )
          return { error: "duplicate" as const };
        const folders = orderedFolders(get().folders ?? []);
        const folder: ChatFolder = {
          id: nanoid(),
          name: clean,
          order: folders.length
            ? Math.max(...folders.map((item) => item.order)) + 1
            : 0,
          updatedAt: Date.now(),
        };
        set({ folders: [...folders, folder] });
        return { folder };
      },

      renameFolder(id: string, name: string) {
        const clean = name.trim();
        if (!clean) return { error: "empty" as const };
        const folders = get().folders ?? [];
        const folder = folders.find((item) => item.id === id);
        if (!folder) return { error: "missing" as const };
        if (
          folders.some(
            (item) =>
              item.id !== id && item.name.toLowerCase() === clean.toLowerCase(),
          )
        )
          return { error: "duplicate" as const };
        if (folder.name !== clean)
          set({
            folders: folders.map((item) =>
              item.id === id
                ? {
                    ...item,
                    name: clean,
                    updatedAt: Math.max(
                      Date.now(),
                      validTimestamp(item.updatedAt) + 1,
                    ),
                  }
                : item,
            ),
          });
        return { folder: get().folders.find((item) => item.id === id)! };
      },

      reorderFolders(from: number, to: number) {
        const folders = orderedFolders(get().folders ?? []);
        if (
          from < 0 ||
          to < 0 ||
          from >= folders.length ||
          to >= folders.length ||
          from === to
        )
          return;
        const [item] = folders.splice(from, 1);
        folders.splice(to, 0, item);
        set({
          folders: folders.map((folder, index) =>
            folder.order === index
              ? folder
              : {
                  ...folder,
                  order: index,
                  updatedAt: Math.max(
                    Date.now(),
                    validTimestamp(folder.updatedAt) + 1,
                  ),
                },
          ),
        });
      },

      moveSessionToFolder(id: string, folderId?: string) {
        if (
          folderId &&
          !(get().folders ?? []).some((folder) => folder.id === folderId)
        )
          return false;
        const session = get().sessions.find((item) => item.id === id);
        if (!session) return false;
        if (session.folderId === folderId) return true;
        get().updateTargetSession(session, (target) => {
          target.folderId = folderId;
          target.folderUpdatedAt = Math.max(
            Date.now(),
            validTimestamp(target.folderUpdatedAt) + 1,
          );
        });
        return true;
      },

      deleteFolder(id: string, deleteConversations: boolean) {
        const folder = (get().folders ?? []).find((item) => item.id === id);
        if (!folder) return;
        const members = get().sessions.filter(
          (session) => session.folderId === id,
        );
        const selectedFolder = useChatFolderUI.getState().selectedFolderId;
        const removed = deleteConversations
          ? removeSessions(
              get(),
              new Set(members.map((session) => session.id)),
              visibleFolderId(get().folders ?? [], useChatFolderUI.getState()),
            )
          : undefined;
        if (!deleteConversations)
          for (const session of members) get().moveSessionToFolder(session.id);
        const deletedAt = Math.max(
          Date.now(),
          validTimestamp(folder.updatedAt) + 1,
          validTimestamp(get().deletedFolders?.[id]) + 1,
        );
        set((state) => ({
          ...(removed?.state ?? {}),
          folders: (state.folders ?? []).filter((item) => item.id !== id),
          deletedFolders: {
            ...(state.deletedFolders ?? {}),
            [id]: deletedAt,
          },
        }));
        if (useChatFolderUI.getState().selectedFolderId === id)
          useChatFolderUI.getState().selectFolder(null);
        const selectionVersion = useChatFolderUI.getState().selectionVersion;
        if (removed) {
          showToast(
            Locale.Folder.DeletedWithChats(folder.name, members.length),
            {
              text: Locale.Home.Revert,
              onClick() {
                set((state) => {
                  const folders = (state.folders ?? []).slice();
                  const existing = folders.findIndex((item) => item.id === id);
                  const previous = existing >= 0 ? folders[existing] : folder;
                  const occupied = new Set(
                    folders
                      .filter((item) => item.id !== id)
                      .map((item) => item.name.toLowerCase()),
                  );
                  const restored = {
                    ...previous,
                    name: uniqueFolderName(previous.name, occupied),
                    updatedAt: Math.max(
                      Date.now(),
                      validTimestamp(previous.updatedAt) + 1,
                      deletedAt + 1,
                      validTimestamp(state.deletedFolders?.[id]) + 1,
                    ),
                  };
                  if (existing >= 0) folders[existing] = restored;
                  else folders.push(restored);
                  const deletedFolders = { ...(state.deletedFolders ?? {}) };
                  delete deletedFolders[id];
                  return {
                    ...restoreSessions(state, removed.snapshot),
                    folders: orderedFolders(folders),
                    deletedFolders,
                  };
                });
                if (
                  selectedFolder === id &&
                  useChatFolderUI.getState().selectedFolderId === null &&
                  useChatFolderUI.getState().selectionVersion ===
                    selectionVersion
                )
                  useChatFolderUI.getState().selectFolder(id);
              },
            },
            5000,
          );
        }
      },

      forkSession() {
        // 获取当前会话
        const currentSession = get().currentSession();
        if (!currentSession) return;

        const newSession = createEmptySession();
        const folderId = visibleFolderId(
          get().folders ?? [],
          useChatFolderUI.getState(),
        );
        if (folderId) {
          newSession.folderId = folderId;
          newSession.folderUpdatedAt = Date.now();
        }

        newSession.topic = currentSession.topic;
        // 深拷贝消息
        newSession.messages = currentSession.messages.map((msg) => ({
          ...msg,
          id: nanoid(), // 生成新的消息 ID
        }));
        newSession.mask = {
          ...currentSession.mask,
          modelConfig: {
            ...currentSession.mask.modelConfig,
          },
        };

        set((state) => ({
          currentSessionIndex: 0,
          sessions: [newSession, ...state.sessions],
        }));
      },

      clearSessions() {
        set((state) => {
          const deletedSessions: Record<string, number> = Object.assign(
            Object.create(null),
            state.deletedSessions ?? {},
          );
          for (const session of state.sessions) {
            if (sessionIsSyncable(session)) {
              deletedSessions[session.id] = deletionTimestamp(
                session,
                deletedSessions[session.id],
              );
            }
          }
          return {
            sessions: [createEmptySession()],
            currentSessionIndex: 0,
            deletedSessions,
          };
        });
      },

      selectSession(index: number) {
        set({
          currentSessionIndex: index,
        });
      },

      selectSessionById(id: string) {
        const index = get().sessions.findIndex((s) => s.id === id);
        if (index < 0) return false;
        get().selectSession(index);
        return true;
      },

      archiveSession(id: string) {
        const { sessions, currentSessionIndex } = get();
        const index = sessions.findIndex((s) => s.id === id);
        const session = sessions[index];
        if (!session || session.archived || session.messages.length === 0) {
          return;
        }
        const wasCurrent = index === currentSessionIndex;
        const folderId = visibleFolderId(
          get().folders ?? [],
          useChatFolderUI.getState(),
        );
        const neighbourId = orderedNeighbourIds(sessions, index, folderId)[0];

        get().updateTargetSession(session, (target) =>
          setArchived(target, true),
        );

        if (sessions.every((s) => s.archived)) {
          set(() => ({
            sessions: [createEmptySession(), ...sessions],
            currentSessionIndex: wasCurrent ? 0 : currentSessionIndex + 1,
          }));
        } else if (wasCurrent) {
          const neighbourIndex = sessions.findIndex(
            (item) => item.id === neighbourId,
          );
          if (neighbourIndex >= 0) get().selectSession(neighbourIndex);
        }

        showToast(
          Locale.Archive.Toast,
          {
            text: Locale.Home.Revert,
            onClick() {
              get().unarchiveSession(id);
              if (wasCurrent) get().selectSessionById(id);
            },
          },
          5000,
        );
      },

      unarchiveSession(id: string) {
        const session = get().sessions.find((s) => s.id === id);
        if (!session?.archived) return;
        get().updateTargetSession(session, (target) => {
          setArchived(target, false);
          target.lastUpdate = restoredTimestamp(target);
        });
      },

      togglePinSession(id: string) {
        const session = get().sessions.find((s) => s.id === id);
        if (!session || (!session.pinned && session.messages.length === 0))
          return;
        get().updateTargetSession(session, (target) => {
          target.pinned = !target.pinned;
          target.pinUpdatedAt = Math.max(
            Date.now(),
            validTimestamp(target.pinUpdatedAt) + 1,
          );
        });
      },

      moveSession(from: number, to: number) {
        set((state) => {
          const { sessions, currentSessionIndex: oldIndex } = state;

          // move the session
          const newSessions = [...sessions];
          const session = newSessions[from];
          newSessions.splice(from, 1);
          newSessions.splice(to, 0, session);

          // modify current session id
          let newIndex = oldIndex === from ? to : oldIndex;
          if (oldIndex > from && oldIndex <= to) {
            newIndex -= 1;
          } else if (oldIndex < from && oldIndex >= to) {
            newIndex += 1;
          }

          return {
            currentSessionIndex: newIndex,
            sessions: newSessions,
          };
        });
      },

      newSession(mask?: Mask) {
        const session = createEmptySession();
        const folderId = visibleFolderId(
          get().folders ?? [],
          useChatFolderUI.getState(),
        );
        if (folderId) {
          session.folderId = folderId;
          session.folderUpdatedAt = Date.now();
        }

        if (mask) {
          const config = useAppConfig.getState();
          const globalModelConfig = config.modelConfig;

          session.mask = {
            ...mask,
            modelConfig: {
              ...globalModelConfig,
              ...mask.modelConfig,
            },
          };
          session.topic = mask.name;
          const resolved = resolveConfiguredModel(
            session.mask.modelConfig.model,
            session.mask.modelConfig.endpointId,
          );
          if (resolved) Object.assign(session.mask.modelConfig, resolved);
        }

        set((state) => ({
          currentSessionIndex: 0,
          sessions: [session].concat(state.sessions),
        }));
      },

      nextSession(delta: number) {
        const { sessions, currentSessionIndex: i } = get();
        const folderId = visibleFolderId(
          get().folders ?? [],
          useChatFolderUI.getState(),
        );
        const visible = orderedVisibleSessions(sessions)
          .filter(({ session }) => !folderId || session.folderId === folderId)
          .map(({ index }) => index);
        const n = visible.length;
        if (n === 0) return;
        const limit = (x: number) => (x + n) % n;
        const position = visible.indexOf(i);
        if (position >= 0) {
          get().selectSession(visible[limit(position + delta)]);
          return;
        }
        // An open archived chat occupies its usual place within its pin group.
        const withCurrent = orderedVisibleSessions(sessions, i)
          .filter(({ session }) => !folderId || session.folderId === folderId)
          .map(({ index }) => index);
        const current = withCurrent.indexOf(i);
        if (current < 0) {
          get().selectSession(visible[delta > 0 ? 0 : n - 1]);
          return;
        }
        const neighbour =
          (current + (delta > 0 ? 1 : -1) + withCurrent.length) %
          withCurrent.length;
        get().selectSession(withCurrent[neighbour]);
      },

      deleteSession(index: number) {
        const deletedSession = get().sessions.at(index);
        if (!deletedSession) return;
        const removed = removeSessions(
          get(),
          new Set([deletedSession.id]),
          visibleFolderId(get().folders ?? [], useChatFolderUI.getState()),
        );
        set(removed.state);
        showToast(
          Locale.Home.DeleteToast,
          {
            text: Locale.Home.Revert,
            onClick() {
              set((state) => restoreSessions(state, removed.snapshot));
            },
          },
          5000,
        );
      },

      currentSession() {
        let index = get().currentSessionIndex;
        const sessions = get().sessions;

        if (index < 0 || index >= sessions.length) {
          index = Math.min(sessions.length - 1, Math.max(0, index));
          set(() => ({ currentSessionIndex: index }));
        }

        const session = sessions[index];

        return session;
      },

      onNewMessage(message: ChatMessage, targetSession: ChatSession) {
        get().updateTargetSession(targetSession, (session) => {
          session.messages = session.messages.concat();
          session.lastUpdate = restoredTimestamp(session);
        });

        get().updateStat(message, targetSession);

        get().summarizeSession(false, targetSession);
      },

      ensureSessionModel(targetSession?: ChatSession): boolean {
        const session = targetSession ?? get().currentSession();
        const current = session.mask.modelConfig;
        const resolved = resolveConfiguredModel(
          current.model,
          current.endpointId,
        );
        if (!resolved) return false;
        if (
          resolved.model !== current.model ||
          resolved.endpointId !== current.endpointId
        ) {
          get().updateTargetSession(session, (target) => {
            target.mask = {
              ...target.mask,
              modelConfig: { ...current, ...resolved },
            };
          });
        }
        return true;
      },

      async onUserInput(content: string, attachImages?: string[]) {
        const session = get().currentSession();
        if (!get().ensureSessionModel(session)) return;
        const modelConfig = session.mask.modelConfig;
        const pluginIds = [...(session.mask.plugin ?? [])];
        const mcpDisabled = [...(session.mask.mcpDisabled ?? [])];

        // Continuing an archived chat brings it back to the list.
        if (session.archived) {
          get().unarchiveSession(session.id);
        }

        let mContent: string | MultimodalContent[] = fillTemplateWith(
          content,
          modelConfig,
        );

        if (attachImages && attachImages.length > 0) {
          mContent = [
            ...(content ? [{ type: "text" as const, text: content }] : []),
            ...attachImages.map((url) => ({
              type: "image_url" as const,
              image_url: { url },
            })),
          ];
        }

        let userMessage: ChatMessage = createMessage({
          role: "user",
          content: mContent,
        });

        const botMessage: ChatMessage = createMessage({
          role: "assistant",
          streaming: true,
          model: modelConfig.model,
          toolMode: "native",
        });

        // get recent messages
        const recentMessages = await get().getMessagesWithMemory(session);
        const sendMessages = recentMessages.concat(userMessage);
        const messageIndex = session.messages.length + 1;

        // save user's and bot's message
        get().updateTargetSession(session, (session) => {
          const savedUserMessage = {
            ...userMessage,
            content: mContent,
          };
          session.messages = session.messages.concat([
            savedUserMessage,
            botMessage,
          ]);
          session.lastUpdate = restoredTimestamp(session);
        });

        const api = getClientApi(modelConfig.endpointId);
        // make request
        api.llm.chat({
          sessionId: session.id,
          messages: sendMessages,
          config: { ...modelConfig, stream: true },
          pluginIds,
          mcpDisabled,
          enableTools: true,
          onToolModeChange(mode) {
            botMessage.toolMode = mode;
          },
          onTextToolFallback() {
            showToast(Locale.Chat.ToolTextPluginUnavailable);
          },
          onUpdate(message, _chunk, thinkingActive) {
            botMessage.streaming = true;
            botMessage.thinkingActive = thinkingActive;
            botMessage.content = message;
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat();
            });
          },
          async onFinish(message) {
            botMessage.streaming = false;
            botMessage.thinkingActive = false;
            if (message) {
              botMessage.content = message;
              botMessage.date = new Date().toLocaleString();
              get().onNewMessage(botMessage, session);
            } else {
              get().updateTargetSession(session, (target) => {
                target.messages = target.messages.concat();
              });
            }
            ChatControllerPool.remove(session.id, botMessage.id);
          },
          onBeforeTool(tool: ChatMessageTool) {
            (botMessage.tools = botMessage?.tools || []).push(tool);
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat();
            });
          },
          onAfterTool(tool: ChatMessageTool) {
            botMessage?.tools?.forEach((t, i, tools) => {
              if (tool.id == t.id) {
                tools[i] = { ...tool };
              }
            });
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat();
            });
          },
          onError(error) {
            const isAborted = error.message?.includes?.("aborted");
            botMessage.content +=
              "\n\n" +
              prettyObject({
                error: true,
                message: error.message,
              });
            botMessage.streaming = false;
            userMessage.isError = !isAborted;
            botMessage.isError = !isAborted;
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat();
            });
            ChatControllerPool.remove(
              session.id,
              botMessage.id ?? messageIndex,
            );

            console.error("[Chat] failed ", error);
          },
          onController(controller) {
            // collect controller for stop/retry
            ChatControllerPool.addController(
              session.id,
              botMessage.id ?? messageIndex,
              controller,
            );
          },
        });
      },

      getMemoryPrompt(targetSession?: ChatSession) {
        const session = targetSession ?? get().currentSession();

        if (session.memoryPrompt.length) {
          return {
            role: "system",
            content: Locale.Store.Prompt.History(session.memoryPrompt),
            date: "",
          } as ChatMessage;
        }
      },

      async getMessagesWithMemory(targetSession?: ChatSession) {
        const session = targetSession ?? get().currentSession();
        const modelConfig = session.mask.modelConfig;
        const clearContextIndex = session.clearContextIndex ?? 0;
        const messages = session.messages.slice();
        const totalMessageCount = session.messages.length;

        // in-context prompts
        const contextPrompts = session.mask.context.slice();

        // system prompts, to get close to OpenAI Web ChatGPT
        const shouldInjectSystemPrompts =
          modelConfig.enableInjectSystemPrompts &&
          (session.mask.modelConfig.model.startsWith("gpt-") ||
            session.mask.modelConfig.model.startsWith("chatgpt-"));

        var systemPrompts: ChatMessage[] = [];

        if (shouldInjectSystemPrompts) {
          systemPrompts = [
            createMessage({
              role: "system",
              content: fillTemplateWith("", {
                ...modelConfig,
                template: DEFAULT_SYSTEM_TEMPLATE,
              }),
            }),
          ];
        }

        const memoryPrompt = get().getMemoryPrompt(session);
        // long term memory
        const shouldSendLongTermMemory =
          modelConfig.sendMemory &&
          session.memoryPrompt &&
          session.memoryPrompt.length > 0 &&
          session.lastSummarizeIndex > clearContextIndex;
        const longTermMemoryPrompts =
          shouldSendLongTermMemory && memoryPrompt ? [memoryPrompt] : [];
        const longTermMemoryStartIndex = session.lastSummarizeIndex;

        // short term memory
        const shortTermMemoryStartIndex = Math.max(
          0,
          totalMessageCount - modelConfig.historyMessageCount,
        );

        // lets concat send messages, including 4 parts:
        // 0. system prompt: to get close to OpenAI Web ChatGPT
        // 1. long term memory: summarized memory messages
        // 2. pre-defined in-context prompts
        // 3. short term memory: latest n messages
        // 4. newest input message
        const memoryStartIndex = shouldSendLongTermMemory
          ? Math.min(longTermMemoryStartIndex, shortTermMemoryStartIndex)
          : shortTermMemoryStartIndex;
        // and if user has cleared history messages, we should exclude the memory too.
        const contextStartIndex = Math.max(clearContextIndex, memoryStartIndex);
        const maxTokenThreshold = modelConfig.max_tokens;

        // get recent messages as much as possible
        const reversedRecentMessages = [];
        for (
          let i = totalMessageCount - 1, tokenCount = 0;
          i >= contextStartIndex && tokenCount < maxTokenThreshold;
          i -= 1
        ) {
          const msg = messages[i];
          if (!msg || msg.isError) continue;
          tokenCount += estimateTokenLength(
            getMessageTextContentForContext(msg),
          );
          reversedRecentMessages.push(msg);
        }
        // concat all messages
        const recentMessages = [
          ...systemPrompts,
          ...longTermMemoryPrompts,
          ...contextPrompts,
          ...reversedRecentMessages.reverse(),
        ];

        return cleanMcpHistory(stripThinkingFromMessages(recentMessages));
      },

      updateMessage(
        sessionIndex: number,
        messageIndex: number,
        updater: (message?: ChatMessage) => void,
      ) {
        const sessions = get().sessions;
        const session = sessions.at(sessionIndex);
        const messages = session?.messages;
        updater(messages?.at(messageIndex));
        set(() => ({ sessions }));
      },

      resetSession(session: ChatSession) {
        get().updateTargetSession(session, (session) => {
          session.messages = [];
          session.memoryPrompt = "";
        });
      },

      summarizeSession(
        refreshTitle: boolean = false,
        targetSession: ChatSession,
      ) {
        const config = useAppConfig.getState();
        const session = targetSession;
        const modelConfig = session.mask.modelConfig;
        const originalMessages = stripThinkingFromMessages(session.messages);
        const messages = cleanMcpHistory(originalMessages);
        const shouldGenerateTitle =
          (config.enableAutoGenerateTitle &&
            session.topic === DEFAULT_TOPIC &&
            countMessages(messages) >= 50) ||
          refreshTitle;
        const summarizeIndex = Math.max(
          session.lastSummarizeIndex,
          session.clearContextIndex ?? 0,
        );
        let toBeSummarizedMsgs = cleanMcpHistory(
          originalMessages.filter((msg) => !msg.isError).slice(summarizeIndex),
        );
        const historyMsgLength = countMessages(toBeSummarizedMsgs);
        const shouldSummarize =
          historyMsgLength > modelConfig.compressMessageLengthThreshold &&
          modelConfig.sendMemory;
        if (!shouldGenerateTitle && !shouldSummarize) return;

        // Resolve only when a title or summary request will actually be sent.
        const usingCompressionModel = !!modelConfig.compressModel;
        const requestedModel = usingCompressionModel
          ? modelConfig.compressModel
          : modelConfig.model;
        const requestedEndpoint = usingCompressionModel
          ? modelConfig.compressEndpointId
          : modelConfig.endpointId;
        const resolved = resolveConfiguredModel(
          requestedModel,
          requestedEndpoint,
          shouldGenerateTitle,
        );
        if (!resolved) {
          if (refreshTitle && shouldGenerateTitle)
            showToast(
              Locale.Chat.Actions.RefreshTitleFailed(
                Locale.ModelDiscovery.ConfigureFirst,
              ),
            );
          return;
        }
        const { model, endpointId } = resolved;
        if (model !== requestedModel || endpointId !== requestedEndpoint) {
          get().updateTargetSession(session, (target) => {
            target.mask = {
              ...target.mask,
              modelConfig: {
                ...modelConfig,
                ...(usingCompressionModel
                  ? { compressModel: model, compressEndpointId: endpointId }
                  : { model, endpointId }),
              },
            };
          });
        }
        const api = getClientApi(endpointId);

        if (shouldGenerateTitle) {
          const startIndex = Math.max(
            0,
            messages.length - modelConfig.historyMessageCount,
          );
          const topicMessages = messages
            .slice(
              startIndex < messages.length ? startIndex : messages.length - 1,
              messages.length,
            )
            .concat(
              createMessage({
                role: "user",
                content: Locale.Store.Prompt.Topic,
              }),
            );
          api.llm.chat({
            messages: topicMessages,
            config: {
              model,
              stream: true,
              endpointId,
            },
            onFinish(message, responseRes) {
              if (responseRes?.status !== 200) {
                if (refreshTitle) {
                  const reason =
                    responseRes?.status === 499
                      ? Locale.Settings.Sync.Errors.NETWORK_TIMEOUT
                      : responseRes?.status
                      ? `HTTP ${responseRes.status}`
                      : Locale.Chat.Actions.RefreshTitleUnknownError;
                  showToast(Locale.Chat.Actions.RefreshTitleFailed(reason));
                }
                return;
              }
              const title = trimTopic(stripThinking(message).trim()).trim();
              if (!title) {
                if (refreshTitle)
                  showToast(Locale.Chat.Actions.RefreshTitleEmpty);
                return;
              }
              get().updateTargetSession(session, (target) => {
                target.topic = title;
              });
            },
            onError(error) {
              if (refreshTitle)
                showToast(
                  Locale.Chat.Actions.RefreshTitleFailed(
                    titleRefreshError(error),
                  ),
                );
            },
          });
        }
        if (historyMsgLength > (modelConfig?.max_tokens || 4000)) {
          const n = toBeSummarizedMsgs.length;
          toBeSummarizedMsgs = toBeSummarizedMsgs.slice(
            Math.max(0, n - modelConfig.historyMessageCount),
          );
        }
        const memoryPrompt = get().getMemoryPrompt(session);
        if (memoryPrompt) {
          // add memory prompt
          toBeSummarizedMsgs.unshift(memoryPrompt);
        }

        const lastSummarizeIndex = session.messages.length;

        console.log(
          "[Chat History] ",
          toBeSummarizedMsgs,
          historyMsgLength,
          modelConfig.compressMessageLengthThreshold,
        );

        if (shouldSummarize) {
          /** Destruct max_tokens while summarizing
           * this param is just shit
           **/
          const { max_tokens, ...modelcfg } = modelConfig;
          api.llm.chat({
            messages: toBeSummarizedMsgs.concat(
              createMessage({
                role: "system",
                content: Locale.Store.Prompt.Summarize,
                date: "",
              }),
            ),
            config: {
              ...modelcfg,
              stream: true,
              model,
              endpointId,
            },
            onUpdate(message) {
              session.memoryPrompt = stripThinking(message);
            },
            onFinish(message, responseRes) {
              if (responseRes?.status === 200) {
                console.log("[Memory] ", message);
                get().updateTargetSession(session, (session) => {
                  session.lastSummarizeIndex = lastSummarizeIndex;
                  session.memoryPrompt = stripThinking(message); // Update the memory prompt for stored it in local storage
                });
              }
            },
            onError(err) {
              console.error("[Summarize] ", err);
            },
          });
        }
      },

      updateStat(message: ChatMessage, session: ChatSession) {
        get().updateTargetSession(session, (session) => {
          session.stat.charCount += message.content.length;
          // TODO: should update chat count and word count
        });
      },
      updateTargetSession(
        targetSession: ChatSession,
        updater: (session: ChatSession) => void,
      ) {
        const sessions = get().sessions;
        const index = sessions.findIndex((s) => s.id === targetSession.id);
        if (index < 0) return;
        updater(sessions[index]);
        set(() => ({ sessions }));
      },
      async clearAllData() {
        await indexedDBStorage.clear();
        localStorage.clear();
        location.reload();
      },
      setLastInput(lastInput: string) {
        set({
          lastInput,
        });
      },
    };

    return methods;
  },
  {
    name: StoreKey.Chat,
    version: 3.3,
    // Start on a chat from the list, not on an archived one left open last time.
    merge(persistedState, currentState) {
      const state = {
        ...currentState,
        ...(persistedState as typeof currentState),
      };
      const index = state.currentSessionIndex;
      if (!state.sessions[index]?.archived) return state;
      const folderId = visibleFolderId(
        state.folders ?? [],
        useChatFolderUI.getState(),
      );
      const nextId = orderedNeighbourIds(state.sessions, index, folderId)[0];
      const next = state.sessions.findIndex((item) => item.id === nextId);
      return next >= 0
        ? { ...state, currentSessionIndex: next }
        : {
            ...state,
            sessions: [createEmptySession(), ...state.sessions],
            currentSessionIndex: 0,
          };
    },
    migrate(persistedState, version) {
      const state = persistedState as any;
      const newState = JSON.parse(
        JSON.stringify(state),
      ) as typeof DEFAULT_CHAT_STATE;
      newState.folders ??= [];
      newState.deletedFolders ??= {};

      if (version < 2) {
        newState.sessions = [];

        const oldSessions = state.sessions;
        for (const oldSession of oldSessions) {
          const newSession = createEmptySession();
          newSession.topic = oldSession.topic;
          newSession.messages = [...oldSession.messages];
          newSession.mask.modelConfig.sendMemory = true;
          newSession.mask.modelConfig.historyMessageCount = 4;
          newSession.mask.modelConfig.compressMessageLengthThreshold = 1000;
          newState.sessions.push(newSession);
        }
      }

      if (version < 3) {
        // migrate id to nanoid
        newState.sessions.forEach((s) => {
          s.id = nanoid();
          s.messages.forEach((m) => (m.id = nanoid()));
        });
      }

      // Enable `enableInjectSystemPrompts` attribute for old sessions.
      // Resolve issue of old sessions not automatically enabling.
      if (version < 3.1) {
        newState.sessions.forEach((s) => {
          if (
            // Exclude those already set by user
            !s.mask.modelConfig.hasOwnProperty("enableInjectSystemPrompts")
          ) {
            // Because users may have changed this configuration,
            // the user's current configuration is used instead of the default
            const config = useAppConfig.getState();
            s.mask.modelConfig.enableInjectSystemPrompts =
              config.modelConfig.enableInjectSystemPrompts;
          }
        });
      }

      // add default summarize model for every session
      if (version < 3.2) {
        newState.sessions.forEach((s) => {
          const config = useAppConfig.getState();
          s.mask.modelConfig.compressModel = config.modelConfig.compressModel;
          s.mask.modelConfig.compressEndpointId =
            config.modelConfig.compressEndpointId;
        });
      }
      // revert default summarize model for every session
      if (version < 3.3) {
        newState.sessions.forEach((s) => {
          const config = useAppConfig.getState();
          s.mask.modelConfig.compressModel = "";
          s.mask.modelConfig.compressEndpointId = "";
        });
      }

      return newState as any;
    },
  },
);

// A folder may disappear during hydration, sync, or backup import on this device.
useChatStore.subscribe((state) => {
  const selection = useChatFolderUI.getState().selectedFolderId;
  if (
    state._hasHydrated &&
    selection &&
    !(state.folders ?? []).some((folder) => folder.id === selection)
  )
    useChatFolderUI.getState().selectFolder(null);
});
