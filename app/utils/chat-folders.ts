import type { ChatFolder, ChatSession } from "../store/chat";

/** Find a case-insensitively unique display name, preserving all existing names. */
export function uniqueFolderName(name: string, occupied: Set<string>) {
  let candidate = name;
  let suffix = 2;
  while (occupied.has(candidate.toLowerCase()))
    candidate = `${name} (${suffix++})`;
  return candidate;
}

export function orderedFolders(folders: ChatFolder[] = []) {
  return [...folders].sort(
    (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function effectiveFolderId(
  id: string | null | undefined,
  folders: ChatFolder[] = [],
) {
  return id && folders.some((folder) => folder.id === id) ? id : undefined;
}

export function sessionFolder(
  session: ChatSession,
  folders: ChatFolder[] = [],
) {
  return folders.find((folder) => folder.id === session.folderId);
}

export function visibleFolderId(
  folders: ChatFolder[],
  selection: {
    selectedFolderId: string | null;
    narrow: boolean;
  },
) {
  return selection.narrow
    ? undefined
    : effectiveFolderId(selection.selectedFolderId, folders);
}
