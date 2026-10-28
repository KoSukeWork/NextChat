import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { invoke, listen } from "./tauri-api";

interface ProcessEvent {
  id: string;
  runId: number;
  line: string | null;
  code: number | null;
}

export class TauriStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private unlisteners: (() => void)[] = [];
  private runId?: number;
  private starting?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private buffered: [string, ProcessEvent][] = [];

  constructor(private readonly id: string) {}

  start(): Promise<void> {
    if (this.starting || this.closed)
      return Promise.reject(
        new Error("MCP transport has already started or closed"),
      );
    this.starting = this.open();
    return this.starting;
  }

  private async open() {
    try {
      for (const event of ["mcp://message", "mcp://exit", "mcp://stderr"]) {
        this.unlisteners.push(
          await listen<ProcessEvent>(event, ({ payload }) => {
            if (payload.id !== this.id || this.closed) return;
            // A server can emit before invoke(spawn) resolves. Buffer until its generation is known.
            if (this.runId === undefined) this.buffered.push([event, payload]);
            else this.receive(event, payload);
          }),
        );
      }
      if (this.closed) return;
      this.runId = await invoke<number>("mcp_spawn", { id: this.id });
      if (!this.closed) {
        for (const [event, payload] of this.buffered)
          this.receive(event, payload);
      }
      this.buffered = [];
    } catch (error) {
      this.finish();
      throw error;
    }
  }

  private receive(event: string, payload: ProcessEvent) {
    if (payload.runId !== this.runId || this.closed) return;
    if (event === "mcp://message") {
      try {
        this.onmessage?.(
          JSONRPCMessageSchema.parse(JSON.parse(payload.line ?? "")),
        );
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    } else if (event === "mcp://exit") {
      if (payload.code !== 0)
        this.onerror?.(
          new Error(
            `MCP server ${this.id} exited (${payload.code ?? "unknown"})`,
          ),
        );
      this.finish();
    } else {
      // stderr is diagnostic output, never protocol data or an automatic restart trigger.
      console.debug(`[MCP ${this.id}]`, payload.line);
    }
  }

  async send(message: JSONRPCMessage) {
    if (this.closed || this.runId === undefined)
      throw new Error("MCP connection is closed");
    await invoke("mcp_send", {
      id: this.id,
      runId: this.runId,
      line: JSON.stringify(message),
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const alreadyClosed = this.closed;
    this.finish();
    this.closing = (async () => {
      try {
        await this.starting;
      } catch {
        /* start already reported the failure */
      }
      try {
        if (!alreadyClosed && this.runId !== undefined) {
          await invoke("mcp_kill", { id: this.id, runId: this.runId });
        }
      } finally {
        // Also release listeners registered while close was waiting for start.
        this.releaseListeners();
      }
    })();
    return this.closing;
  }

  private releaseListeners() {
    for (const unlisten of this.unlisteners.splice(0)) unlisten();
    this.buffered = [];
  }

  private finish() {
    this.releaseListeners();
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
