/** @jest-environment node */
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  McpOAuthProvider,
  OAuthLoginNeeded,
  type OAuthCredentials,
} from "../app/mcp/oauth";

const base = "http://127.0.0.1:45670";
const serverUrl = `${base}/mcp`;
const redirectUri = "http://127.0.0.1:45671/callback";
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("SDK dynamically registers, uses PKCE and state, exchanges and refreshes credentials", async () => {
  const calls: { url: string; method: string; body: string }[] = [];
  let stored: OAuthCredentials = { serverUrl, redirectUri };
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: String(init?.body ?? ""),
    });
    if (url.includes("oauth-protected-resource"))
      return response({ resource: serverUrl, authorization_servers: [base] });
    if (url.includes("oauth-authorization-server"))
      return response({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.endsWith("/register"))
      return response(
        { client_id: "test-client", redirect_uris: [redirectUri] },
        201,
      );
    if (url.endsWith("/token"))
      return response({
        access_token: "synthetic-access",
        token_type: "Bearer",
        refresh_token: "synthetic-refresh",
      });
    return response({}, 404);
  };
  const save = async (value: OAuthCredentials) => {
    stored = structuredClone(value);
  };
  const provider = new McpOAuthProvider(
    stored,
    save,
    true,
    "random-test-state",
  );
  expect(await auth(provider, { serverUrl, fetchFn })).toBe("REDIRECT");
  const target = provider.takeAuthorizationUrl()!;
  expect(target.searchParams.get("state")).toBe("random-test-state");
  expect(target.searchParams.get("redirect_uri")).toBe(redirectUri);
  expect(target.searchParams.get("code_challenge_method")).toBe("S256");
  expect(calls.filter((call) => call.url.endsWith("/register"))).toHaveLength(
    1,
  );
  expect(
    await auth(provider, {
      serverUrl,
      authorizationCode: "synthetic-code",
      fetchFn,
    }),
  ).toBe("AUTHORIZED");
  expect(stored.tokens?.access_token).toBe("synthetic-access");
  const tokenRequest = calls.find((call) => call.url.endsWith("/token"))!;
  const form = new URLSearchParams(tokenRequest.body);
  expect(form.get("code")).toBe("synthetic-code");
  expect(form.get("code_verifier")).toBeTruthy();
  expect(form.get("redirect_uri")).toBe(redirectUri);

  const background = new McpOAuthProvider(stored, save, false);
  expect(await auth(background, { serverUrl, fetchFn })).toBe("AUTHORIZED");
  const refreshed = calls.filter((call) => call.url.endsWith("/token")).at(-1)!;
  expect(new URLSearchParams(refreshed.body).get("grant_type")).toBe(
    "refresh_token",
  );
  expect(calls.filter((call) => call.url.endsWith("/register"))).toHaveLength(
    1,
  );
});

test("background authorization cannot register or initiate a browser redirect", async () => {
  const provider = new McpOAuthProvider(
    { serverUrl, redirectUri },
    async () => {},
    false,
  );
  expect(provider.saveClientInformation).toBeUndefined();
  expect(() =>
    provider.redirectToAuthorization(new URL(`${base}/authorize`)),
  ).toThrow(OAuthLoginNeeded);
  expect(() => provider.state()).toThrow(OAuthLoginNeeded);
});

test("interactive authorization rejects non-http URLs", () => {
  const provider = new McpOAuthProvider(
    { serverUrl, redirectUri },
    async () => {},
    true,
    "state",
  );
  expect(() =>
    provider.redirectToAuthorization(new URL("file:///tmp/test")),
  ).toThrow("Invalid OAuth URL");
  expect(() =>
    provider.redirectToAuthorization(
      new URL("https://user:secret@example.test"),
    ),
  ).toThrow("Invalid OAuth URL");
});
