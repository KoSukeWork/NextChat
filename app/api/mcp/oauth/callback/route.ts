import { finishServerOAuth, oauthRuntime } from "@/app/mcp/oauth-server";
import { MCP_OAUTH_PATH } from "@/app/mcp/server-paths";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const success = await finishServerOAuth(
    oauthRuntime(MCP_OAUTH_PATH),
    new URL(request.url).searchParams,
  );
  const message = success
    ? "登录完成，可以关闭此页面。 / Login complete. You may close this page."
    : "登录未完成，请返回应用重试。 / Login was not completed. Please return to the app.";
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>NextChat</title><body><p>${message}</p><script>history.replaceState(null,'',location.pathname)</script></body></html>`,
    {
      status: success ? 200 : 400,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'none'; script-src 'sha256-UBodp8UhLR9ASBc1PNRKcs3r2CjAFWxCbrUGPN7u1jo='; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
