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
};

let nextCancelId = 0;
const abortError = () =>
  new DOMException("The request was aborted", "AbortError");

export function fetch(url: string, options?: RequestInit): Promise<Response> {
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
    const ts = new TransformStream();
    const writer = ts.writable.getWriter();

    let closed = false;
    const close = (error?: Error) => {
      if (closed) return;
      closed = true;
      unlisten && unlisten();
      signal?.removeEventListener("abort", onAbort);
      if (error) writer.abort(error).catch(() => {});
      else writer.ready.then(() => writer.close()).catch(() => {});
    };

    const onAbort = () => {
      const error = abortError();
      close(error);
      if (started) {
        void window
          .__TAURI__!.invoke("stream_cancel", { cancelId })
          .catch(() => {});
      }
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
            writer.ready
              .then(() => writer.write(new Uint8Array(chunk)))
              .catch(() => {});
          } else if (status === 0) {
            // end of body
            close();
          }
        }),
      )
      .then((u: Function) => {
        unlisten = u;
        if (closed) u();
      });

    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
      "User-Agent": navigator.userAgent,
    };
    for (const item of new Headers(_headers || {})) {
      headers[item[0]] = item[1];
    }
    const response = listening
      .then(() => {
        if (signal?.aborted) throw abortError();
        started = true;
        return window.__TAURI__!.invoke("stream_fetch", {
          method: method.toUpperCase(),
          url,
          headers,
          cancelId,
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
        const response = new Response(ts.readable, {
          status,
          statusText,
          headers,
        });
        return response;
      })
      .catch((e) => {
        if (signal?.aborted) throw abortError();
        console.error("stream error", e);
        // throw e;
        return new Response("", { status: 599 });
      });
    return signal ? Promise.race([response, aborted]) : response;
  }
  return window.fetch(url, options);
}
