import React, { useState } from "react";
import { jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import type { Endpoint } from "../app/utils/endpoints";

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
const { EndpointRequestPlugin } = await import(
  "../app/components/request-plugins"
);
const { useAppConfig } = await import("../app/store/config");
const { installPlugin, parsePluginPackage, pluginDefaults } = await import(
  "../app/request-plugins/schema"
);
const { supportsLocalServices } = await import(
  "../app/request-plugins/local-services"
);
const Locale = (await import("../app/locales")).default;
const pkg = parsePluginPackage(
  JSON.parse(
    readFileSync(
      "public/request-plugins/nextchat.claude-code-3.2.0-beta.1.json",
      "utf8",
    ),
  ),
);
const fields = pkg.manifest.fields;
let meta: HTMLMetaElement;
const states = new Map<string, any>();
const invoke =
  jest.fn<(command: string, args?: Record<string, unknown>) => Promise<any>>();

function Harness() {
  const [endpoint, setEndpoint] = useState<Endpoint>({
    id: "local",
    name: "Local",
    protocol: "anthropic",
    models: [],
    apiKey: "dummy",
    baseUrl: "https://gateway.test",
    requestPlugin: {
      id: pkg.manifest.id,
      version: pkg.manifest.version,
      config: pluginDefaults(pkg),
    },
  });
  return (
    <EndpointRequestPlugin
      endpoint={endpoint}
      onChange={(change) => setEndpoint((value) => ({ ...value, ...change }))}
    />
  );
}

beforeEach(() => {
  meta = document.createElement("meta");
  meta.name = "config";
  meta.content = JSON.stringify({ isApp: true });
  document.head.append(meta);
  useAppConfig.setState({ requestPlugins: installPlugin([], pkg) });
  states.clear();
  invoke.mockReset();
  invoke.mockImplementation(async (command, args) => {
    const service = String(args!.service);
    const current = states.get(service) || {
      service,
      running: false,
      available: true,
      executablePath: service === "claude-cli" ? "C:/Tools/claude.exe" : "",
      canSelectExecutable: service === "claude-cli",
    };
    if (command === "local_service_start") {
      current.running = true;
      current.connection = {
        url:
          service === "wire"
            ? "http://127.0.0.1:51001"
            : "http://127.0.0.1:51002",
        token: `${service}-generated-secret-token`,
        ...(service === "claude-cli" ? { cliVersion: "2.1.400" } : {}),
      };
    } else if (command === "local_service_stop") {
      current.running = false;
      current.connection = null;
    } else if (command === "local_service_configure") {
      current.executablePath = args!.executablePath;
    } else if (command === "local_service_options") {
      current.allowedTools = args!.allowedTools;
      current.requestTimeoutMs = args!.requestTimeoutMs;
    }
    states.set(service, current);
    return JSON.parse(JSON.stringify(current));
  });
  window.__TAURI__ = {
    invoke,
    dialog: { open: async () => "C:/Chosen/claude.exe" },
  } as unknown as NonNullable<Window["__TAURI__"]>;
});
afterEach(() => {
  cleanup();
  meta.remove();
  delete window.__TAURI__;
});

test("desktop starts and connects each mode, fills its version/token, and stops owned services", async () => {
  render(<Harness />);
  const start = await screen.findByRole("button", {
    name: Locale.RequestPlugins.Service.Start,
  });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await waitFor(() =>
    expect(screen.getByLabelText(fields.transportUrl.title)).toHaveValue(
      "http://127.0.0.1:51001",
    ),
  );
  expect(screen.getByLabelText(fields.transportToken.title)).toHaveValue(
    "wire-generated-secret-token",
  );
  expect(screen.queryByText("wire-generated-secret-token")).toBeNull();
  fireEvent.change(screen.getByLabelText(fields.mode.title), {
    target: { value: "cli" },
  });
  await screen.findByLabelText(Locale.RequestPlugins.Service.Executable);
  fireEvent.click(
    screen.getByRole("button", { name: Locale.RequestPlugins.Service.Browse }),
  );
  await waitFor(() =>
    expect(
      screen.getByLabelText(Locale.RequestPlugins.Service.Executable),
    ).toHaveValue("C:/Chosen/claude.exe"),
  );
  expect(invoke).toHaveBeenCalledWith("local_service_configure", {
    service: "claude-cli",
    executablePath: "C:/Chosen/claude.exe",
  });
  expect(states.get("claude-cli").running).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: Locale.RequestPlugins.Service.Start }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText(fields.nativeCliVersion.title)).toHaveValue(
      "2.1.400",
    ),
  );
  expect(invoke).toHaveBeenCalledWith("local_service_start", {
    service: "claude-cli",
    executablePath: "C:/Chosen/claude.exe",
  });
  expect(screen.getByLabelText(fields.bridgeToken.title)).toHaveValue(
    "claude-cli-generated-secret-token",
  );
  fireEvent.click(
    screen.getByRole("button", { name: Locale.RequestPlugins.Service.Stop }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: Locale.RequestPlugins.Service.Start }),
    ).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText(fields.mode.title), {
    target: { value: "http" },
  });
  expect(screen.getByLabelText(fields.transportToken.title)).toHaveValue(
    "wire-generated-secret-token",
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      Locale.RequestPlugins.Service.Stopped,
    ),
  );
});

test("web builds never invoke or offer local process management", () => {
  meta.content = JSON.stringify({ isApp: false });
  expect(supportsLocalServices()).toBe(false);
  render(<Harness />);
  expect(
    screen.queryByRole("button", { name: Locale.RequestPlugins.Service.Start }),
  ).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.getByLabelText(fields.transportUrl.title)).toBeInTheDocument();
});

test("a failed start leaves connection settings unchanged", async () => {
  invoke.mockImplementation(async (command) => {
    if (command === "local_service_start")
      throw new Error("Bundled helper unavailable");
    return {
      service: "wire",
      available: true,
      running: false,
      executablePath: "",
      canSelectExecutable: false,
    };
  });
  render(<Harness />);
  const start = await screen.findByRole("button", {
    name: Locale.RequestPlugins.Service.Start,
  });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Bundled helper unavailable",
  );
  expect(screen.getByLabelText(fields.transportToken.title)).toHaveValue("");
});

test("local service declarations cannot bind credentials to a non-secret field", () => {
  expect(() =>
    parsePluginPackage({
      ...pkg,
      manifest: {
        ...pkg.manifest,
        localServices: [
          { ...pkg.manifest.localServices![0], tokenField: "cliVersion" },
        ],
      },
    }),
  ).toThrow(/local service declaration/);
});

test("a late status response cannot overwrite a completed start", async () => {
  jest.useFakeTimers();
  try {
    render(<Harness />);
    await act(async () => {});
    const start = screen.getByRole("button", {
      name: Locale.RequestPlugins.Service.Start,
    });
    expect(start).toBeEnabled();
    let finish!: (value: any) => void;
    invoke.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    fireEvent.click(start);
    await act(async () => {});
    expect(screen.getByRole("status")).toHaveTextContent(
      Locale.RequestPlugins.Service.Running,
    );
    await act(async () =>
      finish({
        service: "wire",
        available: true,
        running: false,
        executablePath: "",
        canSelectExecutable: false,
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      Locale.RequestPlugins.Service.Running,
    );
  } finally {
    cleanup();
    jest.useRealTimers();
  }
});

test("switching modes during startup does not connect the previous mode", async () => {
  render(<Harness />);
  const start = screen.getByRole("button", {
    name: Locale.RequestPlugins.Service.Start,
  });
  await waitFor(() => expect(start).toBeEnabled());
  let finish!: (value: any) => void;
  invoke.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  fireEvent.click(start);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText(fields.mode.title), {
    target: { value: "cli" },
  });
  await screen.findByLabelText(Locale.RequestPlugins.Service.Executable);
  await act(async () =>
    finish({
      service: "wire",
      available: true,
      running: true,
      executablePath: "",
      canSelectExecutable: false,
      connection: { url: "http://127.0.0.1:51001", token: "late-token" },
    }),
  );
  expect(screen.getByLabelText(fields.mode.title)).toHaveValue("cli");
  expect(screen.getByLabelText(fields.bridgeToken.title)).toHaveValue("");
});

test("startup can be cancelled without waiting for the readiness response", async () => {
  let rejectStart!: (error: Error) => void;
  const implementation = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    if (command === "local_service_start")
      return new Promise((_, reject) => {
        rejectStart = reject;
      });
    if (command === "local_service_stop")
      rejectStart?.(new Error("startup cancelled"));
    return implementation(command, args);
  });
  render(<Harness />);
  const start = screen.getByRole("button", {
    name: Locale.RequestPlugins.Service.Start,
  });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await waitFor(() => expect(rejectStart).toBeDefined());
  fireEvent.click(
    screen.getByRole("button", {
      name: Locale.RequestPlugins.Service.CancelStart,
    }),
  );
  await waitFor(() => expect(start).toBeEnabled());
  expect(screen.getByLabelText(fields.transportToken.title)).toHaveValue("");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("CLI preapproval and request limit save without starting a service", async () => {
  render(<Harness />);
  fireEvent.change(screen.getByLabelText(fields.mode.title), {
    target: { value: "cli" },
  });
  const tools = await screen.findByLabelText(
    Locale.RequestPlugins.Service.AllowedTools,
  );
  fireEvent.change(tools, { target: { value: "Read,Bash,Write" } });
  fireEvent.blur(tools);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("local_service_options", {
      service: "claude-cli",
      allowedTools: "Read,Bash,Write",
      requestTimeoutMs: 0,
    }),
  );
  const timeout = screen.getByLabelText(Locale.RequestPlugins.Service.Timeout);
  fireEvent.change(timeout, { target: { value: "30" } });
  fireEvent.blur(timeout);
  await waitFor(() =>
    expect(states.get("claude-cli").requestTimeoutMs).toBe(1800000),
  );
  expect(
    invoke.mock.calls.some(([command]) => command === "local_service_start"),
  ).toBe(false);
});
