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
