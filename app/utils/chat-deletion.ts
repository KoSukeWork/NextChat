import type { ChatSession } from "../store/chat";

export function validTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function sessionModifiedAt(session: ChatSession): number {
  return Math.max(
    validTimestamp(session.lastUpdate),
    validTimestamp(session.archiveUpdatedAt),
    validTimestamp(session.pinUpdatedAt),
    validTimestamp(session.folderUpdatedAt),
  );
}

export function sessionIsSyncable(session: ChatSession): boolean {
  return session.messages.length > 0;
}

export function deletionTimestamp(session: ChatSession, previous?: number) {
  return Math.max(
    Date.now(),
    sessionModifiedAt(session) + 1,
    validTimestamp(previous) + 1,
  );
}

// The update must beat a known tombstone even if another clock was ahead.
export function restoredTimestamp(session: ChatSession, deletedAt?: number) {
  return Math.max(
    Date.now(),
    sessionModifiedAt(session) + 1,
    validTimestamp(deletedAt) + 1,
  );
}
