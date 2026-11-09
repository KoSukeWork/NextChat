import type { ChatSession } from "../store/chat";
import { validTimestamp } from "./chat-deletion";

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
  unpinned.sort(
    (a, b) =>
      validTimestamp(b.session.lastUpdate) -
        validTimestamp(a.session.lastUpdate) || a.index - b.index,
  );
  return pinned.concat(unpinned);
}

// Prefer following rows, then preceding rows, in the same view the user saw.
// If the current folder has no surviving neighbour, fall back to the full list.
export function orderedNeighbourIds(
  sessions: ChatSession[],
  index: number,
  folderId?: string,
) {
  const ordered = orderedVisibleSessions(sessions, index);
  const neighbours = (rows: typeof ordered) => {
    const position = rows.findIndex((row) => row.index === index);
    if (position < 0) return [];
    return [...rows.slice(position + 1), ...rows.slice(0, position).reverse()]
      .filter(({ session }) => !session.archived)
      .map(({ session }) => session.id);
  };
  const inFolder =
    folderId && sessions[index]?.folderId === folderId
      ? neighbours(
          ordered.filter(({ session }) => session.folderId === folderId),
        )
      : [];
  const inFolderSet = new Set(inFolder);
  return [
    ...inFolder,
    ...neighbours(ordered).filter((id) => !inFolderSet.has(id)),
  ];
}
