// The app ships Tauri v1. Its global API is also used by utils/stream.ts;
// importing the installed v2 JS API would require a different IPC runtime.
export function isTauri() {
  return typeof window !== "undefined" && !!window.__TAURI__;
}

export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) throw new Error("Desktop MCP requires the Tauri app.");
  try {
    return await window.__TAURI__!.invoke(command, args);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  if (!isTauri()) throw new Error("Desktop MCP requires the Tauri app.");
  return window.__TAURI__!.event.listen(event, handler);
}
