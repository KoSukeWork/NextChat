import { jest } from "@jest/globals";

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
const { ChatGPTApi } = await import("../app/client/platforms/openai");
const chat = jest
  .spyOn(ChatGPTApi.prototype, "chat")
  .mockImplementation(async () => {});
const { useAppConfig, useChatStore } = await import("../app/store");
const { useMaskStore, createEmptyMask } = await import("../app/store/mask");
const Locale = (await import("../app/locales")).default;

beforeEach(() => {
  useAppConfig.setState({
    endpoints: [
      {
        id: "local",
        name: "Local",
        protocol: "openai-chat",
        baseUrl: "https://example.test",
        apiKey: "key",
        models: [{ name: "home" }, { name: "same" }],
      },
    ],
    modelConfig: {
      ...useAppConfig.getState().modelConfig,
      model: "home",
      endpointId: "local",
      compressModel: "",
      compressEndpointId: "",
    },
  });
  useChatStore.getState().newSession();
  toast.mockClear();
  chat.mockClear();
});

test("a synced model resolves by name on this device and only changes the current session", async () => {
  const other = useChatStore.getState().currentSession();
  const otherBefore = JSON.stringify(other.mask);
  useChatStore.getState().newSession();
  const session = useChatStore.getState().currentSession();
  session.mask.modelConfig = {
    ...session.mask.modelConfig,
    model: "same",
    endpointId: "remote",
  };
  await useChatStore.getState().onUserInput("hello");
  expect(session.mask.modelConfig).toMatchObject({
    model: "same",
    endpointId: "local",
  });
  expect(chat).toHaveBeenCalledWith(
    expect.objectContaining({
      config: expect.objectContaining({ model: "same", endpointId: "local" }),
    }),
  );
  expect(JSON.stringify(other.mask)).toBe(otherBefore);
  expect(toast).not.toHaveBeenCalled();
});

test("missing model falls back to local default and shows a notice", async () => {
  const session = useChatStore.getState().currentSession();
  session.mask.modelConfig = {
    ...session.mask.modelConfig,
    model: "remote-only",
    endpointId: "remote",
  };
  await useChatStore.getState().onUserInput("hello");
  expect(session.mask.modelConfig).toMatchObject({
    model: "home",
    endpointId: "local",
  });
  expect(chat).toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(
    Locale.ModelFallback.Switched("remote-only (—)", "home (Local)"),
  );
});

test("no local default prevents a request and preserves messages", async () => {
  useAppConfig.setState({ endpoints: [] });
  const session = useChatStore.getState().currentSession();
  const before = session.messages.slice();
  await useChatStore.getState().onUserInput("must not send");
  expect(chat).not.toHaveBeenCalled();
  expect(session.messages).toEqual(before);
  expect(toast).toHaveBeenCalledWith(
    Locale.ModelDiscovery.ConfigureFirst,
    expect.objectContaining({ onClick: expect.any(Function) }),
  );
});

test("a remote mask resolves without mutating the saved mask", () => {
  const mask = useMaskStore
    .getState()
    .create({
      ...createEmptyMask(),
      modelConfig: {
        ...useAppConfig.getState().modelConfig,
        model: "same",
        endpointId: "remote",
      },
    });
  const before = JSON.stringify(mask);
  useChatStore.getState().newSession(mask);
  expect(
    useChatStore.getState().currentSession().mask.modelConfig,
  ).toMatchObject({ model: "same", endpointId: "local" });
  expect(JSON.stringify(useMaskStore.getState().masks[mask.id])).toBe(before);
});

test("compression uses the same local model resolution", () => {
  const session = useChatStore.getState().currentSession();
  Object.assign(session.mask.modelConfig, {
    compressModel: "same",
    compressEndpointId: "remote",
    compressMessageLengthThreshold: 0,
    sendMemory: true,
  });
  session.messages = [
    {
      id: "m",
      role: "user",
      content: "a long message for compression",
      date: "2026-10-29",
    },
  ];
  useChatStore.getState().summarizeSession(true, session);
  expect(chat).toHaveBeenCalled();
  expect(session.mask.modelConfig).toMatchObject({
    compressModel: "same",
    compressEndpointId: "local",
  });
});
