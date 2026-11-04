import { ChatControllerPool } from "../app/client/controller";

afterEach(() => {
  for (const [sessionId, controllers] of ChatControllerPool.controllers) {
    for (const messageId of controllers.keys()) {
      ChatControllerPool.remove(sessionId, messageId);
    }
  }
});

test("stopping a conversation aborts all its responses and leaves other conversations running", () => {
  const first = new AbortController();
  const second = new AbortController();
  const other = new AbortController();
  ChatControllerPool.addController("chat", "1", first);
  ChatControllerPool.addController("chat", "2", second);
  ChatControllerPool.addController("chat-extra", "1", other);

  ChatControllerPool.stopSession("chat");

  expect(first.signal.aborted).toBe(true);
  expect(second.signal.aborted).toBe(true);
  expect(other.signal.aborted).toBe(false);
  expect(ChatControllerPool.hasPending("chat-extra")).toBe(true);
  ChatControllerPool.remove("chat", "1");
  expect(ChatControllerPool.hasPending("chat")).toBe(true);
  ChatControllerPool.remove("chat", "2");
  expect(ChatControllerPool.hasPending("chat")).toBe(false);
});

test("stopping one message and pool notifications remain scoped", () => {
  const first = new AbortController();
  const second = new AbortController();
  let changes = 0;
  const unsubscribe = ChatControllerPool.subscribe(() => changes++);
  ChatControllerPool.addController("a", "first", first);
  ChatControllerPool.addController("a", "second", second);
  ChatControllerPool.stop("a", "first");
  expect(first.signal.aborted).toBe(true);
  expect(second.signal.aborted).toBe(false);
  ChatControllerPool.remove("a", "first");
  ChatControllerPool.remove("a", "second");
  expect(changes).toBe(4);
  unsubscribe();
});
