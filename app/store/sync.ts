import { getClientConfig } from "../config/client";
import { ApiPath, STORAGE_KEY, StoreKey } from "../constant";
import { createPersistStore } from "../utils/store";
import {
  AppState,
  getLocalAppState,
  GetStoreState,
  setLocalAppState,
  CloudState,
  getCloudAppState,
  prepareCloudUpload,
  mergeCloudAppState,
  setCloudAppState,
  getNonFunctionFileds,
} from "../utils/sync";
import {
  applyRestoredBackup,
  createBackup,
  restoreBackup,
  PluginSnapshot,
} from "../utils/backup";
import { usePluginStore, FunctionToolService } from "./plugin";
import {
  getMcpConfigFromFile,
  isMcpEnabled,
  mergeMcpServers,
} from "../mcp/actions";
import { useAccessStore } from "./access";
import { downloadAs, readFromFile } from "../utils";
import { showConfirm, showToast } from "../components/ui-lib";
import Locale from "../locales";
import { createSyncClient, ProviderType } from "../utils/cloud";
import { SyncError } from "../utils/cloud/transport";
import { BackupWorker } from "../utils/backup-worker-client";
import type { McpConfigData } from "../mcp/types";

async function withBackupProgress<T>(
  message: string,
  work: () => Promise<T>,
): Promise<T> {
  const { showBackupProgress } = await import("../components/backup-dialog");
  const close = showBackupProgress(message);
  try {
    // Let React paint the status before sending or applying a large snapshot.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return await work();
  } finally {
    close();
  }
}

export interface WebDavConfig {
  server: string;
  username: string;
  password: string;
}

const isApp = !!getClientConfig()?.isApp;
export type SyncStore = GetStoreState<typeof useSyncStore>;

const DEFAULT_SYNC_STATE = {
  provider: ProviderType.WebDAV,
  useProxy: true,
  proxyUrl: ApiPath.Cors as string,

  webdav: {
    endpoint: "",
    username: "",
    password: "",
  },

  upstash: {
    endpoint: "",
    username: STORAGE_KEY,
    apiKey: "",
  },

  lastSyncTime: 0,
  lastProvider: "",
};

export const useSyncStore = createPersistStore(
  DEFAULT_SYNC_STATE,
  (set, get) => ({
    cloudSync() {
      const config = get()[get().provider];
      return Object.values(config).every((c) => c.toString().length > 0);
    },

    markSyncTime() {
      set({ lastSyncTime: Date.now(), lastProvider: get().provider });
    },

    async export() {
      try {
        let mcp: McpConfigData | undefined;
        try {
          if (await isMcpEnabled()) {
            mcp = await getMcpConfigFromFile(
              useAccessStore.getState().accessCode,
            );
          }
        } catch {
          if (!(await showConfirm(Locale.Settings.Sync.ExportWithoutMcp)))
            return false;
        }
        const { showBackupPassword } = await import(
          "../components/backup-dialog"
        );
        const password = await showBackupPassword("export");
        if (password === null) return false;
        const worker = new BackupWorker();
        let encrypted: string;
        try {
          encrypted = await withBackupProgress(
            Locale.Settings.Sync.Encrypting,
            async () => {
              const state = createBackup(
                getLocalAppState(),
                getNonFunctionFileds(
                  usePluginStore.getState(),
                ) as PluginSnapshot,
                getNonFunctionFileds(get()),
                mcp,
              );
              return worker.request<string>({
                type: "encrypt",
                data: state,
                password,
              });
            },
          );
        } finally {
          worker.close();
        }
        const datePart = isApp
          ? `${new Date().toLocaleDateString().replace(/\//g, "_")} ${new Date()
              .toLocaleTimeString()
              .replace(/:/g, "_")}`
          : new Date().toLocaleString();
        return await downloadAs(encrypted, `Backup-${datePart}.json`);
      } catch {
        showToast(Locale.Settings.Sync.ExportFailed);
        return false;
      }
    },

    async import() {
      try {
        const rawContent = await readFromFile();
        const worker = new BackupWorker();
        let remote: unknown;
        try {
          const opened = await withBackupProgress(
            Locale.Settings.Sync.Decrypting,
            () =>
              worker.request<{ encrypted: boolean; backup?: unknown }>({
                type: "open",
                text: rawContent,
              }),
          );
          if (opened.encrypted) {
            const { showBackupPassword } = await import(
              "../components/backup-dialog"
            );
            let retry = false;
            while (true) {
              const password = await showBackupPassword("import", retry);
              if (password === null) return;
              try {
                remote = await withBackupProgress(
                  Locale.Settings.Sync.Decrypting,
                  () => worker.request({ type: "decrypt", password }),
                );
                break;
              } catch (error) {
                if (
                  !(error instanceof Error) ||
                  error.message !== "AUTH_FAILED"
                )
                  throw error;
                retry = true;
              }
            }
          } else {
            remote = opened.backup;
          }
        } finally {
          worker.close();
        }
        if (!(await showConfirm(Locale.Settings.Sync.ImportConfirm))) return;
        const { restored, mcpSkipped } = await withBackupProgress(
          Locale.Settings.Sync.Restoring,
          async () => {
            const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
            const restored = restoreBackup(
              clone(getLocalAppState()),
              remote,
              clone(
                getNonFunctionFileds(usePluginStore.getState()),
              ) as PluginSnapshot,
              clone(getNonFunctionFileds(get())),
            );
            const { mcpSkipped } = await applyRestoredBackup(
              restored,
              async (mcp) => {
                if (!(await isMcpEnabled())) throw new Error("MCP unavailable");
                await mergeMcpServers(
                  mcp,
                  restored.local[StoreKey.Access].accessCode,
                );
              },
              (state) => {
                setLocalAppState(state.local);
                usePluginStore.setState(state.plugins);
                FunctionToolService.tools = {};
                set(state.sync);
              },
            );
            return { restored, mcpSkipped };
          },
        );
        const notices = [
          restored.legacyApiSettings ? Locale.EndpointConfig.LegacyImport : "",
          mcpSkipped ? Locale.Settings.Sync.McpNotImported : "",
        ].filter(Boolean);
        showToast(
          notices.length
            ? notices.join(" ")
            : Locale.Settings.Sync.ImportSuccess,
          undefined,
          notices.length ? 10000 : undefined,
        );
      } catch (error) {
        showToast(
          error instanceof Error && error.message === "INVALID_BACKUP"
            ? Locale.Settings.Sync.InvalidEncryptedBackup
            : Locale.Settings.Sync.ImportFailed,
        );
      }
    },

    getClient() {
      const provider = get().provider;
      const client = createSyncClient(provider, get());
      return client;
    },

    async sync() {
      // Merge into a snapshot; a failed PUT must not mutate live local state.
      const localState = JSON.parse(
        JSON.stringify(getCloudAppState()),
      ) as CloudState;
      const provider = get().provider;
      const config = get()[provider];
      const client = this.getClient();

      await client.prepare?.();
      const remoteState = await client.get(config.username);
      if (remoteState) {
        let parsedRemoteState: AppState;
        try {
          parsedRemoteState = JSON.parse(remoteState);
          if (
            !parsedRemoteState ||
            typeof parsedRemoteState !== "object" ||
            Array.isArray(parsedRemoteState)
          )
            throw new Error();
          mergeCloudAppState(localState, parsedRemoteState);
        } catch {
          throw new SyncError("INVALID_JSON");
        }
      }

      await client.set(
        config.username,
        JSON.stringify(prepareCloudUpload(localState)),
      );
      if (remoteState) {
        // The user may have edited or deleted a session while the network
        // request was in flight. Merge the uploaded snapshot into the latest
        // local state so a successful PUT cannot undo those newer changes.
        const latestState = JSON.parse(
          JSON.stringify(getCloudAppState()),
        ) as CloudState;
        mergeCloudAppState(latestState, localState);
        setCloudAppState(latestState);
      }
      this.markSyncTime();
    },

    async check() {
      const client = this.getClient();
      return await client.check();
    },
  }),
  {
    name: StoreKey.Sync,
    version: 1.2,

    migrate(persistedState, version) {
      const newState = persistedState as typeof DEFAULT_SYNC_STATE;

      if (version < 1.1) {
        newState.upstash.username = STORAGE_KEY;
      }

      if (version < 1.2) {
        if (
          (persistedState as typeof DEFAULT_SYNC_STATE).proxyUrl ===
          "/api/cors/"
        ) {
          newState.proxyUrl = "";
        }
      }

      return newState as any;
    },
  },
);
