import { McpConfigData, ServerConfig } from "./types";

const invalid = () => new Error("Invalid MCP server configuration");
const unsafeNames = new Set(["__proto__", "constructor", "prototype"]);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function strings(value: unknown, headers = false): Record<string, string> {
  if (!object(value)) throw invalid();
  const entries = Object.entries(value);
  for (const [key, item] of entries) {
    if (
      !key ||
      unsafeNames.has(key) ||
      typeof item !== "string" ||
      key.includes("\0") ||
      item.includes("\0") ||
      (headers &&
        (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(item))) ||
      (!headers && key.includes("="))
    )
      throw invalid();
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export function parseMcpConfig(value: unknown): McpConfigData {
  if (
    !object(value) ||
    !object(value.mcpServers) ||
    Object.keys(value).some((k) => k !== "mcpServers")
  )
    throw invalid();
  const entries: [string, ServerConfig][] = [];
  for (const [id, raw] of Object.entries(value.mcpServers)) {
    if (!id.trim() || unsafeNames.has(id) || !object(raw)) throw invalid();
    const status = raw.status === null ? undefined : raw.status;
    if (
      status !== undefined &&
      status !== "active" &&
      status !== "paused" &&
      status !== "error"
    )
      throw invalid();
    if (typeof raw.url === "string") {
      if (
        Object.keys(raw).some((k) => !["url", "headers", "status"].includes(k))
      )
        throw invalid();
      try {
        const url = new URL(raw.url);
        if (url.protocol !== "http:" && url.protocol !== "https:")
          throw invalid();
      } catch {
        throw invalid();
      }
      entries.push([
        id,
        {
          url: raw.url,
          ...(raw.headers === undefined
            ? {}
            : { headers: strings(raw.headers, true) }),
          ...(status === undefined ? {} : { status }),
        },
      ]);
    } else {
      if (
        Object.keys(raw).some(
          (k) => !["command", "args", "env", "status"].includes(k),
        ) ||
        typeof raw.command !== "string" ||
        !raw.command.trim() ||
        raw.command.includes("\0")
      )
        throw invalid();
      const args = raw.args === undefined ? [] : raw.args;
      if (
        !Array.isArray(args) ||
        !args.every((arg) => typeof arg === "string" && !arg.includes("\0"))
      )
        throw invalid();
      entries.push([
        id,
        {
          command: raw.command,
          args,
          ...(raw.env === undefined ? {} : { env: strings(raw.env) }),
          ...(status === undefined ? {} : { status }),
        },
      ]);
    }
  }
  return { mcpServers: Object.fromEntries(entries) };
}

/** Normalize third-party examples only at the paste boundary; persisted data stays strict. */
export function parsePastedMcpConfig(value: unknown): McpConfigData {
  if (!object(value) || !object(value.mcpServers)) throw invalid();
  const entries = Object.entries(value.mcpServers).map(([id, raw]) => {
    if (!object(raw) || ("url" in raw && "command" in raw)) throw invalid();
    const status = raw.disabled === true ? "paused" : raw.status;
    const server =
      "url" in raw
        ? {
            url: raw.url,
            ...(raw.headers === undefined ? {} : { headers: raw.headers }),
          }
        : {
            command: raw.command,
            ...(raw.args === undefined ? {} : { args: raw.args }),
            ...(raw.env === undefined ? {} : { env: raw.env }),
          };
    return [id, { ...server, ...(status === undefined ? {} : { status }) }];
  });
  return parseMcpConfig({ mcpServers: Object.fromEntries(entries) });
}
