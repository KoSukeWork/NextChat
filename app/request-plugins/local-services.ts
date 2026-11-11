import { getClientConfig } from "../config/client";

export interface LocalServiceConnection {
  url: string;
  token: string;
  cliVersion?: string | null;
}
export interface LocalServiceStatus {
  service: string;
  available: boolean;
  running: boolean;
  pid?: number | null;
  executablePath: string;
  canSelectExecutable: boolean;
  connection?: LocalServiceConnection | null;
  error?: string | null;
}

export function supportsLocalServices() {
  return (
    !!getClientConfig()?.isApp &&
    typeof window !== "undefined" &&
    !!window.__TAURI__?.invoke
  );
}

export async function localServiceAction(
  action: "status" | "start" | "stop",
  service: string,
  executablePath?: string,
): Promise<LocalServiceStatus> {
  if (!supportsLocalServices())
    throw new Error("Local services require the desktop app");
  try {
    return await window.__TAURI__!.invoke(`local_service_${action}`, {
      service,
      ...(action === "start" ? { executablePath: executablePath ?? null } : {}),
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function chooseServiceExecutable() {
  if (!supportsLocalServices())
    throw new Error("Local services require the desktop app");
  const dialog = window.__TAURI__!.dialog;
  if (!dialog?.open) throw new Error("Native file selection is unavailable");
  const selected = await dialog.open({
    multiple: false,
    directory: false,
    filters: [{ name: "Executable", extensions: ["exe"] }],
  });
  return typeof selected === "string" ? selected : undefined;
}
