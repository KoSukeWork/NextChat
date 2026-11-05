import Locale from "../app/locales";
import { nativeNetworkErrorMessage } from "../app/utils/network-error";

test.each([
  "NETWORK_DNS",
  "NETWORK_TLS",
  "NETWORK_TIMEOUT",
  "NETWORK_REFUSED",
  "NETWORK_CONNECT",
  "NETWORK_FAILED",
] as const)("native %s is mapped to a readable localized message", (code) => {
  expect(nativeNetworkErrorMessage(code)).toBe(
    Locale.Settings.Sync.Errors[code],
  );
});

test("unknown native failures, including secret text, get a generic message", () => {
  expect(nativeNetworkErrorMessage("Network request failed")).toBe(
    Locale.Settings.Sync.Errors.NETWORK_FAILED,
  );
  expect(nativeNetworkErrorMessage("NETWORK_REFUSED secret-key")).toBe(
    Locale.Settings.Sync.Errors.NETWORK_FAILED,
  );
});
