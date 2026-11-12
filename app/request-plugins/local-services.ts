import { getClientConfig } from "../config/client";

export function supportsLocalServices() {
  return (
    !!getClientConfig()?.isApp &&
    typeof window !== "undefined" &&
    !!window.__TAURI__?.invoke
  );
}

export async function chooseServiceExecutable() {
  if (!supportsLocalServices())
    throw new Error("The built-in CLI requires the desktop app");
  const dialog = window.__TAURI__!.dialog;
  if (!dialog?.open) throw new Error("Native file selection is unavailable");
  const selected = await dialog.open({
    multiple: false,
    directory: false,
    filters: [{ name: "Executable", extensions: ["exe"] }],
  });
  return typeof selected === "string" ? selected : undefined;
}
