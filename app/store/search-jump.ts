import { create } from "zustand";

export type SearchJump = { sessionId: string; messageId: string };

// A one-shot request, intentionally kept out of browser history and storage.
export const useSearchJump = create<{
  request: SearchJump | null;
  setRequest: (request: SearchJump | null) => void;
  consume: (request: SearchJump) => void;
}>((set) => ({
  request: null,
  setRequest: (request) => set({ request }),
  consume: (request) =>
    set((state) => (state.request === request ? { request: null } : {})),
}));
