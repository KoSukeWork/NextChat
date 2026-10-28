import { invoke, isTauri, listen } from "../mcp/tauri-api";

export type MeloModelStatus = {
  phase:
    | "missing"
    | "downloading"
    | "verifying"
    | "ready"
    | "deleting"
    | "error";
  downloaded: number;
  total: number;
  size: number;
  error: string | null;
  operationId: number | null;
  revision: number;
};

export const isMeloDesktop = isTauri;
export const meloClient = {
  status: () => invoke<MeloModelStatus>("melo_status"),
  download: () => invoke<MeloModelStatus>("melo_download"),
  importModel: () => invoke<MeloModelStatus | null>("melo_import"),
  deleteModel: () => invoke<MeloModelStatus>("melo_delete"),
  cancelInstall: (operationId: number) =>
    invoke<void>("melo_cancel_install", { operationId }),
  subscribe: (handler: (status: MeloModelStatus) => void) =>
    listen<MeloModelStatus>("melo-model-status", ({ payload }) =>
      handler(payload),
    ),
  begin: () => invoke<number>("melo_begin_speech"),
  cancel: (session: number) => invoke<void>("melo_cancel_speech", { session }),
  synthesize: (session: number, text: string, speed: number) =>
    invoke<string>("melo_synthesize", { session, text, speed }),
};

export function meloErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(":", 1)[0];
}
