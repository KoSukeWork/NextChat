import Locale from "../locales";
import { getClientConfig } from "../config/client";
import { Path } from "../constant";

export function getUnauthorizedMessage() {
  const settings = `[${Locale.Settings.Title}](/#${Path.Settings})`;
  if (getClientConfig()?.isApp) {
    return `${Locale.ModelDiscovery.ConfigureFirst}\n\n${settings}`;
  }
  return `${Locale.Auth.Tips}\n\n[${Locale.Auth.Title}](/#${Path.Auth})\n\n${settings}`;
}
