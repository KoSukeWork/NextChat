import {
  createEmptySession,
  useAccessStore,
  useAppConfig,
  useChatStore,
} from "../store";
import { useMaskStore } from "../store/mask";
import { usePromptStore } from "../store/prompt";
import { StoreKey } from "../constant";
import { merge } from "./merge";
import {
  restoredTimestamp,
  sessionModifiedAt,
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
  [k in keyof typeof LocalStateGetters]: ReturnType<
    (typeof LocalStateGetters)[k]
  >;
};

const CloudStoreKeys = [StoreKey.Chat, StoreKey.Mask, StoreKey.Prompt] as const;
export type CloudState = Pick<AppState, (typeof CloudStoreKeys)[number]>;

export function getCloudAppState(): CloudState {
  return Object.fromEntries(
    CloudStoreKeys.map((key) => [key, LocalStateGetters[key]()]),
  ) as CloudState;
}

export function setCloudAppState(state: CloudState) {
  CloudStoreKeys.forEach(<K extends keyof CloudState>(key: K) => {
    LocalStateSetters[key](state[key]);
  });
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

function mergeChatStates(
  local: ChatState,
  remote: ChatState,
  restoreImport = false,
): ChatState {
  const oldOrder = local.sessions.map((session) => session.id);
  const oldIndex = local.currentSessionIndex;
  const currentId = local.sessions[oldIndex]?.id;
  const tombstones = mergeTombstones(
    local.deletedSessions,
    remote.deletedSessions,
  );
  const sessionsById = new Map(
    local.sessions.map((session) => [session.id, session]),
  );

  for (const incoming of remote.sessions) {
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
      if (
        remoteSession.messages.length === 0 &&
        !(restoreImport && hasTombstone)
      )
        continue;
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
  local.sessions.sort(
    (a, b) => validTimestamp(b.lastUpdate) - validTimestamp(a.lastUpdate),
  );

  let selected = local.sessions.findIndex(
    (session) => session.id === currentId,
  );
  if (selected < 0) {
    const neighbours =
      oldIndex >= 0
        ? [
            ...oldOrder.slice(oldIndex + 1),
            ...oldOrder.slice(0, oldIndex).reverse(),
          ]
        : [];
    const nearest = neighbours.find((id) =>
      local.sessions.some((session) => session.id === id && !session.archived),
    );
    selected = nearest
      ? local.sessions.findIndex((session) => session.id === nearest)
      : local.sessions.findIndex((session) => !session.archived);
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
  [StoreKey.Prompt]: (localState, remoteState) => {
    localState.prompts = {
      ...remoteState.prompts,
      ...localState.prompts,
    };
    return localState;
  },
  [StoreKey.Mask]: (localState, remoteState) => {
    localState.masks = {
      ...remoteState.masks,
      ...localState.masks,
    };
    return localState;
  },
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
}

export function mergeAppState(
  localState: AppState,
  remoteState: AppState,
  options?: { restoreDeletedSessions?: boolean },
) {
  Object.keys(localState).forEach(<T extends keyof AppState>(k: string) => {
    const key = k as T;
    if (key === StoreKey.Chat && options?.restoreDeletedSessions) {
      mergeChatStates(
        localState[StoreKey.Chat],
        remoteState[StoreKey.Chat],
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
