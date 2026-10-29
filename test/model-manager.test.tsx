import React from "react";
import { jest } from "@jest/globals";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
for (const icon of ["close", "confirm", "cancel", "max", "min", "down"])
  jest.unstable_mockModule(`@/app/icons/${icon}.svg`, () => ({
    default: () => <svg />,
  }));
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
await import("../app/client/api");
const { useAppConfig, useAccessStore } = await import("../app/store");
const { discoveredModels } = await import("../app/client/models");
const { ServiceProvider } = await import("../app/constant");
const { ModelManager } = await import("../app/components/model-manager");
const Locale = (await import("../app/locales")).default;
const text = Locale.ModelManager;
const models = [
  ...discoveredModels(["shared", "other"], "OpenAI"),
  ...discoveredModels(["shared"], "Anthropic"),
];
beforeEach(() => {
  useAppConfig.setState({
    models,
    lastUpdateTime: 1,
    customModels: "manual-model",
    modelConfig: {
      ...useAppConfig.getState().modelConfig,
      model: "shared",
      providerName: ServiceProvider.OpenAI,
    },
  });
  useAccessStore.setState({ useCustomConfig: false });
  render(<ModelManager />);
  fireEvent.click(screen.getByRole("button", { name: text.Title }));
});
afterEach(cleanup);
async function confirm() {
  fireEvent.click(
    await screen.findByRole("button", { name: new RegExp(Locale.UI.Confirm) }),
  );
}
test("all providers grouped and searchable offline, with default and custom-source guidance", () => {
  expect(
    screen.getByRole("heading", { name: "OpenAI (2)" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Anthropic (1)" }),
  ).toBeInTheDocument();
  expect(screen.getByText(text.CustomHint)).toBeInTheDocument();
  expect(screen.getByText(`shared · ${text.Default}`)).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: text.Search }), {
    target: { value: "Anthropic" },
  });
  expect(
    screen.queryByRole("checkbox", { name: "OpenAI: shared" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", { name: "Anthropic: shared" }),
  ).toBeInTheDocument();
});
test("single deletion confirms count, respects cancel and isolates same name by provider", async () => {
  fireEvent.click(
    screen.getByRole("button", { name: `${text.Delete}: Anthropic: shared` }),
  );
  expect(await screen.findByText(text.Confirm(1))).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(Locale.UI.Cancel) }),
  );
  expect(useAppConfig.getState().models).toHaveLength(3);
  fireEvent.click(
    screen.getByRole("button", { name: `${text.Delete}: Anthropic: shared` }),
  );
  await confirm();
  await waitFor(() => expect(useAppConfig.getState().models).toHaveLength(2));
  expect(
    useAppConfig
      .getState()
      .models.every((m) => m.provider.providerName === "OpenAI"),
  ).toBe(true);
  expect(useAppConfig.getState().lastUpdateTime).toBeGreaterThan(1);
});
test("batch delete retains selection while searching and warns for default model", async () => {
  fireEvent.click(screen.getByRole("checkbox", { name: "OpenAI: shared" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Anthropic: shared" }));
  fireEvent.change(screen.getByRole("textbox", { name: text.Search }), {
    target: { value: "other" },
  });
  fireEvent.click(screen.getByRole("button", { name: text.DeleteSelected(2) }));
  expect(await screen.findByText(text.Confirm(2))).toBeInTheDocument();
  expect(screen.getByText(text.DefaultWarning)).toBeInTheDocument();
  await confirm();
  await waitFor(() =>
    expect(useAppConfig.getState().models.map((m) => m.name)).toEqual([
      "other",
    ]),
  );
  expect(useAppConfig.getState().modelConfig.model).toBe("shared");
  expect(useAppConfig.getState().customModels).toBe("manual-model");
});
test("clear provider includes hidden search results and preserves other providers", async () => {
  fireEvent.change(screen.getByRole("textbox", { name: text.Search }), {
    target: { value: "other" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: `OpenAI: ${text.ClearProvider(2)}` }),
  );
  expect(await screen.findByText(text.Confirm(2))).toBeInTheDocument();
  await confirm();
  await waitFor(() => expect(useAppConfig.getState().models).toHaveLength(1));
  expect(useAppConfig.getState().models[0].provider.providerName).toBe(
    "Anthropic",
  );
});
