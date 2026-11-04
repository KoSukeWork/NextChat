/** @jest-environment node */
import { jest } from "@jest/globals";
import { fetch as nativeFetch } from "../app/utils/stream";

test("native streaming listens before starting a fast request and keeps error bodies", async () => {
  let register!: () => void;
  let handler!: (event: any) => void;
  const unlisten = jest.fn();
  const ready = new Promise<void>((resolve) => {
    register = resolve;
  });
  const invoke = jest.fn(async () => {
    handler({
      payload: {
        request_id: 4,
        chunk: [...new TextEncoder().encode("error ")],
      },
    });
    setTimeout(() => {
      handler({
        payload: {
          request_id: 4,
          chunk: [...new TextEncoder().encode("details")],
        },
      });
      handler({ payload: { request_id: 4, status: 0 } });
    }, 150);
    return {
      request_id: 4,
      status: 401,
      status_text: "Unauthorized",
      headers: {},
    };
  });
  Object.assign(globalThis, {
    window: {
      __TAURI__: {
        invoke,
        event: {
          listen: async (_name: string, callback: typeof handler) => {
            handler = callback;
            await ready;
            return unlisten;
          },
        },
      },
    },
    navigator: { userAgent: "test" },
  });
  try {
    const responsePromise = nativeFetch("https://example.test", {
      method: "POST",
      body: "{}",
    });
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
    register();
    const response = await responsePromise;
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("error details");
    expect(unlisten).toHaveBeenCalledTimes(1);
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("aborting a native request waiting for headers cancels that request promptly", async () => {
  const unlisten = jest.fn();
  const invoke = jest.fn((command: string, _args?: Record<string, unknown>) =>
    command === "stream_cancel" ? Promise.resolve() : new Promise(() => {}),
  );
  Object.assign(globalThis, {
    window: { __TAURI__: { invoke, event: { listen: async () => unlisten } } },
    navigator: { userAgent: "test" },
  });
  try {
    const controller = new AbortController();
    const pending = nativeFetch("https://example.test", {
      method: "POST",
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    const fetchCall = invoke.mock.calls.find(
      ([command]) => command === "stream_fetch",
    );
    expect(fetchCall).toBeDefined();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("stream_cancel", {
      cancelId: (fetchCall![1] as any).cancelId,
    });
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("aborting a native response closes its stream and cancels the matching request", async () => {
  const invoke = jest.fn((command: string, _args?: Record<string, unknown>) =>
    command === "stream_fetch"
      ? Promise.resolve({
          request_id: 7,
          status: 200,
          status_text: "OK",
          headers: {},
        })
      : Promise.resolve(),
  );
  Object.assign(globalThis, {
    window: { __TAURI__: { invoke, event: { listen: async () => () => {} } } },
    navigator: { userAgent: "test" },
  });
  try {
    const controller = new AbortController();
    const response = await nativeFetch("https://example.test", {
      method: "POST",
      signal: controller.signal,
    });
    const pendingRead = response.body!.getReader().read();
    const fetchCall = invoke.mock.calls.find(
      ([command]) => command === "stream_fetch",
    )!;
    controller.abort();
    await expect(pendingRead).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).toHaveBeenCalledWith("stream_cancel", {
      cancelId: (fetchCall[1] as any).cancelId,
    });
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "navigator");
  }
});
