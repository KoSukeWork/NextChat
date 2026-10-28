import { jest } from "@jest/globals";
import {
  nextZoom,
  normalizeZoom,
  registerZoomShortcuts,
  ZOOM_LEVELS,
  ZOOM_WHEEL_INTERVAL,
} from "../app/utils/zoom";

test("zoom steps match browser levels in both directions", () => {
  for (let i = 0; i < ZOOM_LEVELS.length; i++) {
    expect(nextZoom(ZOOM_LEVELS[i], 1)).toBe(
      ZOOM_LEVELS[Math.min(i + 1, ZOOM_LEVELS.length - 1)],
    );
    expect(nextZoom(ZOOM_LEVELS[i], -1)).toBe(ZOOM_LEVELS[Math.max(i - 1, 0)]);
  }
});

test.each([
  [1.15, 1.25, 1.1],
  [0.68, 0.75, 0.67],
  [1.99, 2, 1.75],
  [0.5, 0.67, 0.5],
  [2, 2, 1.75],
])(
  "value %s selects the nearest level in the requested direction",
  (value, up, down) => {
    expect(nextZoom(value, 1)).toBe(up);
    expect(nextZoom(value, -1)).toBe(down);
  },
);

test("invalid persisted values normalize and native bounds are respected", () => {
  expect(normalizeZoom(NaN)).toBe(1);
  expect(normalizeZoom(Infinity)).toBe(1);
  expect(normalizeZoom(-1)).toBe(0.5);
  expect(normalizeZoom(8)).toBe(2);
  expect(nextZoom(-1, -1)).toBe(0.5);
  expect(nextZoom(8, 1)).toBe(2);
});

test("Ctrl shortcuts work in inputs including shifted plus and numpad keys, and unregister cleanly", () => {
  let zoom = 1;
  const changes = jest.fn((factor: number) => {
    zoom = factor;
  });
  const dispose = registerZoomShortcuts({
    isMac: false,
    getZoom: () => zoom,
    onZoom: changes,
  });
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  const key = (key: string, code = "", extra = {}) => {
    const event = new KeyboardEvent("keydown", {
      key,
      code,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    expect(key("=")).toBe(true);
    expect(zoom).toBe(1.1);
    expect(key("+", "Equal", { shiftKey: true })).toBe(true);
    expect(zoom).toBe(1.25);
    key("+", "NumpadAdd");
    expect(zoom).toBe(1.5);
    key("-", "NumpadSubtract");
    expect(zoom).toBe(1.25);
    key("-");
    expect(zoom).toBe(1.1);
    key("0", "Numpad0");
    expect(zoom).toBe(1);
    key("=");
    key("0");
    expect(zoom).toBe(1);
    expect(key("Enter")).toBe(false);
    expect(key("=", "", { altKey: true })).toBe(false);
    expect(key("=", "", { isComposing: true })).toBe(false);
    expect(key("=", "", { ctrlKey: false })).toBe(false);
    dispose();
    expect(key("=")).toBe(false);
  } finally {
    dispose();
    input.remove();
  }
});

test("macOS keyboard shortcuts require Cmd", () => {
  const onZoom = jest.fn();
  const dispose = registerZoomShortcuts({
    isMac: true,
    getZoom: () => 1,
    onZoom,
  });
  try {
    const control = new KeyboardEvent("keydown", {
      key: "=",
      ctrlKey: true,
      cancelable: true,
    });
    window.dispatchEvent(control);
    expect(control.defaultPrevented).toBe(false);
    const command = new KeyboardEvent("keydown", {
      key: "=",
      metaKey: true,
      cancelable: true,
    });
    window.dispatchEvent(command);
    expect(command.defaultPrevented).toBe(true);
    expect(onZoom).toHaveBeenCalledWith(1.1);
  } finally {
    dispose();
  }
});

test("Ctrl+wheel/pinch is throttled but every matching event prevents native default", () => {
  jest.useFakeTimers();
  let zoom = 1;
  const onZoom = jest.fn((factor: number) => {
    zoom = factor;
  });
  const dispose = registerZoomShortcuts({
    isMac: false,
    getZoom: () => zoom,
    onZoom,
  });
  const wheel = (deltaY: number, ctrlKey = true) => {
    const event = new WheelEvent("wheel", {
      deltaY,
      ctrlKey,
      cancelable: true,
    });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    expect(wheel(-1, false)).toBe(false);
    expect(wheel(-1)).toBe(true);
    expect(zoom).toBe(1.1);
    jest.advanceTimersByTime(10);
    expect(wheel(-1)).toBe(true);
    expect(onZoom).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(ZOOM_WHEEL_INTERVAL);
    wheel(1);
    expect(zoom).toBe(1);
    dispose();
    expect(wheel(-1)).toBe(false);
  } finally {
    dispose();
    jest.useRealTimers();
  }
});
