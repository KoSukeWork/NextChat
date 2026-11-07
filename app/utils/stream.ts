// using tauri command to send request
// see src-tauri/src/stream.rs, and src-tauri/src/main.rs
// 1. invoke('stream_fetch', {url, method, headers, body}), get response with headers.
// 2. listen event: `stream-response` multi times to get body

type ResponseEvent = {
  id: number;
  payload: {
    request_id: number;
    status?: number;
    chunk?: number[];
  };
};

type StreamResponse = {
  request_id: number;
  status: number;
  status_text: string;
  headers: Record<string, string>;
  network_error?: string | null;
  request_not_sent?: boolean | null;
};

/** The native HTTP response ended because its body stream failed. */
export class NativeStreamError extends Error {
  constructor() {
    super("Native HTTP response stream disconnected");
    this.name = "NativeStreamError";
  }
}

// The reason comes from native IPC, not from an untrusted HTTP response.
const nativeNetworkErrors = new WeakMap<
  Response,
  { reason: string; requestNotSent: boolean }
>();
export function getNativeNetworkError(response: Response) {
  return nativeNetworkErrors.get(response)?.reason;
}
export function isNativeRequestNotSent(response: Response) {
  return nativeNetworkErrors.get(response)?.requestNotSent === true;
}

let nextCancelId = 0;
const abortError = () =>
  new DOMException("The request was aborted", "AbortError");

export function fetch(
  url: string,
  options?: RequestInit,
  nativeOptions?: { failOnBodyError?: boolean },
): Promise<Response> {
  if (window.__TAURI__) {
    const {
      signal,
      method = "GET",
      headers: _headers = {},
      body = [],
    } = options || {};
    if (signal?.aborted) return Promise.reject(abortError());
    const cancelId =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random()}-${nextCancelId++}`;
    let unlisten: Function | undefined;
    let setRequestId: Function | undefined;
    let started = false;
    let rejectAbort: (error: Error) => void = () => {};
    const requestIdPromise = new Promise((resolve) => (setRequestId = resolve));
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const bodyStream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        cancelNative();
        close(undefined, true);
      },
    });

    let closed = false;
    const close = (error?: Error, cancelled = false) => {
      if (closed) return;
      closed = true;
      unlisten && unlisten();
      signal?.removeEventListener("abort", onAbort);
      if (!cancelled) {
        if (error) controller.error(error);
        else controller.close();
      }
    };

    const cancelNative = () => {
      if (started) {
        void window
          .__TAURI__!.invoke("stream_cancel", { cancelId })
          .catch(() => {});
      }
    };
    const onAbort = () => {
      const error = abortError();
      cancelNative();
      close(error);
      rejectAbort(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Register before invoking: fast responses can emit their first chunk
    // before the native command returns its request id.
    const listening = window.__TAURI__.event
      .listen("stream-response", (e: ResponseEvent) =>
        requestIdPromise.then((request_id) => {
          const { request_id: rid, chunk, status } = e?.payload || {};
          if (request_id != rid) {
            return;
          }
          if (chunk) {
            if (!closed) controller.enqueue(new Uint8Array(chunk));
          } else if (status === 0) {
            // end of body
            close();
          } else if (status === 1) {
            close(
              nativeOptions?.failOnBodyError
                ? new NativeStreamError()
                : undefined,
            );
          }
        }),
      )
      .then((u: Function) => {
        unlisten = u;
        if (closed) u();
      });

    const normalizedHeaders = new Headers({
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
      "User-Agent": navigator.userAgent,
    });
    new Headers(_headers || {}).forEach((value, name) => {
      normalizedHeaders.set(name, value);
    });
    // HTTP header names are case-insensitive. Normalize before crossing IPC so
    // Rust's map cannot pick a default value over the caller's differently cased key.
    const headers = Object.fromEntries(normalizedHeaders.entries());
    const response = listening
      .then(() => {
        if (signal?.aborted) throw abortError();
        started = true;
        return window.__TAURI__!.invoke("stream_fetch", {
          method: method.toUpperCase(),
          url,
          headers,
          cancelId,
          redirect: options?.redirect ?? "follow",
          // TODO FormData
          body:
            typeof body === "string"
              ? Array.from(new TextEncoder().encode(body))
              : [],
        });
      })
      .then((res: StreamResponse) => {
        const { request_id, status, status_text: statusText, headers } = res;
        setRequestId?.(request_id);
        const noBody =
          method.toUpperCase() === "HEAD" || [204, 205, 304].includes(status);
        if (noBody) close();
        const response = new Response(noBody ? null : bodyStream, {
          status,
          statusText,
          headers,
        });
        if (res.network_error)
          nativeNetworkErrors.set(response, {
            reason: res.network_error,
            requestNotSent: res.request_not_sent === true,
          });
        return response;
      })
      .catch((e) => {
        if (signal?.aborted) throw abortError();
        close();
        return new Response("Network request failed", { status: 599 });
      });
    return signal ? Promise.race([response, aborted]) : response;
  }
  return window.fetch(url, options);
}
