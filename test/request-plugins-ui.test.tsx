import React from "react";
import { jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { SourceTextModule } from "node:vm";
import { TextDecoder, TextEncoder } from "node:util";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";

Object.assign(globalThis, { TextEncoder, TextDecoder });

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
jest.unstable_mockModule("@/app/request-plugins/worker", () => ({
  callPlugin: async (source: string, hook: string, args: unknown[]) => {
    const module = new SourceTextModule(source);
    await module.link(() => {
      throw new Error("Unexpected plugin import");
    });
    await module.evaluate();
    const fn = (module.namespace as Record<string, unknown>)[hook] as (
      ...args: unknown[]
    ) => unknown;
    return fn(...args);
  },
}));
const pkg = JSON.parse(
  readFileSync(
    "public/request-plugins/nextchat.claude-code-4.0.0.json",
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
    target: { value: "nextchat.claude-code@4.0.0" },
  });
  expect(
    screen.getByLabelText(pkg.manifest.fields.connection.title),
  ).toHaveValue("builtin");
  expect(
    screen.queryByLabelText(pkg.manifest.fields.bridgeToken.title),
  ).toBeNull();
  fireEvent.change(
    screen.getByLabelText(pkg.manifest.fields.connection.title),
    {
      target: { value: "external" },
    },
  );
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
  fireEvent.change(
    screen.getByLabelText(pkg.manifest.fields.connection.title),
    {
      target: { value: "builtin" },
    },
  );
  expect(
    screen.queryByLabelText(pkg.manifest.fields.bridgeToken.title),
  ).toBeNull();
  fireEvent.change(
    screen.getByLabelText(pkg.manifest.fields.connection.title),
    {
      target: { value: "external" },
    },
  );
  expect(
    screen.getByLabelText(pkg.manifest.fields.bridgeToken.title),
  ).toHaveValue("local-cli-token-12345");
  fireEvent.click(
    screen.getByRole("button", { name: Locale.RequestPlugins.Preview }),
  );
  const preview = await screen.findByText(
    (content, node) =>
      node?.tagName === "PRE" && content.includes("[REDACTED]"),
  );
  expect(preview).toHaveTextContent("client-driver");
  expect(preview).not.toHaveTextContent("local-cli-token-12345");
  fireEvent.click(preview.closest(".modal-mask")!.querySelectorAll("svg")[1]);
  fireEvent.click(
    screen.getByRole("button", { name: Locale.EndpointConfig.Save }),
  );
  expect(useAppConfig.getState().endpoints[0].requestPlugin).toMatchObject({
    id: "nextchat.claude-code",
    version: "4.0.0",
    config: {
      connection: "external",
      bridgeToken: "local-cli-token-12345",
      nativeCliVersion: "2.1.322",
    },
  });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: `${Locale.RequestPlugins.Enabled}: Claude Code 4.0.0`,
    }),
  );
  expect(useAppConfig.getState().requestPlugins[0].enabled).toBe(false);
  expect(useAppConfig.getState().endpoints[0].requestPlugin?.version).toBe(
    "4.0.0",
  );
});
