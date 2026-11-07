import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { NativeStreamError } from "../utils/stream";

/** Only failures proven to occur before execution may replay a tool request. */
export class McpRequestNotSent extends Error {
  constructor(public readonly reason: "closed" | "refused" | "session") {
    super(
      reason === "refused"
        ? "Remote MCP network connection was refused"
        : reason === "session"
        ? "Remote MCP session expired"
        : "MCP connection is closed",
    );
    this.name = "McpRequestNotSent";
  }
}

/** A transport or HTTP failure, which is distinct from a tool or RPC error. */
export class McpConnectionError extends Error {
  constructor(
    cause: unknown,
    public readonly code?: number,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "McpConnectionError";
  }
}

export function isMcpConnectionFailure(
  error: unknown,
  client?: { transport?: unknown },
) {
  if (
    error instanceof McpRequestNotSent ||
    error instanceof McpConnectionError ||
    error instanceof NativeStreamError
  )
    return true;
  // Server JSON-RPC errors use the same class and may reuse SDK error codes.
  // Only treat ConnectionClosed as local if the transport is actually gone.
  if (error instanceof McpError)
    return (
      error.code === ErrorCode.ConnectionClosed &&
      !!client &&
      "transport" in client &&
      !client.transport
    );
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth++
  ) {
    const value = current as { code?: unknown; cause?: unknown };
    if (
      [
        "ECONNRESET",
        "ECONNABORTED",
        "EPIPE",
        "UND_ERR_SOCKET",
        "UND_ERR_CLOSED",
      ].includes(String(value.code))
    )
      return true;
    current = value.cause;
  }
  return false;
}

export function isLocalMcpRequestTimeout(error: unknown) {
  return (
    error instanceof McpError &&
    error.code === ErrorCode.RequestTimeout &&
    error.message ===
      `MCP error ${ErrorCode.RequestTimeout}: Request timed out` &&
    typeof (error.data as { timeout?: unknown } | undefined)?.timeout ===
      "number"
  );
}

export class McpReconnectTimeout extends Error {
  constructor() {
    super("MCP reconnect timed out");
    this.name = "McpReconnectTimeout";
  }
}

/** Do not close a failed client while another already-dispatched call is settling. */
export class McpCallTracker {
  private readonly states = new WeakMap<
    object,
    { count: number; retire?: () => void; retired: boolean }
  >();

  async run<T>(client: object, operation: () => Promise<T>) {
    const state = this.states.get(client) ?? { count: 0, retired: false };
    this.states.set(client, state);
    state.count++;
    try {
      return await operation();
    } finally {
      state.count--;
      if (state.count === 0 && state.retire && !state.retired) {
        state.retired = true;
        state.retire();
      }
    }
  }

  retire(client: object, close: () => void) {
    const state = this.states.get(client) ?? { count: 0, retired: false };
    this.states.set(client, state);
    if (state.retired || state.retire) return;
    if (state.count) state.retire = close;
    else {
      state.retired = true;
      close();
    }
  }
}

/** Race an operation with a one-shot deadline and release its abort listener. */
export function untilAborted<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (f: () => void) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
      f();
    };
    const abort = () =>
      finish(() => {
        try {
          onAbort?.();
        } catch {
          // Cancellation cleanup is best-effort; the caller still gets a deadline.
        }
        reject(new McpReconnectTimeout());
      });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** Single-flight per id; different ids in one request are started in parallel. */
export class ReconnectCoordinator {
  private readonly inFlight = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();

  constructor(
    private readonly start: (
      ids: string[],
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  pendingIds() {
    return [...this.inFlight.keys()];
  }

  cancel(id?: string) {
    const ids = id === undefined ? this.pendingIds() : [id];
    for (const selected of ids) {
      const flight = this.inFlight.get(selected);
      if (!flight) continue;
      this.inFlight.delete(selected);
      flight.controller.abort();
    }
  }

  async reconnect(ids: string[]) {
    ids = [...new Set(ids)];
    if (!ids.length) return;
    const fresh = ids.filter((id) => !this.inFlight.has(id));
    for (const id of fresh) {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 60000);
      const flight = { controller, done: Promise.resolve() };
      flight.done = Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) return;
          return untilAborted(
            this.start([id], controller.signal),
            controller.signal,
          );
        })
        .catch(() => {})
        .finally(() => {
          clearTimeout(deadline);
          if (this.inFlight.get(id) === flight) this.inFlight.delete(id);
        });
      this.inFlight.set(id, flight);
    }
    const flights = ids
      .map((id) => this.inFlight.get(id)?.done)
      .filter(Boolean);
    try {
      // Only this caller stops waiting; the shared attempt continues for up to 60 s.
      await untilAborted(
        Promise.all(flights).then(() => {}),
        AbortSignal.timeout(3000),
      );
    } catch {
      // A failed or timed-out reconnect must not prevent the user's message.
    }
  }
}
