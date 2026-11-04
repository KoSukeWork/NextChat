import { act, renderHook } from "@testing-library/react";
import { jest } from "@jest/globals";
import { createRef } from "react";
import { useScrollToBottom } from "../app/utils/use-scroll-to-bottom";

test("a queued focus scroll cannot override a search jump", () => {
  const frames: FrameRequestCallback[] = [];
  const request = jest
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((fn) => {
      frames.push(fn);
      return frames.length;
    });
  const dom = document.createElement("div");
  dom.scrollTo = jest.fn();
  const ref = createRef<HTMLDivElement>();
  Object.assign(ref, { current: dom });
  const messages: any[] = [];
  const { result, rerender } = renderHook(
    ({ suspended }) => useScrollToBottom(ref, false, messages, suspended),
    { initialProps: { suspended: false } },
  );
  // A textarea focus requests a scroll before navigation consumes the jump.
  act(() => result.current.scrollDomToBottom());
  act(() => result.current.cancelPendingScroll());
  rerender({ suspended: true });
  rerender({ suspended: false });
  // Drop the hook's regular follow-bottom callback; exercise the older focus frame.
  const focusFrame = frames[1];
  act(() => focusFrame(0));
  expect(dom.scrollTo).not.toHaveBeenCalled();
  act(() => result.current.scrollDomToBottom());
  act(() => frames.at(-1)!(0));
  expect(dom.scrollTo).toHaveBeenCalledTimes(1);
  request.mockRestore();
});

test("a focus scroll is not queued while a jump is pending", () => {
  const request = jest
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation(() => 1);
  const dom = document.createElement("div");
  const ref = createRef<HTMLDivElement>();
  Object.assign(ref, { current: dom });
  const { result } = renderHook(() => useScrollToBottom(ref, false, [], true));
  const before = request.mock.calls.length;
  act(() => result.current.scrollDomToBottom());
  expect(request).toHaveBeenCalledTimes(before);
  request.mockRestore();
});
