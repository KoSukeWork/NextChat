/** @jest-environment node */
import { jest } from "@jest/globals";

const send =
  jest.fn<(url: string, options: RequestInit) => Promise<Response>>();
const enabled = jest.fn(async () => true);
const toast = jest.fn();
jest.unstable_mockModule("@/app/utils/endpoint-transport", () => ({
  endpointFetch: send,
}));
jest.unstable_mockModule("@/app/components/ui-lib", () => ({
  showToast: toast,
}));
jest.unstable_mockModule("@/app/mcp/actions", () => ({
  isMcpEnabled: enabled,
  getAllTools: async () => [],
  executeMcpAction: async () => undefined,
  getMcpConfigFromFile: async () => ({ mcpServers: {} }),
  mergeMcpServers: async () => ({}),
}));
const { useAppConfig, useChatStore, createEmptySession, createMessage } =
  await import("../app/store");
const Locale = (await import("../app/locales")).default;
const sse = (content: string) =>
  new Response(
    `data: ${JSON.stringify({
      choices: [{ delta: { content } }],
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Title request did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  send.mockReset();
  enabled.mockClear();
  toast.mockClear();
  useAppConfig.setState({
    endpoints: [
      {
        id: "ep",
        name: "EP",
        protocol: "openai-chat",
        baseUrl: "https://example.test",
        apiKey: "secret-key",
        models: [{ name: "model" }],
      },
    ],
    modelConfig: {
      ...useAppConfig.getState().modelConfig,
      model: "model",
      endpointId: "ep",
      compressModel: "",
      sendMemory: false,
    },
  });
});

test("a streamed title reaches the initiating conversation without discovering MCP tools", async () => {
  send.mockResolvedValue(sse("<think>reasoning</think>Streamed title"));
  const session = createEmptySession();
  session.topic = "Original";
  session.messages = [createMessage({ content: "hello" })];
  useChatStore.setState({ sessions: [session], currentSessionIndex: 0 });
  useChatStore.getState().summarizeSession(true, session);
  await waitFor(() => session.topic === "Streamed title");
  expect(session.topic).toBe("Streamed title");
  expect(JSON.parse(send.mock.calls[0][1].body as string)).toMatchObject({
    stream: true,
  });
  expect(enabled).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

test("an HTTP failure traverses the real endpoint client without leaking the response body", async () => {
  send.mockResolvedValue(new Response("token secret-key", { status: 401 }));
  const session = createEmptySession();
  session.topic = "Original";
  session.messages = [createMessage({ content: "hello" })];
  useChatStore.setState({ sessions: [session], currentSessionIndex: 0 });
  useChatStore.getState().summarizeSession(true, session);
  await waitFor(() => toast.mock.calls.length > 0);
  expect(session.topic).toBe("Original");
  expect(toast).toHaveBeenCalledWith(
    Locale.Chat.Actions.RefreshTitleFailed("HTTP 401"),
  );
  expect(JSON.stringify(toast.mock.calls)).not.toContain("secret-key");
});
