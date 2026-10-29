import { jest } from "@jest/globals";
jest
  .mocked(global.fetch)
  .mockImplementation(
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
await import("../app/client/api");
const { ChatGPTApi } = await import("../app/client/platforms/openai");
const chat = jest
  .spyOn(ChatGPTApi.prototype, "chat")
  .mockImplementation(async () => {});
const { useAppConfig, useAccessStore, useChatStore } = await import(
  "../app/store"
);
const { useMaskStore, createEmptyMask } = await import("../app/store/mask");
const { discoveredModels } = await import("../app/client/models");
const { ServiceProvider } = await import("../app/constant");
const { configuredModels } = await import("../app/utils/local-models");
const Locale = (await import("../app/locales")).default;
beforeEach(() => {
  useAppConfig.setState({
    models: discoveredModels(["home", "other"], "OpenAI"),
    customModels: "manual@OpenAI",
    modelConfig: {
      ...useAppConfig.getState().modelConfig,
      model: "home",
      providerName: ServiceProvider.OpenAI,
      compressModel: "",
      compressProviderName: "",
    },
  });
  useAccessStore.setState({
    customModels: "",
    defaultModel: "",
    useCustomConfig: false,
  });
  useChatStore.getState().newSession();
  toast.mockClear();
  chat.mockClear();
});

test("available picker models and custom models are kept without a toast", async () => {
  const session = useChatStore.getState().currentSession();
  session.mask.modelConfig.model = "manual";
  expect(
    configuredModels(useAppConfig.getState(), useAccessStore.getState()).some(
      (m) => m.name === "manual" && m.available,
    ),
  ).toBe(true);
  await useChatStore.getState().onUserInput("hello");
  expect(chat).toHaveBeenCalledWith(
    expect.objectContaining({
      config: expect.objectContaining({
        model: "manual",
        providerName: "OpenAI",
      }),
    }),
  );
  expect(toast).not.toHaveBeenCalled();
});

test("missing provider/model falls back before sending and updates only this session", async () => {
  const other = useChatStore.getState().currentSession();
  useChatStore.getState().newSession();
  const session = useChatStore.getState().currentSession();
  session.mask.modelConfig.model = "other";
  session.mask.modelConfig.providerName = ServiceProvider.Anthropic;
  await useChatStore.getState().onUserInput("hello");
  expect(session.mask.modelConfig).toMatchObject({
    model: "home",
    providerName: "OpenAI",
  });
  expect(chat).toHaveBeenCalledWith(
    expect.objectContaining({
      config: expect.objectContaining({
        model: "home",
        providerName: "OpenAI",
      }),
    }),
  );
  expect(toast).toHaveBeenCalledWith(
    Locale.ModelFallback.Switched("other@Anthropic", "home@OpenAI"),
  );
  expect(other.messages).toHaveLength(0);
});

test("missing or disabled default prevents requests and leaves messages intact", async () => {
  useAppConfig.setState({ customModels: "-all" });
  const session = useChatStore.getState().currentSession();
  session.mask.modelConfig.model = "remote";
  const before = session.messages.slice();
  await useChatStore.getState().onUserInput("must not send");
  expect(chat).not.toHaveBeenCalled();
  expect(session.messages).toEqual(before);
  expect(toast).toHaveBeenCalledWith(Locale.ModelDiscovery.ConfigureFirst);
});

test("new chat from remote mask falls back without changing the saved mask", () => {
  const mask = useMaskStore
    .getState()
    .create({
      ...createEmptyMask(),
      modelConfig: { ...useAppConfig.getState().modelConfig, model: "office" },
    });
  const before = JSON.stringify(mask);
  useChatStore.getState().newSession(mask);
  expect(useChatStore.getState().currentSession().mask.modelConfig.model).toBe(
    "home",
  );
  expect(JSON.stringify(useMaskStore.getState().masks[mask.id])).toBe(before);
  expect(toast).toHaveBeenCalledTimes(1);
});

test.each([true, false])(
  "compression/title model fallback (default available: %s)",
  (available) => {
    const session = useChatStore.getState().currentSession();
    session.mask.modelConfig.compressModel = "office-compress";
    session.mask.modelConfig.compressProviderName = "Anthropic";
    session.mask.modelConfig.compressMessageLengthThreshold = 0;
    session.mask.modelConfig.sendMemory = true;
    session.messages = [
      {
        id: "m",
        role: "user",
        content: "a long message for compression",
        date: "2026-10-29",
      },
    ];
    if (!available) useAppConfig.setState({ models: [], customModels: "" });
    useChatStore.getState().summarizeSession(true, session);
    if (available) {
      expect(chat).toHaveBeenCalledTimes(2);
      for (const [request] of chat.mock.calls)
        expect(request.config).toMatchObject({
          model: "home",
          providerName: "OpenAI",
        });
      expect(session.mask.modelConfig).toMatchObject({
        compressModel: "home",
        compressProviderName: "OpenAI",
      });
    } else {
      expect(chat).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith(Locale.ModelDiscovery.ConfigureFirst);
    }
  },
);
