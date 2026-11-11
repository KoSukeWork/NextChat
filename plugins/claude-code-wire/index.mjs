import { prepareRequest as prepareHttpRequest } from "../claude-code/index.mjs";

const profile = "bun-1.4.4-38afee6c8-win32-x64";
const headerNames = {
  accept: "Accept",
  "content-type": "Content-Type",
  "user-agent": "User-Agent",
  "x-claude-code-session-id": "X-Claude-Code-Session-Id",
  "x-stainless-arch": "X-Stainless-Arch",
  "x-stainless-lang": "X-Stainless-Lang",
  "x-stainless-os": "X-Stainless-OS",
  "x-stainless-package-version": "X-Stainless-Package-Version",
  "x-stainless-retry-count": "X-Stainless-Retry-Count",
  "x-stainless-runtime": "X-Stainless-Runtime",
  "x-stainless-runtime-version": "X-Stainless-Runtime-Version",
  "x-stainless-timeout": "X-Stainless-Timeout",
};

export function prepareRequest(request, context) {
  if (
    (context.config.profile !== "custom" &&
      context.config.cliVersion !== "2.1.322") ||
    context.config.platform !== "Windows" ||
    context.config.arch !== "x64"
  )
    throw new Error(
      "The captured profile requires CLI 2.1.322 on Windows x64. Custom version markers require the Custom profile; the independent Windows x64 network runtime remains pinned.",
    );
  const wire = prepareHttpRequest(request, context);
  const overrides = JSON.parse(context.config.headerOverrides || "{}");
  const spelling = Object.fromEntries(
    Object.keys(overrides).map((name) => [name.toLowerCase(), name]),
  );
  wire.headers = Object.fromEntries(
    Object.entries(wire.headers).map(([name, value]) => [
      spelling[name] || headerNames[name] || name,
      value,
    ]),
  );
  if (wire.body) {
    // JSON object order survives the opaque relay envelope. Preserve unknown
    // caller fields after known fields instead of silently deleting them.
    const keys = [
      "model",
      "messages",
      "system",
      "tools",
      "metadata",
      "max_tokens",
      "thinking",
      "context_management",
      "safeguards",
      "output_config",
      "stream",
    ];
    wire.body = Object.fromEntries([
      ...keys
        .filter((key) => Object.hasOwn(wire.body, key))
        .map((key) => [key, wire.body[key]]),
      ...Object.entries(wire.body).filter(([key]) => !keys.includes(key)),
    ]);
  }
  return { ...wire, transport: { profile } };
}
