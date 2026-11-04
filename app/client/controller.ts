const listeners = new Set<() => void>();
let revision = 0;

function notify() {
  revision += 1;
  for (const listener of listeners) listener();
}

// A conversation can have multiple simultaneous responses.
export const ChatControllerPool = {
  controllers: new Map<string, Map<string, AbortController>>(),

  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getSnapshot() {
    return revision;
  },

  addController(
    sessionId: string,
    messageId: string,
    controller: AbortController,
  ) {
    let session = this.controllers.get(sessionId);
    if (!session) {
      session = new Map();
      this.controllers.set(sessionId, session);
    }
    session.set(messageId, controller);
    notify();
  },

  stop(sessionId: string, messageId: string) {
    this.controllers.get(sessionId)?.get(messageId)?.abort();
  },

  stopSession(sessionId: string) {
    for (const controller of this.controllers.get(sessionId)?.values() ?? []) {
      controller.abort();
    }
  },

  hasPending(sessionId: string) {
    return (this.controllers.get(sessionId)?.size ?? 0) > 0;
  },

  remove(sessionId: string, messageId: string) {
    const session = this.controllers.get(sessionId);
    if (!session?.delete(messageId)) return;
    if (session.size === 0) this.controllers.delete(sessionId);
    notify();
  },
};
