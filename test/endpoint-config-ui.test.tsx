import React from "react";
import { jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

for (const icon of ["close", "confirm", "cancel", "max", "min", "down"])
  jest.unstable_mockModule(`@/app/icons/${icon}.svg`, () => ({
    default: () => <svg />,
  }));
const fetchModels = jest.fn(async () => [
  { name: "remote", displayName: "Remote model" },
]);
jest.unstable_mockModule("@/app/client/endpoint-models", () => ({
  fetchEndpointModels: fetchModels,
}));
jest
  .mocked(global.fetch)
  .mockImplementation(
    async () =>
      ({ json: async () => ({ en: [], cn: [], tw: [] }) }) as Response,
  );
const { useAppConfig } = await import("../app/store/config");
const { EndpointConfigList } = await import(
  "../app/components/endpoint-config"
);
const { Selector } = await import("../app/components/ui-lib");
const Locale = (await import("../app/locales")).default;
const labels = Locale.EndpointConfig;

beforeEach(() => {
  useAppConfig.setState({
    endpoints: [],
    modelConfig: {
      ...useAppConfig.getState().modelConfig,
      model: "",
      endpointId: "",
    },
  });
  fetchModels.mockClear();
  render(<EndpointConfigList />);
});
afterEach(cleanup);

test("adds an interface, previews its URL, and saves manual and fetched models", async () => {
  fireEvent.click(screen.getByRole("button", { name: labels.Add }));
  fireEvent.change(screen.getByLabelText(labels.Name), {
    target: { value: "Work" },
  });
  fireEvent.change(screen.getByLabelText(labels.Protocol), {
    target: { value: "openai-responses" },
  });
  fireEvent.change(screen.getByLabelText(labels.BaseUrl), {
    target: { value: "https://gateway.test/custom/v1" },
  });
  fireEvent.change(screen.getByLabelText(labels.ApiKey), {
    target: { value: "secret" },
  });
  expect(
    screen.getByText("https://gateway.test/custom/v1/responses"),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(labels.ModelName), {
    target: { value: "manual" },
  });
  fireEvent.click(screen.getByRole("button", { name: labels.AddModel }));
  fireEvent.click(screen.getByRole("button", { name: labels.FetchModels }));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: `${labels.AddModel}: remote` }),
  );
  fireEvent.click(screen.getByRole("button", { name: labels.AddSelected }));
  fireEvent.click(screen.getByRole("button", { name: labels.Save }));
  expect(useAppConfig.getState().endpoints[0]).toMatchObject({
    name: "Work",
    protocol: "openai-responses",
    apiKey: "secret",
    models: [
      { name: "manual" },
      { name: "remote", displayName: "Remote model" },
    ],
  });
  expect(useAppConfig.getState().modelConfig).toMatchObject({
    model: "manual",
    endpointId: useAppConfig.getState().endpoints[0].id,
  });
  expect(
    screen.getByText("OpenAI Responses · https://gateway.test/custom/v1 · 2"),
  ).toBeInTheDocument();
});

test("deleting an interface confirms the model count and default selection", async () => {
  act(() =>
    useAppConfig.setState({
      endpoints: [
        {
          id: "one",
          name: "Work",
          protocol: "openai-chat",
          baseUrl: "https://example.test",
          apiKey: "key",
          models: [{ name: "first" }],
        },
      ],
      modelConfig: {
        ...useAppConfig.getState().modelConfig,
        endpointId: "one",
        model: "first",
      },
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: labels.Delete }));
  expect(
    await screen.findByText(labels.Remove("Work", 1, true)),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(Locale.UI.Confirm) }),
  );
  await waitFor(() =>
    expect(useAppConfig.getState().endpoints).toHaveLength(0),
  );
  expect(useAppConfig.getState().modelConfig).toMatchObject({
    endpointId: "",
    model: "",
  });
});

test("model selector searches both the interface label and underlying model name", () => {
  render(
    <Selector
      searchPlaceholder="Find model"
      items={[
        {
          title: "Friendly label (Work)",
          searchText: "internal-model",
          value: "one",
        },
        { title: "Another (Home)", searchText: "other", value: "two" },
      ]}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Find model" }), {
    target: { value: "internal-model" },
  });
  expect(screen.getByText("Friendly label (Work)")).toBeInTheDocument();
  expect(screen.queryByText("Another (Home)")).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Find model" }), {
    target: { value: "home" },
  });
  expect(screen.getByText("Another (Home)")).toBeInTheDocument();
});
