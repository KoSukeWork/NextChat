import Locale from "../locales";

/** Native bridge failures use 599 and an internal code, never raw network details. */
export function nativeNetworkErrorMessage(body: string): string {
  const messages = Locale.Settings.Sync.Errors;
  switch (body.trim()) {
    case "NETWORK_DNS":
      return messages.NETWORK_DNS;
    case "NETWORK_TLS":
      return messages.NETWORK_TLS;
    case "NETWORK_TIMEOUT":
      return messages.NETWORK_TIMEOUT;
    case "NETWORK_REFUSED":
      return messages.NETWORK_REFUSED;
    case "NETWORK_CONNECT":
      return messages.NETWORK_CONNECT;
    default:
      return messages.NETWORK_FAILED;
  }
}
