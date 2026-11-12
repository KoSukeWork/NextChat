import bundled from "../../public/request-plugins/nextchat.claude-code-4.0.0.json";
import type { Endpoint } from "../utils/endpoints";
import { parsePluginPackage } from "./schema";
import type { InstalledRequestPlugin, RequestPluginBinding } from "./schema";

export const CLAUDE_PLUGIN_ID = "nextchat.claude-code";
export const CLAUDE_PLUGIN_VERSION = "4.0.0";

export function isLegacyClaudePlugin(id: unknown, version: unknown) {
  if (id !== CLAUDE_PLUGIN_ID || typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(version);
  if (!match) return false;
  return (
    Number(match[1]) < 4 ||
    (Number(match[1]) === 4 &&
      Number(match[2]) === 0 &&
      Number(match[3]) === 0 &&
      !!match[4])
  );
}

function generatedLocalConnection(url: string, token: string) {
  try {
    const address = new URL(url);
    return (
      address.protocol === "http:" &&
      address.hostname === "127.0.0.1" &&
      Number(address.port) >= 49152 &&
      address.pathname === "/" &&
      !address.username &&
      !address.password &&
      !address.search &&
      !address.hash &&
      /^[a-f0-9]{64}$/.test(token)
    );
  } catch {
    return false;
  }
}

function migrateBinding(
  binding: RequestPluginBinding,
  previous?: InstalledRequestPlugin,
): RequestPluginBinding {
  const old = binding.config ?? {};
  const modeField = previous?.manifest.fields.mode;
  const mode =
    old.mode ||
    modeField?.default ||
    (binding.version.startsWith("1.") ? "cli" : "http");
  const http = mode !== "cli";
  const explicit = binding.localServices?.["claude-cli"];
  const url = old.bridgeUrl || "";
  const token = old.bridgeToken || "";
  const external =
    !http &&
    (explicit === "external" ||
      (explicit !== "managed" &&
        !!token &&
        !generatedLocalConnection(url, token)));
  const config: Record<string, string> = {
    connection: external ? "external" : "builtin",
    authType: old.authType === "bearer" ? "bearer" : "api-key",
    nativeBeta:
      old.nativeBeta ||
      (binding.version.startsWith("1.") && mode === "cli" ? old.beta : "") ||
      "",
    nativeEffort: old.nativeEffort || (mode === "cli" ? old.effort : "") || "",
    nativeCliVersion:
      old.nativeCliVersion ||
      (binding.version.startsWith("1.") && mode === "cli"
        ? old.cliVersion
        : "") ||
      "2.1.322",
  };
  if (external) {
    config.bridgeUrl = url;
    config.bridgeToken = token;
  }
  return {
    id: CLAUDE_PLUGIN_ID,
    version: CLAUDE_PLUGIN_VERSION,
    config,
    ...(http ? { migrationNotice: "http-removed" as const } : {}),
  };
}

/** Safe to rerun after hydration or backup import; never changes endpoint credentials. */
export function migrateClaudeConfiguration(
  endpoints: Endpoint[],
  packages: InstalledRequestPlugin[],
) {
  const old = packages.filter((pkg) =>
    isLegacyClaudePlugin(pkg.manifest.id, pkg.manifest.version),
  );
  const bound = endpoints.some((endpoint) =>
    isLegacyClaudePlugin(
      endpoint.requestPlugin?.id,
      endpoint.requestPlugin?.version,
    ),
  );
  if (!old.length && !bound) return { endpoints, packages };
  const migrated = endpoints.map((endpoint) => {
    const binding = endpoint.requestPlugin;
    if (!binding || !isLegacyClaudePlugin(binding.id, binding.version))
      return endpoint;
    const previous = old.find(
      (pkg) => pkg.manifest.version === binding.version,
    );
    return { ...endpoint, requestPlugin: migrateBinding(binding, previous) };
  });
  const retained = packages.filter(
    (pkg) => !isLegacyClaudePlugin(pkg.manifest.id, pkg.manifest.version),
  );
  if (
    !retained.some(
      (pkg) =>
        pkg.manifest.id === CLAUDE_PLUGIN_ID &&
        pkg.manifest.version === CLAUDE_PLUGIN_VERSION,
    )
  ) {
    retained.push({
      ...parsePluginPackage(bundled),
      enabled: old.length ? old.some((pkg) => pkg.enabled) : true,
    });
  }
  return { endpoints: migrated, packages: retained };
}
