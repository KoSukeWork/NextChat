import React from "react";
import { jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";

for (const icon of [
  "close",
  "confirm",
  "cancel",
  "max",
  "min",
  "down",
  "add",
  "download",
  "upload",
  "clear",
])
  jest.unstable_mockModule(`@/app/icons/${icon}.svg`, () => ({
    default: () => <svg />,
  }));
jest.unstable_mockModule("@/app/client/endpoint-models", () => ({
  fetchEndpointModels: jest.fn(async () => []),
}));
const pkg = JSON.parse(
  readFileSync(
    "public/request-plugins/nextchat.claude-code-3.2.0-beta.1.json",
    "utf8",
  ),
);
const { useAppConfig } = await import("../app/store/config");
const { RequestPluginManager } = await import(
  "../app/components/request-plugins"
);
const { EndpointConfigList } = await import(
  "../app/components/endpoint-config"
);
const Locale = (await import("../app/locales")).default;

beforeEach(() => {
  useAppConfig.setState({ requestPlugins: [], endpoints: [] });
  jest
    .mocked(global.fetch)
    .mockImplementation(
      async () => ({ ok: true, json: async () => pkg }) as Response,
    );
});
afterEach(cleanup);

test("install a package without rebuilding and bind its configurable version to an endpoint", async () => {
  render(
    <>
      <RequestPluginManager />
      <EndpointConfigList />
    </>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: Locale.RequestPlugins.AddClaudePlugin }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: new RegExp(Locale.UI.Confirm) }),
  );
  await waitFor(() =>
    expect(useAppConfig.getState().requestPlugins).toHaveLength(1),
  );
  fireEvent.click(
    screen.getByRole("button", { name: Locale.EndpointConfig.Add }),
  );
  fireEvent.change(screen.getByLabelText(Locale.EndpointConfig.Name), {
    target: { value: "CLI" },
  });
  fireEvent.change(screen.getByLabelText(Locale.EndpointConfig.Protocol), {
    target: { value: "anthropic" },
  });
  fireEvent.change(screen.getByLabelText(Locale.EndpointConfig.BaseUrl), {
    target: { value: "https://gateway.test" },
  });
  fireEvent.change(screen.getByLabelText(Locale.RequestPlugins.Select), {
    target: { value: "nextchat.claude-code@3.2.0-beta.1" },
  });
  expect(screen.getByLabelText(pkg.manifest.fields.profile.title)).toHaveValue(
    "verified",
  );
  fireEvent.change(screen.getByLabelText(pkg.manifest.fields.profile.title), {
    target: { value: "custom" },
  });
  fireEvent.change(
    screen.getByLabelText(pkg.manifest.fields.cliVersion.title),
    { target: { value: "2.1.400" } },
  );
  fireEvent.change(
    screen.getByLabelText(pkg.manifest.fields.transportToken.title),
    {
      target: { value: "local-wire-token-12345" },
    },
  );
  expect(
    screen.queryByLabelText(pkg.manifest.fields.bridgeToken.title),
  ).toBeNull();
  fireEvent.change(screen.getByLabelText(pkg.manifest.fields.mode.title), {
    target: { value: "cli" },
  });
  expect(
    screen.queryByLabelText(pkg.manifest.fields.transportToken.title),
  ).toBeNull();
  fireEvent.change(
    screen.getByLabelText(pkg.manifest.fields.bridgeToken.title),
    {
      target: { value: "local-cli-token-12345" },
    },
  );
  fireEvent.change(
    screen.getByLabelText(pkg.manifest.fields.nativeCliVersion.title),
    {
      target: { value: "2.1.322" },
    },
  );
  fireEvent.change(screen.getByLabelText(pkg.manifest.fields.mode.title), {
    target: { value: "http" },
  });
  expect(
    screen.getByLabelText(pkg.manifest.fields.transportToken.title),
  ).toHaveValue("local-wire-token-12345");
  expect(
    screen.getByLabelText(pkg.manifest.fields.cliVersion.title),
  ).toHaveValue("2.1.400");
  fireEvent.change(screen.getByLabelText(pkg.manifest.fields.mode.title), {
    target: { value: "cli" },
  });
  expect(
    screen.getByLabelText(pkg.manifest.fields.bridgeToken.title),
  ).toHaveValue("local-cli-token-12345");
  fireEvent.click(
    screen.getByRole("button", { name: Locale.EndpointConfig.Save }),
  );
  expect(useAppConfig.getState().endpoints[0].requestPlugin).toMatchObject({
    id: "nextchat.claude-code",
    version: "3.2.0-beta.1",
    config: {
      mode: "cli",
      profile: "custom",
      transportToken: "local-wire-token-12345",
      cliVersion: "2.1.400",
      bridgeToken: "local-cli-token-12345",
      nativeCliVersion: "2.1.322",
    },
  });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: `${Locale.RequestPlugins.Enabled}: Claude Code 3.2.0-beta.1`,
    }),
  );
  expect(useAppConfig.getState().requestPlugins[0].enabled).toBe(false);
  expect(useAppConfig.getState().endpoints[0].requestPlugin?.version).toBe(
    "3.2.0-beta.1",
  );
});
