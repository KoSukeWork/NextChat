import type { ChatSession } from "../store/chat";

// Keep the stored order intact; pinning only changes how visible chats are
// presented. The optional index places an open archived chat among its peers
// so navigation can find its neighbours.
export function orderedVisibleSessions(
  sessions: ChatSession[],
  includeArchivedIndex?: number,
) {
  const pinned: { session: ChatSession; index: number }[] = [];
  const unpinned: typeof pinned = [];
  sessions.forEach((session, index) => {
    if (session.archived && index !== includeArchivedIndex) return;
    (session.pinned ? pinned : unpinned).push({ session, index });
  });
  return pinned.concat(unpinned);
}
