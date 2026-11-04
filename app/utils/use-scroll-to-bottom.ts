import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ChatMessage } from "../store/chat";
export function useScrollToBottom(
  scrollRef: RefObject<HTMLDivElement>,
  detach: boolean = false,
  messages: ChatMessage[],
  suspended: boolean = false,
) {
  // for auto-scroll
  const [autoScroll, setAutoScroll] = useState(true);
  const generation = useRef(0);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const cancelPendingScroll = useCallback(() => {
    generation.current += 1;
  }, []);
  // An animation frame queued earlier must not undo a jump to an older message.
  const followsBottom = useRef(false);
  followsBottom.current = autoScroll && !suspended;
  const scrollDomToBottom = useCallback(() => {
    const dom = scrollRef.current;
    if (dom && !suspendedRef.current) {
      const requestGeneration = generation.current;
      requestAnimationFrame(() => {
        if (requestGeneration !== generation.current || suspendedRef.current)
          return;
        setAutoScroll(true);
        dom.scrollTo(0, dom.scrollHeight);
      });
    }
  }, [scrollRef]);

  // auto scroll
  useEffect(() => {
    if (autoScroll && !detach && !suspended) {
      const dom = scrollRef.current;
      requestAnimationFrame(() => {
        if (followsBottom.current) dom?.scrollTo(0, dom.scrollHeight);
      });
    }
  });

  // auto scroll when messages length changes
  const lastMessagesLength = useRef(messages.length);
  useEffect(() => {
    if (messages.length > lastMessagesLength.current && !detach && !suspended) {
      scrollDomToBottom();
    }
    lastMessagesLength.current = messages.length;
  }, [messages.length, detach, suspended, scrollDomToBottom]);

  return {
    scrollRef,
    autoScroll,
    setAutoScroll,
    scrollDomToBottom,
    cancelPendingScroll,
  };
}
