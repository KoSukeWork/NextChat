import { jest } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react";
import "../app/client/api";
import { useAppConfig, DEFAULT_CONFIG } from "../app/store/config";
import { useDesktopZoom, useZoomSupport } from "../app/utils/use-desktop-zoom";

let meta: HTMLMetaElement;
let invoke: ReturnType<
  typeof jest.fn<
    (command: string, args?: Record<string, unknown>) => Promise<boolean>
  >
>;
beforeEach(() => {
  meta = document.createElement("meta");
  meta.name = "config";
  meta.content = JSON.stringify({ isApp: true });
  document.head.append(meta);
  useAppConfig.setState({ zoom: 1.25 });
  useZoomSupport.setState({ supported: false });
  invoke = jest.fn(async () => true);
  window.__TAURI__ = { invoke } as unknown as NonNullable<Window["__TAURI__"]>;
});
afterEach(() => {
  meta.remove();
  delete window.__TAURI__;
});

test("old persisted configs receive 100% zoom and saved zoom survives hydration", () => {
  const merge = useAppConfig.persist.getOptions().merge!;
  const current = { ...useAppConfig.getState(), ...DEFAULT_CONFIG };
  expect(merge({ fontSize: 18 }, current)).toMatchObject({
    fontSize: 18,
    zoom: 1,
  });
  expect(merge({ zoom: 1.5 }, current).zoom).toBe(1.5);
  expect(merge({ zoom: 99 }, current).zoom).toBe(2);
});

test("mount restores saved zoom and subsequent setting changes apply natively", async () => {
  const { unmount } = renderHook(() => useDesktopZoom());
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_zoom", { factor: 1.25 }),
  );
  await waitFor(() => expect(useZoomSupport.getState().supported).toBe(true));
  act(() => useAppConfig.setState({ zoom: 1.5 }));
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("set_zoom", { factor: 1.5 }),
  );
  unmount();
  expect(useZoomSupport.getState().supported).toBe(false);
});

test("unsupported native platform never intercepts browser keys or wheel", async () => {
  invoke.mockResolvedValue(false);
  const { unmount } = renderHook(() => useDesktopZoom());
  await act(async () => {
    await Promise.resolve();
  });
  expect(invoke).toHaveBeenCalled();
  expect(useZoomSupport.getState().supported).toBe(false);
  const key = new KeyboardEvent("keydown", {
    key: "=",
    ctrlKey: true,
    cancelable: true,
  });
  const wheel = new WheelEvent("wheel", {
    deltaY: -1,
    ctrlKey: true,
    cancelable: true,
  });
  window.dispatchEvent(key);
  window.dispatchEvent(wheel);
  expect(key.defaultPrevented).toBe(false);
  expect(wheel.defaultPrevented).toBe(false);
  expect(useAppConfig.getState().zoom).toBe(1.25);
  unmount();
});

test("Web mode never invokes native zoom even with an injected Tauri global", async () => {
  meta.content = JSON.stringify({ isApp: false });
  const { unmount } = renderHook(() => useDesktopZoom());
  await act(async () => {
    await Promise.resolve();
  });
  expect(invoke).not.toHaveBeenCalled();
  expect(useZoomSupport.getState().supported).toBe(false);
  unmount();
});
