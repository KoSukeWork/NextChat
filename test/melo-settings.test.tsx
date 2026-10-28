import React, { useState } from "react";
import { jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
let Locale: typeof import("../app/locales").default;
import { DEFAULT_LOCAL_TTS } from "../app/utils/local-tts";
import type { MeloModelStatus } from "../app/utils/melo-client";

let ConfigList: typeof import("../app/components/tts-config").TTSConfigList;
// Next/Jest treats SVGs as image objects; production uses SVGR components.
jest.unstable_mockModule("../app/icons/down.svg", () => ({
  default: () => <svg aria-hidden="true" />,
}));
beforeAll(async () => {
  await import("../app/client/api");
  Locale = (await import("../app/locales")).default;
  ConfigList = (await import("../app/components/tts-config")).TTSConfigList;
});
const originals = [
  "__TAURI__",
  "speechSynthesis",
  "SpeechSynthesisUtterance",
].map((name) => [name, Object.getOwnPropertyDescriptor(window, name)] as const);
let status: MeloModelStatus;
let event: ((value: { payload: MeloModelStatus }) => void) | undefined;
let invoke: ReturnType<
  typeof jest.fn<
    (command: string, args?: Record<string, unknown>) => Promise<unknown>
  >
>;
beforeEach(() => {
  status = {
    phase: "missing",
    downloaded: 0,
    total: 167006755,
    size: 0,
    error: null,
    operationId: null,
    revision: 0,
  };
  event = undefined;
  invoke = jest.fn(async (command) => {
    if (command === "melo_status") return status;
    if (command === "melo_download")
      return { ...status, phase: "downloading", operationId: 1, revision: 1 };
    if (command === "melo_cancel_install") {
      event?.({
        payload: {
          ...status,
          phase: "missing",
          operationId: null,
          revision: 3,
        },
      });
    }
    return undefined;
  });
  const synthesis = Object.assign(new EventTarget(), {
    getVoices: () => [
      { name: "Local", voiceURI: "local", lang: "en-US", localService: true },
    ],
    cancel: jest.fn(),
  });
  for (const [name, value] of Object.entries({
    __TAURI__: {
      invoke,
      event: {
        listen: async (_name: string, callback: typeof event) => {
          event = callback;
          return () => {
            event = undefined;
          };
        },
      },
    },
    speechSynthesis: synthesis,
    SpeechSynthesisUtterance: class {},
  }))
    Object.defineProperty(window, name, { configurable: true, value });
});
afterEach(() => {
  cleanup();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(window, name, descriptor);
    else Reflect.deleteProperty(window, name);
  }
});
function Settings({ engine = "system" }: { engine?: "system" | "melo" }) {
  const [config, setConfig] = useState({ ...DEFAULT_LOCAL_TTS, engine });
  return (
    <ConfigList
      ttsConfig={config}
      updateConfig={(update) =>
        setConfig((current) => {
          const next = { ...current };
          update(next);
          return next;
        })
      }
    />
  );
}

test("desktop engine switch hides system-only controls and exposes model management", async () => {
  render(<Settings />);
  const engine = await screen.findByRole("combobox", {
    name: Locale.Settings.TTS.Engine,
  });
  expect(
    screen.getByRole("slider", { name: Locale.Settings.TTS.Pitch }),
  ).toBeTruthy();
  fireEvent.change(engine, { target: { value: "melo" } });
  await screen.findByRole("button", {
    name: Locale.Settings.TTS.Melo.Download,
  });
  expect(
    screen.queryByRole("slider", { name: Locale.Settings.TTS.Pitch }),
  ).toBeNull();
  expect(
    screen.queryByRole("combobox", { name: Locale.Settings.TTS.LocalVoice }),
  ).toBeNull();
  expect(
    screen.getByRole("slider", { name: Locale.Settings.TTS.Rate }),
  ).toBeTruthy();
  fireEvent.change(engine, { target: { value: "system" } });
  expect(
    screen.getByRole("slider", { name: Locale.Settings.TTS.Pitch }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: Locale.Settings.TTS.Melo.Download }),
  ).toBeNull();
});

test("download progress can be cancelled and older events cannot overwrite readiness", async () => {
  render(<Settings engine="melo" />);
  const download = await screen.findByRole("button", {
    name: Locale.Settings.TTS.Melo.Download,
  });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("melo_status", undefined),
  );
  fireEvent.click(download);
  await screen.findByRole("progressbar");
  act(
    () =>
      event?.({
        payload: {
          ...status,
          phase: "downloading",
          downloaded: 100,
          operationId: 1,
          revision: 2,
        },
      }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: Locale.Settings.TTS.Melo.Cancel }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("melo_cancel_install", {
      operationId: 1,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
  act(
    () =>
      event?.({
        payload: { ...status, phase: "ready", size: 191246256, revision: 5 },
      }),
  );
  act(
    () =>
      event?.({
        payload: {
          ...status,
          phase: "downloading",
          operationId: 1,
          revision: 4,
        },
      }),
  );
  expect(screen.getByRole("status").textContent).toContain(
    Locale.Settings.TTS.Melo.Ready("182.4"),
  );
  expect(screen.queryByRole("progressbar")).toBeNull();
});

test("Web renders system controls only, even for imported Melo settings", async () => {
  Reflect.deleteProperty(window, "__TAURI__");
  render(<Settings engine="melo" />);
  await screen.findByRole("slider", { name: Locale.Settings.TTS.Pitch });
  expect(
    screen.queryByRole("combobox", { name: Locale.Settings.TTS.Engine }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: Locale.Settings.TTS.Melo.Import }),
  ).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});
