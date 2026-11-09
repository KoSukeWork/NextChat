import {
  createEmptySession,
  useAccessStore,
  useAppConfig,
  useChatStore,
} from "../store";
import { useMaskStore } from "../store/mask";
import type { ChatFolder } from "../store/chat";
import { useChatFolderUI } from "../store/chat-folder-ui";
import {
  orderedFolders,
  uniqueFolderName,
  visibleFolderId,
} from "./chat-folders";
import { orderedNeighbourIds, orderedVisibleSessions } from "./chat-order";
import { SearchService, usePromptStore } from "../store/prompt";
import { StoreKey } from "../constant";
import { merge } from "./merge";
import {
  restoredTimestamp,
  sessionModifiedAt,
  sessionIsSyncable,
  validTimestamp,
} from "./chat-deletion";

type NonFunctionKeys<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? never : K;
}[keyof T];
type NonFunctionFields<T> = Pick<T, NonFunctionKeys<T>>;

export function getNonFunctionFileds<T extends object>(obj: T) {
  const ret: any = {};

  Object.entries(obj).map(([k, v]) => {
    if (typeof v !== "function") {
      ret[k] = v;
    }
  });

  return ret as NonFunctionFields<T>;
}

export type GetStoreState<T> = T extends { getState: () => infer U }
  ? NonFunctionFields<U>
  : never;

const LocalStateSetters = {
  [StoreKey.Chat]: useChatStore.setState,
  [StoreKey.Access]: useAccessStore.setState,
  [StoreKey.Config]: useAppConfig.setState,
  [StoreKey.Mask]: useMaskStore.setState,
  [StoreKey.Prompt]: usePromptStore.setState,
} as const;

const LocalStateGetters = {
  [StoreKey.Chat]: () => getNonFunctionFileds(useChatStore.getState()),
  [StoreKey.Access]: () => getNonFunctionFileds(useAccessStore.getState()),
  [StoreKey.Config]: () => getNonFunctionFileds(useAppConfig.getState()),
  [StoreKey.Mask]: () => getNonFunctionFileds(useMaskStore.getState()),
  [StoreKey.Prompt]: () => getNonFunctionFileds(usePromptStore.getState()),
} as const;

export type AppState = {
  -readonly [k in keyof typeof LocalStateGetters]: ReturnType<
    (typeof LocalStateGetters)[k]
  >;
};

/** Old exports can restore content, but must not replace local endpoint settings. */
export function prepareImportedState(local: AppState, remote: AppState) {
  const config = remote[StoreKey.Config];
  const legacyApiSettings = !!config && !Array.isArray(config.endpoints);
  return {
    legacyApiSettings,
    state: legacyApiSettings
      ? {
          ...remote,
          [StoreKey.Config]: local[StoreKey.Config],
          [StoreKey.Access]: local[StoreKey.Access],
        }
      : remote,
  };
}

const CloudStoreKeys = [StoreKey.Chat, StoreKey.Mask, StoreKey.Prompt] as const;
export type CloudState = Pick<AppState, (typeof CloudStoreKeys)[number]>;

export function getCloudAppState(): CloudState {
  return Object.fromEntries(
    CloudStoreKeys.map((key) => [key, LocalStateGetters[key]()]),
  ) as CloudState;
}

// Keep empty drafts on this device, but never include them in an upload.
export function prepareCloudUpload(state: CloudState): CloudState {
  const chat = state[StoreKey.Chat];
  const selectedId = chat.sessions[chat.currentSessionIndex]?.id;
  const sessions = chat.sessions.filter(sessionIsSyncable);
  const selected = sessions.findIndex((session) => session.id === selectedId);
  return {
    ...state,
    [StoreKey.Chat]: {
      ...chat,
      sessions,
      currentSessionIndex: Math.max(0, selected),
    },
  };
}

export function setCloudAppState(state: CloudState) {
  CloudStoreKeys.forEach(<K extends keyof CloudState>(key: K) => {
    LocalStateSetters[key](state[key]);
  });
  SearchService.setUserPrompts(
    Object.values(state[StoreKey.Prompt].prompts ?? {}),
  );
}

export function mergeCloudAppState(
  local: CloudState,
  remote: Partial<AppState>,
) {
  CloudStoreKeys.forEach(<K extends keyof CloudState>(key: K) => {
    if (remote[key] !== undefined) {
      local[key] = MergeStates[key](local[key] as AppState[K], remote[key]!);
    }
  });
  return local;
}

type Merger<T extends keyof AppState, U = AppState[T]> = (
  localState: U,
  remoteState: U,
) => U;

type StateMerger = {
  [K in keyof AppState]: Merger<K>;
};

type ChatState = AppState[StoreKey.Chat];

function mergeTombstones(...sources: unknown[]): Record<string, number> {
  const result: Record<string, number> = Object.create(null);
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source))
      continue;
    for (const [id, time] of Object.entries(source)) {
      if (typeof time !== "number" || !Number.isFinite(time)) continue;
      if (
        !Object.prototype.hasOwnProperty.call(result, id) ||
        time > result[id]
      ) {
        result[id] = time;
      }
    }
  }
  return result;
}

type ModifiedItem = { id?: string; createdAt?: number; updatedAt?: number };

/** Merge individual user records and their deletion clocks without mutating imports. */
function mergeUserItems<T extends ModifiedItem>(
  localItems: Record<string, T> | undefined,
  remoteItems: Record<string, T> | undefined,
  localDeleted: Record<string, number> | undefined,
  remoteDeleted: Record<string, number> | undefined,
  restoreImport = false,
) {
  const items: Record<string, T> = Object.create(null);
  const tombstones = mergeTombstones(localDeleted, remoteDeleted);
  const modifiedAt = (item: T) =>
    validTimestamp(item.updatedAt ?? item.createdAt);
  const recordId = (key: string, item: T) =>
    typeof item.id === "string" && item.id ? item.id : key;
  const normalize = (id: string, item: T): T => ({
    ...item,
    id,
    updatedAt: modifiedAt(item),
  });

  for (const [key, item] of Object.entries(localItems ?? {})) {
    const id = recordId(key, item);
    if (!items[id] || modifiedAt(item) > modifiedAt(items[id]))
      items[id] = normalize(id, item);
  }
  for (const [key, incoming] of Object.entries(remoteItems ?? {})) {
    const id = recordId(key, incoming);
    let item = normalize(id, incoming);
    const local = items[id];
    const hasDeletion = Object.prototype.hasOwnProperty.call(tombstones, id);
    if (
      restoreImport &&
      hasDeletion &&
      modifiedAt(item) <= tombstones[id] &&
      (!local || modifiedAt(local) <= tombstones[id])
    ) {
      item = {
        ...item,
        updatedAt: Math.max(
          Date.now(),
          modifiedAt(item) + 1,
          tombstones[id] + 1,
        ),
      };
      delete tombstones[id];
    }
    if (!local || modifiedAt(item) > modifiedAt(local)) items[id] = item;
  }

  for (const [id, item] of Object.entries(items)) {
    if (!Object.prototype.hasOwnProperty.call(tombstones, id)) continue;
    if (modifiedAt(item) > tombstones[id]) delete tombstones[id];
    else delete items[id];
  }
  return { items, tombstones };
}

function mergePromptStates(
  local: AppState[StoreKey.Prompt],
  remote: AppState[StoreKey.Prompt],
  restoreImport = false,
) {
  const merged = mergeUserItems(
    local.prompts,
    remote.prompts,
    local.deletedPrompts,
    remote.deletedPrompts,
    restoreImport,
  );
  local.prompts = merged.items;
  local.deletedPrompts = merged.tombstones;
  return local;
}

function mergeMaskStates(
  local: AppState[StoreKey.Mask],
  remote: AppState[StoreKey.Mask],
  restoreImport = false,
) {
  const merged = mergeUserItems(
    local.masks,
    remote.masks,
    local.deletedMasks,
    remote.deletedMasks,
    restoreImport,
  );
  local.masks = merged.items;
  local.deletedMasks = merged.tombstones;
  return local;
}

function mergeChatStates(
  local: ChatState,
  remote: ChatState,
  restoreImport = false,
): ChatState {
  const oldIndex = local.currentSessionIndex;
  const currentId = local.sessions[oldIndex]?.id;
  const localPinnedIds = local.sessions
    .filter((session) => session.pinned)
    .map((session) => session.id);
  const folderId = visibleFolderId(
    local.folders ?? [],
    useChatFolderUI.getState(),
  );
  const oldNeighbours = orderedNeighbourIds(local.sessions, oldIndex, folderId);
  const folderRecords = (folders: ChatFolder[] | undefined) => {
    const result: Record<string, ChatFolder> = Object.create(null);
    for (const folder of Array.isArray(folders) ? folders : []) {
      if (
        folder &&
        typeof folder.id === "string" &&
        folder.id &&
        typeof folder.name === "string" &&
        folder.name.trim()
      )
        result[folder.id] = {
          ...folder,
          order: Number.isFinite(folder.order) ? folder.order : 0,
        };
    }
    return result;
  };
  const mergedFolders = mergeUserItems(
    folderRecords(local.folders),
    folderRecords(remote.folders),
    local.deletedFolders,
    remote.deletedFolders,
    restoreImport,
  );
  // Concurrent edits on different devices may independently choose the same
  // name. Retain both records and deterministically disambiguate duplicates.
  const records = Object.values(mergedFolders.items).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const reserved = new Set(
    records.map((folder) => folder.name.trim().toLowerCase()),
  );
  const clocks = new Map<string, number>();
  for (const folder of records) {
    const key = folder.name.trim().toLowerCase();
    clocks.set(
      key,
      Math.max(clocks.get(key) ?? 0, validTimestamp(folder.updatedAt)),
    );
  }
  const used = new Set<string>();
  for (const folder of records) {
    const original = folder.name.trim();
    let name = original;
    if (used.has(name.toLowerCase())) {
      name = uniqueFolderName(original, new Set([...reserved, ...used]));
      folder.updatedAt =
        Math.max(
          validTimestamp(folder.updatedAt),
          clocks.get(original.toLowerCase()) ?? 0,
        ) + 1;
    }
    folder.name = name;
    used.add(name.toLowerCase());
  }
  local.folders = orderedFolders(records);
  local.deletedFolders = mergedFolders.tombstones;
  const tombstones = mergeTombstones(
    local.deletedSessions,
    remote.deletedSessions,
  );
  const sessionsById = new Map(
    local.sessions.map((session) => [session.id, session]),
  );

  for (const incoming of remote.sessions) {
    if (!restoreImport && !sessionIsSyncable(incoming)) continue;
    let remoteSession = incoming;
    const hasTombstone = Object.prototype.hasOwnProperty.call(
      tombstones,
      incoming.id,
    );
    if (
      restoreImport &&
      hasTombstone &&
      sessionModifiedAt(incoming) <= tombstones[incoming.id]
    ) {
      // Import is an explicit restore. Beat both clocks without mutating the file.
      remoteSession = {
        ...incoming,
        lastUpdate: restoredTimestamp(incoming, tombstones[incoming.id]),
      };
      delete tombstones[incoming.id];
    }
    const localSession = sessionsById.get(remoteSession.id);
    if (!localSession) {
      local.sessions.push(remoteSession);
      sessionsById.set(remoteSession.id, remoteSession);
      continue;
    }

    const messageIds = new Set(
      localSession.messages.map((message) => message.id),
    );
    for (const message of remoteSession.messages) {
      if (!messageIds.has(message.id)) {
        localSession.messages.push(message);
        messageIds.add(message.id);
      }
    }
    localSession.messages.sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    if (
      validTimestamp(remoteSession.archiveUpdatedAt) >
      validTimestamp(localSession.archiveUpdatedAt)
    ) {
      localSession.archived = !!remoteSession.archived;
      localSession.archiveUpdatedAt = remoteSession.archiveUpdatedAt;
    }
    if (
      validTimestamp(remoteSession.pinUpdatedAt) >
      validTimestamp(localSession.pinUpdatedAt)
    ) {
      localSession.pinned = !!remoteSession.pinned;
      localSession.pinUpdatedAt = remoteSession.pinUpdatedAt;
    }
    if (
      validTimestamp(remoteSession.folderUpdatedAt) >
      validTimestamp(localSession.folderUpdatedAt)
    ) {
      localSession.folderId = remoteSession.folderId;
      localSession.folderUpdatedAt = remoteSession.folderUpdatedAt;
    }
    // Preserve the newer device's edit time so a later sync cannot delete it.
    localSession.lastUpdate = Math.max(
      validTimestamp(localSession.lastUpdate),
      validTimestamp(remoteSession.lastUpdate),
    );
  }

  local.sessions = local.sessions.filter((session) => {
    if (!Object.prototype.hasOwnProperty.call(tombstones, session.id))
      return true;
    if (sessionModifiedAt(session) > tombstones[session.id]) {
      delete tombstones[session.id];
      return true;
    }
    return false;
  });
  local.deletedSessions = tombstones;
  // Keep the local manual order for pins. New pins are inserted by activity
  // time without disturbing the relative order already chosen on this device.
  const byId = new Map(local.sessions.map((session) => [session.id, session]));
  const localPinSet = new Set(localPinnedIds);
  const pins = localPinnedIds
    .map((id) => byId.get(id))
    .filter(
      (session): session is NonNullable<typeof session> => !!session?.pinned,
    );
  const newPins = local.sessions
    .filter((session) => session.pinned && !localPinSet.has(session.id))
    .sort(
      (a, b) => validTimestamp(b.lastUpdate) - validTimestamp(a.lastUpdate),
    );
  for (const session of newPins) {
    const before = pins.findIndex(
      (item) =>
        validTimestamp(session.lastUpdate) > validTimestamp(item.lastUpdate),
    );
    if (before < 0) pins.push(session);
    else pins.splice(before, 0, session);
  }
  local.sessions.sort(
    (a, b) => validTimestamp(b.lastUpdate) - validTimestamp(a.lastUpdate),
  );
  let pinIndex = 0;
  local.sessions = local.sessions.map((session) =>
    session.pinned ? pins[pinIndex++] : session,
  );

  let selected = local.sessions.findIndex(
    (session) => session.id === currentId,
  );
  if (selected < 0) {
    const nearest = oldNeighbours.find((id) =>
      local.sessions.some((session) => session.id === id && !session.archived),
    );
    selected = nearest
      ? local.sessions.findIndex((session) => session.id === nearest)
      : orderedVisibleSessions(local.sessions)[0]?.index ?? -1;
    if (selected < 0) {
      local.sessions.unshift(createEmptySession());
      selected = 0;
    }
  }
  local.currentSessionIndex = selected;
  return local;
}
// we merge remote state to local state
const MergeStates: StateMerger = {
  [StoreKey.Chat]: (localState, remoteState) =>
    mergeChatStates(localState, remoteState),
  [StoreKey.Prompt]: mergePromptStates,
  [StoreKey.Mask]: mergeMaskStates,
  [StoreKey.Config]: mergeWithUpdate<AppState[StoreKey.Config]>,
  [StoreKey.Access]: mergeWithUpdate<AppState[StoreKey.Access]>,
};

export function getLocalAppState() {
  const appState = Object.fromEntries(
    Object.entries(LocalStateGetters).map(([key, getter]) => {
      return [key, getter()];
    }),
  ) as AppState;

  return appState;
}

export function setLocalAppState(appState: AppState) {
  Object.entries(LocalStateSetters).forEach(([key, setter]) => {
    setter(appState[key as keyof AppState]);
  });
  SearchService.setUserPrompts(
    Object.values(appState[StoreKey.Prompt].prompts ?? {}),
  );
}

export function mergeAppState(
  localState: AppState,
  remoteState: AppState,
  options?: { restoreDeletedSessions?: boolean; restoreDeletedItems?: boolean },
) {
  Object.keys(localState).forEach(<T extends keyof AppState>(k: string) => {
    const key = k as T;
    if (remoteState[key] === undefined) return;
    if (key === StoreKey.Chat && options?.restoreDeletedSessions) {
      mergeChatStates(
        localState[StoreKey.Chat],
        remoteState[StoreKey.Chat],
        true,
      );
      return;
    }
    if (key === StoreKey.Prompt && options?.restoreDeletedItems) {
      mergePromptStates(
        localState[StoreKey.Prompt],
        remoteState[StoreKey.Prompt],
        true,
      );
      return;
    }
    if (key === StoreKey.Mask && options?.restoreDeletedItems) {
      mergeMaskStates(
        localState[StoreKey.Mask],
        remoteState[StoreKey.Mask],
        true,
      );
      return;
    }
    const localStoreState = localState[key];
    const remoteStoreState = remoteState[key];
    localState[key] = MergeStates[key](localStoreState, remoteStoreState);
  });

  return localState;
}

/**
 * Newer state wins conflicts; ties prefer local. Preserve keys on either side.
 */
export function mergeWithUpdate<T extends { lastUpdateTime?: number }>(
  localState: T,
  remoteState: T,
) {
  const timestamp = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const remoteIsNewer =
    timestamp(remoteState.lastUpdateTime) >
    timestamp(localState.lastUpdateTime);
  const older = remoteIsNewer ? localState : remoteState;
  const newer = remoteIsNewer ? remoteState : localState;
  return merge(merge({}, older), newer) as T;
}
