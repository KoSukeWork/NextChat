import Locale from "../locales";
import { getClientConfig } from "../config/client";
import { Path } from "../constant";

// The legacy Unauthorized translations contain a hosted-service promotion.
// Use existing configuration labels without changing locale keys or translations.
export function getUnauthorizedMessage() {
  const settings = `[${Locale.Settings.Title}](/#${Path.Settings})`;
  if (getClientConfig()?.isApp) {
    return `${Locale.Auth.SubTips}\n\n${settings}`;
  }
  return `${Locale.Auth.Tips}\n\n[${Locale.Auth.Title}](/#${Path.Auth})\n\n${Locale.Auth.SubTips}\n\n${settings}`;
}
