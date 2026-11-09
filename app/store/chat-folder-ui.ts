import { create } from "zustand";
import { safeLocalStorage } from "../utils";

const storage = safeLocalStorage();
const SELECTION_KEY = "nextchat-selected-folder";

// This view state is deliberately outside the synced/backup chat store.
export const useChatFolderUI = create<{
  selectedFolderId: string | null;
  selectionVersion: number;
  narrow: boolean;
  selectFolder: (id: string | null) => void;
  setNarrow: (narrow: boolean) => void;
}>((set) => ({
  selectedFolderId: storage.getItem(SELECTION_KEY),
  selectionVersion: 0,
  narrow: false,
  selectFolder: (id) => {
    if (id) storage.setItem(SELECTION_KEY, id);
    else storage.removeItem(SELECTION_KEY);
    set((state) => ({
      selectedFolderId: id,
      selectionVersion: state.selectionVersion + 1,
    }));
  },
  setNarrow: (narrow) => set({ narrow }),
}));
