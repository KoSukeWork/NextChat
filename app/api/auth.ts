import md5 from "spark-md5";
import { ACCESS_CODE_PREFIX } from "../constant";

/** The relay requires the deployment code independently of the user's API key. */
export function hasValidAccessCode(request: Request): boolean {
  const codes = (process.env.CODE ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => md5.hash(value));
  if (!codes.length) return true;
  const token = (request.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const code = token.startsWith(ACCESS_CODE_PREFIX)
    ? token.slice(ACCESS_CODE_PREFIX.length)
    : "";
  return !!code && codes.includes(md5.hash(code.trim()));
}
