import { StoreKey } from "../constant";
import type { McpConfigData } from "../mcp/types";
import { parseMcpConfig } from "../mcp/config";
import type { Plugin } from "../store/plugin";
import { merge } from "./merge";
import { AppState, mergeAppState, prepareImportedState } from "./sync";
import { parsePluginPackage } from "../request-plugins/schema";

export type PluginSnapshot = {
  plugins: Record<string, Plugin>;
  [key: string]: unknown;
};
export type SyncSnapshot = Record<string, any>;
export type Backup = Partial<AppState> & {
  [StoreKey.Plugin]?: PluginSnapshot;
  [StoreKey.Sync]?: SyncSnapshot;
  [StoreKey.Mcp]?: McpConfigData;
};
const unsafe = new Set(["__proto__", "constructor", "prototype"]);
const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function createBackup(
  local: AppState,
  plugins: PluginSnapshot,
  sync: SyncSnapshot,
  mcp?: McpConfigData,
): Backup {
  const {
    lastSyncTime: _time,
    lastProvider: _provider,
    _hasHydrated: _hydrated,
    ...syncSettings
  } = sync;
  return {
    ...local,
    [StoreKey.Plugin]: plugins,
    [StoreKey.Sync]: syncSettings,
    ...(mcp === undefined ? {} : { [StoreKey.Mcp]: parseMcpConfig(mcp) }),
  };
}

export function restoreBackup(
  local: AppState,
  raw: unknown,
  localPlugins: PluginSnapshot,
  localSync: SyncSnapshot,
) {
  if (!record(raw)) throw new Error("Invalid backup");
  const backup = raw as Backup;
  const beforeConfig = local[StoreKey.Config];
  const beforeAccess = local[StoreKey.Access];
  const { state, legacyApiSettings } = prepareImportedState(
    local,
    backup as AppState,
  );
  mergeAppState(local, state, {
    restoreDeletedSessions: true,
    restoreDeletedItems: true,
  });

  if (!legacyApiSettings && backup[StoreKey.Config] !== undefined) {
    const incoming = backup[StoreKey.Config];
    if (!record(incoming) || !Array.isArray(incoming.endpoints))
      throw new Error("Invalid backup configuration");
    const endpoints = new Map(
      beforeConfig.endpoints.map((endpoint) => [endpoint.id, endpoint]),
    );
    for (const endpoint of incoming.endpoints) {
      if (
        !record(endpoint) ||
        typeof endpoint.id !== "string" ||
        !endpoint.id ||
        unsafe.has(endpoint.id)
      )
        throw new Error("Invalid backup endpoint");
      endpoints.set(
        endpoint.id,
        endpoint as (typeof beforeConfig.endpoints)[number],
      );
    }
    local[StoreKey.Config] = merge(merge({}, beforeConfig), incoming);
    local[StoreKey.Config].endpoints = [...endpoints.values()];
    // Backups can carry executable packages. Only an identical, already
    // trusted local package may retain its enabled state on import.
    if (incoming.requestPlugins !== undefined) {
      if (!Array.isArray(incoming.requestPlugins))
        throw new Error("Invalid request plugins");
      const packages = new Map(
        (beforeConfig.requestPlugins ?? []).map((pkg) => [
          `${pkg.manifest.id}@${pkg.manifest.version}`,
          pkg,
        ]),
      );
      for (const entry of incoming.requestPlugins) {
        const pkg = parsePluginPackage({
          manifest: entry?.manifest,
          source: entry?.source,
        });
        const key = `${pkg.manifest.id}@${pkg.manifest.version}`;
        const existing = packages.get(key);
        if (
          existing &&
          (JSON.stringify(existing.manifest) !== JSON.stringify(pkg.manifest) ||
            existing.source !== pkg.source)
        )
          throw new Error(
            `Request plugin ${key} already exists with different contents`,
          );
        if (!existing) packages.set(key, { ...pkg, enabled: false });
      }
      local[StoreKey.Config].requestPlugins = [...packages.values()];
    }
    local[StoreKey.Config]._hasHydrated = beforeConfig._hasHydrated;
  }
  if (!legacyApiSettings && backup[StoreKey.Access] !== undefined) {
    if (!record(backup[StoreKey.Access]))
      throw new Error("Invalid backup access settings");
    local[StoreKey.Access] = merge(
      merge({}, beforeAccess),
      backup[StoreKey.Access],
    );
    local[StoreKey.Access]._hasHydrated = beforeAccess._hasHydrated;
  }

  let plugins = localPlugins;
  if (backup[StoreKey.Plugin] !== undefined) {
    const incoming = backup[StoreKey.Plugin];
    if (!record(incoming) || !record(incoming.plugins))
      throw new Error("Invalid backup plugins");
    const merged = { ...localPlugins.plugins };
    for (const [id, plugin] of Object.entries(incoming.plugins)) {
      if (!id || unsafe.has(id) || !record(plugin))
        throw new Error("Invalid backup plugin");
      merged[id] = plugin as Plugin;
    }
    plugins = { ...localPlugins, plugins: merged };
  }

  let sync = localSync;
  if (backup[StoreKey.Sync] !== undefined) {
    const incoming = backup[StoreKey.Sync];
    if (!record(incoming)) throw new Error("Invalid backup sync settings");
    const {
      lastSyncTime: _time,
      lastProvider: _provider,
      _hasHydrated: _hydrated,
      ...settings
    } = incoming;
    sync = merge(merge({}, localSync), settings);
    sync._hasHydrated = localSync._hasHydrated;
  }
  const mcp =
    backup[StoreKey.Mcp] === undefined
      ? undefined
      : parseMcpConfig(backup[StoreKey.Mcp]);
  return { local, plugins, sync, mcp, legacyApiSettings };
}

/** MCP approval can be declined independently of restoring the other stores. */
export async function applyRestoredBackup(
  restored: ReturnType<typeof restoreBackup>,
  applyMcp: (config: McpConfigData) => Promise<unknown>,
  applyLocal: (state: ReturnType<typeof restoreBackup>) => void,
) {
  let mcpSkipped = false;
  if (restored.mcp) {
    try {
      await applyMcp(restored.mcp);
    } catch {
      mcpSkipped = true;
    }
  }
  applyLocal(restored);
  return { mcpSkipped };
}
