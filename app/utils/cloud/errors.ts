import Locale from "../../locales";
import { SyncError } from "./transport";

export function syncErrorMessage(
  error: unknown,
  messages = Locale.Settings.Sync.Errors,
) {
  if (!(error instanceof SyncError)) return messages.UNKNOWN;
  if (error.code === "HTTP") {
    const status = error.status!;
    const reason =
      status === 401
        ? messages.AUTH
        : status === 403
        ? messages.FORBIDDEN
        : [404, 409].includes(status)
        ? messages.PATH
        : [429, 503].includes(status)
        ? messages.BUSY
        : status >= 300 && status < 400
        ? messages.REDIRECT
        : messages.HTTP;
    return `${reason} (HTTP ${status})`;
  }
  return (messages as Record<string, string>)[error.code] ?? messages.UNKNOWN;
}
