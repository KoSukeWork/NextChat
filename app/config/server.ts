import md5 from "spark-md5";
import { DEFAULT_GA_ID } from "../constant";

export const getServerSideConfig = () => {
  const codes = new Set(
    (process.env.CODE ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => md5.hash(value)),
  );
  return {
    needCode: codes.size > 0,
    codes,
    allowedWebDavEndpoints: (process.env.WHITE_WEBDAV_ENDPOINTS ?? "").split(
      ",",
    ),
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    cloudflareKVNamespaceId: process.env.CLOUDFLARE_KV_NAMESPACE_ID,
    cloudflareKVApiKey: process.env.CLOUDFLARE_KV_API_KEY,
    cloudflareKVTTL: process.env.CLOUDFLARE_KV_TTL,
    isVercel: !!process.env.VERCEL,
    gtmId: process.env.GTM_ID,
    gaId: process.env.GA_ID || DEFAULT_GA_ID,
  };
};
