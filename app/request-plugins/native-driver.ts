import { nanoid } from "nanoid";
import type { PreparedHostDriver } from "./host";

/** Wrap the host's registered native driver as the same NDJSON stream used by
 * an external bridge. The worker never receives a program path or command. */
export async function openNativeDriver(
  request: PreparedHostDriver,
  hostTools: unknown[],
  signal: AbortSignal,
) {
  const native = window.__TAURI__;
  if (!native || request.hostDriver !== "claude-code")
    throw new Error("Built-in CLI driver is unavailable");
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const requestId = nanoid();
  const encoder = new TextEncoder();
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  let unlisten: (() => void) | undefined;
  let started = false;
  let closed = false;
  const cancelNative = () => {
    if (started)
      void native.invoke("claude_cli_cancel", { requestId }).catch(() => {});
  };
  const close = (cancelled = false) => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    unlisten?.();
    if (!cancelled) writer.close();
  };
  const abort = () => {
    cancelNative();
    close();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      writer = controller;
    },
    cancel() {
      cancelNative();
      close(true);
    },
  });
  signal.addEventListener("abort", abort, { once: true });
  try {
    unlisten = await native.event.listen(
      "claude-cli-event",
      ({ payload }: any) => {
        if (closed || payload?.requestId !== requestId) return;
        if (payload.event?.type === "stream_end") {
          close();
          return;
        }
        writer.enqueue(encoder.encode(`${JSON.stringify(payload.event)}\n`));
      },
    );
    if (closed || signal.aborted) {
      unlisten();
      throw new DOMException("Aborted", "AbortError");
    }
    started = true;
    await native.invoke("claude_cli_start", {
      requestId,
      input: request.input,
      hostTools,
    });
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  } catch (error) {
    if (signal.aborted) cancelNative();
    close();
    throw error;
  }
}
