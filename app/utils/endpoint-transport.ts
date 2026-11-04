import { fetch as nativeFetch } from "./stream";
import { ACCESS_CODE_PREFIX, Path } from "../constant";

/** Desktop requests use native streaming; web requests use the same-origin relay. */
export async function endpointFetch(url: string, options: RequestInit = {}) {
  if (typeof window !== "undefined" && window.__TAURI__) {
    return nativeFetch(url, options);
  }
  const headers = Object.fromEntries(new Headers(options.headers).entries());
  const { useAccessStore } = await import("../store/access");
  const code = useAccessStore.getState().accessCode;
  const response = await fetch(`/api/endpoint?url=${encodeURIComponent(url)}`, {
    ...options,
    headers: {
      "x-endpoint-headers": encodeURIComponent(JSON.stringify(headers)),
      authorization: `Bearer ${ACCESS_CODE_PREFIX}${code}`,
    },
  });
  if (
    response.status === 401 &&
    response.headers.get("x-nextchat-auth-error") === "1"
  ) {
    window.location.hash = `#${Path.Auth}`;
  }
  return response;
}
