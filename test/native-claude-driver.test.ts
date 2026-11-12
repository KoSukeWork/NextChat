/** @jest-environment node */
import { jest } from "@jest/globals";
import { TextEncoder, TextDecoder } from "node:util";

Object.assign(global, { TextEncoder, TextDecoder });
Object.defineProperty(globalThis, "window", { configurable: true, value: {} });

const plugin = {
  chat: jest.fn<(...args: any[]) => Promise<any>>(),
  dispose: jest.fn(async () => {}),
};
jest.unstable_mockModule("@/app/request-plugins/host", () => ({
  createPluginSession: () => plugin,
}));
const { runPluginDriver } = await import("../app/request-plugins/driver");

test("native driver events and enabled host tool results flow through the common stream consumer", async () => {
  const requestId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const callId = "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb";
  const emitted: any[] = [];
  let listener: ((event: any) => void) | undefined;
  let streamId = "";
  const send = (event: any) =>
    listener?.({ payload: { requestId: streamId, event } });
  const invoke = jest.fn<(...args: any[]) => Promise<any>>(
    async (command, args) => {
      if (command === "claude_cli_start") {
        streamId = args.requestId;
        queueMicrotask(() =>
          send({
            type: "host_tool_call",
            runId: requestId,
            id: callId,
            name: "allowed",
            input: { value: 42 },
          }),
        );
      } else if (command === "claude_cli_tool_result") {
        expect(args).toMatchObject({
          runId: requestId,
          callId,
          content: "tool result",
          isError: false,
        });
        send({ type: "text", text: "reply" });
        send({ type: "done" });
        send({ type: "stream_end" });
      }
    },
  );
  const unlisten = jest.fn();
  Object.defineProperty(window, "__TAURI__", {
    configurable: true,
    value: {
      invoke,
      event: {
        listen: async (_event: string, callback: any) => {
          listener = callback;
          return unlisten;
        },
      },
    },
  });
  plugin.chat.mockResolvedValue({
    hostDriver: "claude-code",
    input: {
      model: "test",
      endpoint: { baseUrl: "https://example.test", apiKey: "secret" },
      messages: [],
      sessionId: "one",
      authType: "api-key",
      betas: [],
      enableTools: true,
    },
  });
  const run = jest.fn(async () => "tool result");
  const finish = jest.fn();
  try {
    const result = await runPluginDriver(
      { id: "ep", protocol: "anthropic", requestPlugin: {} } as any,
      [{ role: "user", content: "hi" }],
      {
        config: { model: "test" },
        enableTools: true,
        onUpdate: (...args: any[]) => emitted.push(args),
        onFinish: finish,
      } as any,
      {
        tools: [
          {
            type: "function",
            function: { name: "allowed", parameters: { type: "object" } },
          },
        ],
        funcs: { allowed: run },
      },
    );
    expect(result).toBe(true);
    expect(run).toHaveBeenCalledWith({ value: 42 });
    expect(finish.mock.calls[0][0]).toBe("reply");
    expect(emitted[0][0]).toBe("reply");
    expect(unlisten).toHaveBeenCalled();
    expect(plugin.dispose).toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(window, "__TAURI__");
  }
});
