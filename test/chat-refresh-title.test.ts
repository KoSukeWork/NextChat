import { jest } from "@jest/globals";
import type { ChatOptions } from "../app/client/api";

jest.mocked(global.fetch).mockImplementation(
  async (input) =>
    ({
      json: async () =>
        String(input).includes("prompts.json")
          ? { en: [], cn: [], tw: [] }
          : [],
    }) as Response,
);
const toast = jest.fn();
jest.unstable_mockModule("@/app/components/ui-lib", () => ({
  showToast: toast,
}));
const { EndpointClient } = await import("../app/client/endpoint-client");
const { EndpointStreamError } = await import("../app/client/endpoint-protocol");
const {
  useAppConfig,
  useChatStore,
  createEmptySession,
  createMessage,
  DEFAULT_TOPIC,
} = await import("../app/store");
const Locale = (await import("../app/locales")).default;
const chat = jest
  .spyOn(EndpointClient.prototype, "chat")
  .mockImplementation(async () => {});

beforeEach(() => {
  toast.mockClear();
  chat.mockClear();
  useAppConfig.setState({
    enableAutoGenerateTitle: true,
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

function setup(topic = "Old title") {
  const session = createEmptySession();
  session.topic = topic;
  session.messages = [createMessage({ content: "example ".repeat(100) })];
  useChatStore.setState({ sessions: [session], currentSessionIndex: 0 });
  return session;
}
function start(
  session: ReturnType<typeof createEmptySession>,
  manual: boolean,
) {
  useChatStore.getState().summarizeSession(manual, session);
  expect(chat).toHaveBeenCalledTimes(1);
  return chat.mock.calls[0][0] as ChatOptions;
}
const response = (status: number) => ({ status } as Response);
const ok = () => response(200);

test("manual refresh streams with the chat model, without tools, and strips thinking", () => {
  const session = setup();
  const request = start(session, true);
  expect(request.config).toMatchObject({
    model: "model",
    endpointId: "ep",
    stream: true,
  });
  expect(request.enableTools).not.toBe(true);
  request.onFinish('<think>reasoning</think>  "Updated title"  ', ok());
  expect(useChatStore.getState().currentSession().topic).toBe("Updated title");
  expect(toast).not.toHaveBeenCalled();
});

test.each([
  [new EndpointStreamError("HTTP 401: echoed secret-key", 401), "HTTP 401"],
  [
    new TypeError("Failed to fetch https://example.test?key=secret-key"),
    Locale.Settings.Sync.Errors.NETWORK_FAILED,
  ],
  [
    new Error(Locale.Settings.Sync.Errors.NETWORK_REFUSED),
    Locale.Settings.Sync.Errors.NETWORK_REFUSED,
  ],
  [
    new Error("unexpected secret-key"),
    Locale.Chat.Actions.RefreshTitleUnknownError,
  ],
])("manual errors show a safe reason and keep the title", (error, reason) => {
  const session = setup();
  start(session, true).onError!(error);
  expect(session.topic).toBe("Old title");
  expect(toast).toHaveBeenCalledWith(
    Locale.Chat.Actions.RefreshTitleFailed(reason),
  );
  expect(String(toast.mock.calls[0][0])).not.toContain("secret-key");
});

test("manual timeout reports its cause without changing the title", () => {
  const session = setup();
  start(session, true).onFinish("", response(499));
  expect(session.topic).toBe("Old title");
  expect(toast).toHaveBeenCalledWith(
    Locale.Chat.Actions.RefreshTitleFailed(
      Locale.Settings.Sync.Errors.NETWORK_TIMEOUT,
    ),
  );
});

test.each(["", "   ", "<think>reasoning only</think>", '""'])(
  "empty manual result keeps the title and shows a message",
  (message) => {
    const session = setup();
    start(session, true).onFinish(message, ok());
    expect(session.topic).toBe("Old title");
    expect(toast).toHaveBeenCalledWith(Locale.Chat.Actions.RefreshTitleEmpty);
  },
);

test.each(["error", "empty", "thinking", "timeout"])(
  "automatic title %s stays silent and keeps the title",
  (outcome) => {
    const session = setup(DEFAULT_TOPIC);
    const request = start(session, false);
    if (outcome === "error")
      request.onError!(new EndpointStreamError("HTTP 401: secret", 401));
    else if (outcome === "timeout")
      request.onFinish("", response(499));
    else
      request.onFinish(
        outcome === "thinking" ? "<think>thinking</think>" : "",
        ok(),
      );
    expect(session.topic).toBe(DEFAULT_TOPIC);
    expect(toast).not.toHaveBeenCalled();
  },
);

test("a result targets its original conversation after a switch and safely ignores deletion", () => {
  const first = setup();
  const second = createEmptySession();
  second.topic = "Other";
  useChatStore.setState({ sessions: [first, second], currentSessionIndex: 0 });
  const request = start(first, true);
  useChatStore.setState({ currentSessionIndex: 1 });
  request.onFinish("New title", ok());
  expect(first.topic).toBe("New title");
  expect(second.topic).toBe("Other");
  useChatStore.setState({ sessions: [second], currentSessionIndex: 0 });
  expect(() => request.onFinish("Deleted", ok())).not.toThrow();
  expect(second.topic).toBe("Other");
});

test("a missing model is reported manually and silent for automatic titles", () => {
  const session = setup(DEFAULT_TOPIC);
  useAppConfig.setState({ endpoints: [] });
  useChatStore.getState().summarizeSession(false, session);
  expect(toast).not.toHaveBeenCalled();
  useChatStore.getState().summarizeSession(true, session);
  expect(toast).toHaveBeenCalledWith(
    Locale.Chat.Actions.RefreshTitleFailed(
      Locale.ModelDiscovery.ConfigureFirst,
    ),
  );
  expect(chat).not.toHaveBeenCalled();
});
