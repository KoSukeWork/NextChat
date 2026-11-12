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

const { ClaudeCliControl } = await import(
  "../app/components/claude-cli-control"
);
const Locale = (await import("../app/locales")).default;

afterEach(() => {
  cleanup();
  delete (window as any).__TAURI__;
});

test("a delayed status cannot overwrite edits and saves are serialized", async () => {
  let resolveStatus!: (value: unknown) => void;
  const status = {
    executablePath: "C:\\old\\claude.exe",
    cliVersion: "1.2.3",
    allowedTools: "Read",
    requestTimeoutMs: 0,
  };
  const invoke = jest.fn<(command: string, args?: any) => Promise<any>>(
    (command, args) => {
      if (command === "claude_cli_status")
        return new Promise((resolve) => {
          resolveStatus = resolve;
        });
      if (command === "claude_cli_configure")
        return Promise.resolve({
          ...status,
          executablePath: args.executablePath,
        });
      return Promise.resolve({
        ...status,
        executablePath: "C:\\new\\claude.exe",
        allowedTools: args.allowedTools,
        requestTimeoutMs: args.requestTimeoutMs,
      });
    },
  );
  (window as any).__TAURI__ = { invoke };
  render(<ClaudeCliControl />);
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  const path = screen.getByLabelText(Locale.RequestPlugins.Service.Executable);
  const tools = screen.getByLabelText(
    Locale.RequestPlugins.Service.AllowedTools,
  );
  fireEvent.change(path, { target: { value: "C:\\new\\claude.exe" } });
  fireEvent.blur(path);
  fireEvent.change(tools, { target: { value: "Read,Grep" } });
  fireEvent.blur(tools);
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolveStatus(status);
  });
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "claude_cli_status",
    "claude_cli_configure",
    "claude_cli_options",
  ]);
  expect(path).toHaveValue("C:\\new\\claude.exe");
  expect(tools).toHaveValue("Read,Grep");
});
