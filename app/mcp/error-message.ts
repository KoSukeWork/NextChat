import Locale from "../locales";

/** Only translate known safe diagnostics; do not display arbitrary server text. */
export function localizedMcpError(
  error: unknown,
  fallback = Locale.Mcp.Errors.General,
  messages = Locale.Mcp.Errors,
) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const http = /^Remote MCP connection failed \(HTTP ([45]\d\d)\)$/.exec(
    message,
  );
  if (http) return messages.Http(http[1]);
  switch (message) {
    case "Remote MCP network request timed out":
      return messages.Timeout;
    case "Remote MCP network connection was refused":
      return messages.Refused;
    case "Remote MCP DNS lookup failed":
      return messages.Dns;
    case "Remote MCP TLS connection failed":
      return messages.Tls;
    case "Remote MCP network connection failed":
      return messages.Connect;
    case "Remote MCP network or protocol request failed":
      return messages.General;
    case "MCP configuration was not approved. No changes were saved.":
      return messages.Denied;
    case "Unauthorized MCP request":
      return messages.Unauthorized;
    case "MCP is not enabled":
      return messages.Disabled;
    case "MCP server disconnected":
      return messages.Disconnected;
    default:
      return fallback;
  }
}
