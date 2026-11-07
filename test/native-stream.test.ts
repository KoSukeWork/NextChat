/** @jest-environment node */
import { jest } from "@jest/globals";
import { fetch as nativeFetch, getNativeNetworkError, isNativeRequestNotSent, NativeStreamError } from "../app/utils/stream";
import { nativeMcpFetch } from "../app/mcp/remote";
import { buildEndpointRequest } from "../app/client/endpoint-protocol";
import type { EndpointProtocol } from "../app/utils/endpoints";

test("only native IPC, not HTTP 599 or headers, identifies a refused connection", async () => {
  let count = 0;
  const invoke = jest.fn(async (command: string) => {
    if (command !== "stream_fetch") return;
    count++;
    return {
      request_id: count,
      status: 599,
      status_text: "Error",
      headers: { network_error: "NETWORK_REFUSED", request_not_sent: "true" },
      ...(count === 1 ? { network_error: "NETWORK_REFUSED", request_not_sent: true } : {}),
    };
  });
  Object.assign(globalThis, {
    window: { __TAURI__: { invoke, event: { listen: async () => () => {} } } },
    navigator: { userAgent: "test" },
  });
  try {
    const native = await nativeFetch("https://example.test/mcp");
    const forged = await nativeFetch("https://example.test/mcp");
    expect(getNativeNetworkError(native)).toBe("NETWORK_REFUSED");
    expect(isNativeRequestNotSent(native)).toBe(true);
    expect(getNativeNetworkError(forged)).toBeUndefined();
    expect(isNativeRequestNotSent(forged)).toBe(false);
    await native.body?.cancel();
    await forged.body?.cancel();
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "navigator");
  }
});

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

test.each(["url", "request"])("a failed MCP native response body raises a connection error for %s input", async (inputType) => {
  let handler!: (event: any) => void;
  const invoke = jest.fn(async () => ({ request_id: 11, status: 200, status_text: "OK", headers: {} }));
  Object.assign(globalThis, {
    window: { __TAURI__: { invoke, event: { listen: async (_name: string, callback: typeof handler) => { handler = callback; return () => {}; } } } },
    navigator: { userAgent: "test" },
  });
  try {
    const input = inputType === "request"
      ? new Request("https://example.test/mcp", { method: "POST", body: "{}" })
      : "https://example.test/mcp";
    // The SDK type only exposes URL inputs; the adapter also accepts Request at runtime.
    const fetchMcp = nativeMcpFetch as (input: string | Request) => Promise<Response>;
    const response = await fetchMcp(input);
    const reading = response.text();
    handler({ payload: { request_id: 11, status: 1 } });
    await expect(reading).rejects.toBeInstanceOf(NativeStreamError);
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("a failed native response body closes normally for ordinary fetch callers", async () => {
  let handler!: (event: any) => void;
  const unlisten = jest.fn();
  const invoke = jest.fn(async () => ({ request_id: 12, status: 200, status_text: "OK", headers: {} }));
  Object.assign(globalThis, {
    window: { __TAURI__: { invoke, event: { listen: async (_name: string, callback: typeof handler) => { handler = callback; return unlisten; } } } },
    navigator: { userAgent: "test" },
  });
  try {
    const response = await nativeFetch("https://example.test/events");
    const reading = response.text();
    handler({ payload: { request_id: 12, chunk: [...new TextEncoder().encode("completed event")] } });
    handler({ payload: { request_id: 12, status: 1 } });
    await expect(reading).resolves.toBe("completed event");
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

test("native DELETE supports empty 204 responses and preserves session headers", async () => {
  const invoke = jest.fn(
    async (_command: string, _args?: Record<string, unknown>) => ({
      request_id: 8,
      status: 204,
      status_text: "No Content",
      headers: { "mcp-session-id": "session-1" },
    }),
  );
  Object.assign(globalThis, {
    window: { __TAURI__: { invoke, event: { listen: async () => () => {} } } },
    navigator: { userAgent: "test" },
  });
  try {
    const response = await nativeFetch("https://example.test/mcp", {
      method: "DELETE",
      redirect: "manual",
    });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(response.headers.get("mcp-session-id")).toBe("session-1");
    expect(invoke.mock.calls[0][1]).toEqual(
      expect.objectContaining({ method: "DELETE", redirect: "manual" }),
    );
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("native requests preserve caller Accept headers without case-duplicate defaults", async () => {
  const invoke = jest.fn(
    async (_command: string, _args?: Record<string, unknown>) => ({
      request_id: 10,
      status: 204,
      status_text: "No Content",
      headers: {},
    }),
  );
  Object.assign(globalThis, {
    window: { __TAURI__: { invoke, event: { listen: async () => () => {} } } },
    navigator: { userAgent: "test" },
  });
  try {
    await nativeFetch("https://example.test/mcp", {
      method: "POST",
      headers: new Headers({ Accept: "application/json, text/event-stream" }),
      body: "{}",
    });
    const headers = (invoke.mock.calls[0][1] as any).headers as Record<
      string,
      string
    >;
    expect(
      Object.keys(headers).filter((name) => name.toLowerCase() === "accept"),
    ).toEqual(["accept"]);
    expect(headers.accept).toBe("application/json, text/event-stream");
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "navigator");
  }
});

test.each([
  ["openai-chat", "authorization", "Bearer test-key"],
  ["openai-responses", "authorization", "Bearer test-key"],
  ["anthropic", "x-api-key", "test-key"],
  ["gemini", "x-goog-api-key", "test-key"],
] as const)(
  "%s chat request retains its protocol headers over native IPC",
  async (protocol: EndpointProtocol, authHeader, authValue) => {
    const invoke = jest.fn(
      async (_command: string, _args?: Record<string, unknown>) => ({
        request_id: 11,
        status: 204,
        status_text: "No Content",
        headers: {},
      }),
    );
    Object.assign(globalThis, {
      window: {
        __TAURI__: { invoke, event: { listen: async () => () => {} } },
      },
      navigator: { userAgent: "test" },
    });
    try {
      const request = buildEndpointRequest(
        {
          id: "test",
          name: "test",
          protocol,
          baseUrl: "https://example.test",
          apiKey: "test-key",
          models: [],
        },
        {
          model: "model",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
      );
      await nativeFetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
      });
      const headers = (invoke.mock.calls[0][1] as any).headers as Record<
        string,
        string
      >;
      const names = Object.keys(headers).map((name) => name.toLowerCase());
      expect(new Set(names).size).toBe(names.length);
      expect(headers).toMatchObject(request.headers);
      expect(headers.accept).toBe("application/json, text/event-stream");
      expect(headers[authHeader]).toBe(authValue);
      if (protocol === "anthropic")
        expect(headers["anthropic-version"]).toBe("2023-06-01");
    } finally {
      Reflect.deleteProperty(globalThis, "window");
      Reflect.deleteProperty(globalThis, "navigator");
    }
  },
);

test("cancelling a native response reader stops the matching long-lived request", async () => {
  const unlisten = jest.fn();
  const invoke = jest.fn((command: string, _args?: Record<string, unknown>) =>
    command === "stream_fetch"
      ? Promise.resolve({
          request_id: 9,
          status: 200,
          status_text: "OK",
          headers: { "content-type": "text/event-stream" },
        })
      : Promise.resolve(),
  );
  Object.assign(globalThis, {
    window: { __TAURI__: { invoke, event: { listen: async () => unlisten } } },
    navigator: { userAgent: "test" },
  });
  try {
    const response = await nativeFetch("https://example.test/events");
    const fetchCall = invoke.mock.calls.find(
      ([command]) => command === "stream_fetch",
    )!;
    await response.body!.cancel();
    expect(invoke).toHaveBeenCalledWith("stream_cancel", {
      cancelId: (fetchCall[1] as any).cancelId,
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "navigator");
  }
});
