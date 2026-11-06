/** @jest-environment node */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeFetch } from "../jest.setup";
import { createRemoteClient } from "../app/mcp/remote";
import {
  OAuthLoginNeeded,
  OAuthPreRegisteredClientRequired,
} from "../app/mcp/oauth";
import {
  backgroundServerOAuth,
  beginServerOAuth,
  finishServerOAuth,
  invalidateServerOAuth,
  oauthRuntime,
} from "../app/mcp/oauth-server";
import { createMock } from "./fixtures/mcp-oauth-mock.cjs";

let mock: ReturnType<typeof createMock>;
let origin: string;
let resource: string;
let runtime: ReturnType<typeof oauthRuntime>;
beforeAll(() => {
  globalThis.fetch = nativeFetch;
});
const stats = async () =>
  (await fetch(`${origin}/stats`)).json() as Promise<Record<string, number>>;
const control = async (value: object) =>
  fetch(`${origin}/control`, { method: "POST", body: JSON.stringify(value) });
const callback = async (url: string) => {
  const response = await fetch(url, { redirect: "manual" });
  return new URL(response.headers.get("location")!);
};

beforeEach(async () => {
  mock = createMock();
  origin = await mock.start();
  resource = `${origin}/mcp`;
  runtime = oauthRuntime(
    path.join(
      await mkdtemp(path.join(os.tmpdir(), "oauth-fixture-")),
      "mcp_oauth.json",
    ),
  );
});
afterEach(async () => {
  await mock.close();
});

test("only a discoverable 401 requests login; a manual Authorization header remains a 401", async () => {
  await expect(
    createRemoteClient("x", {
      url: resource,
      headers: { "X-MCP-Secret": "synthetic-secret" },
    }),
  ).rejects.toBeInstanceOf(OAuthLoginNeeded);
  expect((await stats()).registrations).toBe(0);
  expect((await stats()).metadataHeaderLeaks).toBe(0);
  const before = await stats();
  await expect(
    createRemoteClient("x", {
      url: resource,
      headers: { authorization: "Bearer synthetic-key" },
    }),
  ).rejects.toThrow("HTTP 401");
  expect((await stats()).metadata).toBe(before.metadata);
  await control({ metadata: false });
  await expect(createRemoteClient("x", { url: resource })).rejects.toThrow(
    "HTTP 401",
  );
});

test("a service without dynamic client registration reports that limitation", async () => {
  await control({ dcr: false });
  await expect(
    createRemoteClient("x", { url: resource }),
  ).rejects.toBeInstanceOf(OAuthPreRegisteredClientRequired);
  expect((await stats()).registrations).toBe(0);
});

test("one authorized callback stores credentials, reconnects, survives restart and refreshes", async () => {
  let completed = 0;
  const authorizationUrl = await beginServerOAuth(runtime, {
    id: "server",
    serverUrl: resource,
    redirectUri: "http://127.0.0.1:45671/callback",
    isCurrent: async () => true,
    onSuccess: async () => {
      completed++;
    },
  });
  const result = await callback(authorizationUrl);
  expect(
    await finishServerOAuth(
      runtime,
      new URLSearchParams("state=wrong&code=wrong"),
    ),
  ).toBe(false);
  expect(await finishServerOAuth(runtime, result.searchParams)).toBe(true);
  expect(await finishServerOAuth(runtime, result.searchParams)).toBe(false);
  expect(completed).toBe(1);
  let provider = await backgroundServerOAuth(runtime, "server", resource);
  expect(provider).toBeDefined();
  let client = await createRemoteClient(
    "server",
    { url: resource },
    undefined,
    provider,
  );
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    "echo",
  ]);
  expect(
    await client.callTool({ name: "echo", arguments: { text: "synthetic" } }),
  ).toMatchObject({ content: [{ text: "synthetic" }] });
  await client.close();
  const initial = await stats();
  provider = await backgroundServerOAuth(runtime, "server", resource);
  client = await createRemoteClient(
    "server",
    { url: resource },
    undefined,
    provider,
  );
  await client.close();
  expect((await stats()).authorizations).toBe(initial.authorizations);
  await control({ expire: true });
  provider = await backgroundServerOAuth(runtime, "server", resource);
  client = await createRemoteClient(
    "server",
    { url: resource, headers: { "X-MCP-Secret": "synthetic-secret" } },
    undefined,
    provider,
  );
  await client.close();
  expect((await stats()).refreshes).toBeGreaterThan(initial.refreshes);
  expect((await stats()).metadataHeaderLeaks).toBe(0);
  await runtime.store.remove("server");
  expect(
    await backgroundServerOAuth(runtime, "server", resource),
  ).toBeUndefined();
});

test("denial, expired state and changed server never exchange a code", async () => {
  let active = true;
  const start = () =>
    beginServerOAuth(runtime, {
      id: "server",
      serverUrl: resource,
      redirectUri: "http://127.0.0.1:45671/callback",
      isCurrent: async () => active,
      onSuccess: async () => {},
    });
  await control({ denied: true });
  let url = await start();
  let returned = await callback(url);
  expect(await finishServerOAuth(runtime, returned.searchParams)).toBe(false);
  await control({ denied: false });
  url = await start();
  returned = await callback(url);
  const state = returned.searchParams.get("state")!;
  runtime.pending.get(state)!.expires = Date.now() - 1;
  expect(await finishServerOAuth(runtime, returned.searchParams)).toBe(false);
  url = await start();
  returned = await callback(url);
  active = false;
  expect(await finishServerOAuth(runtime, returned.searchParams)).toBe(false);
  expect((await stats()).exchanges).toBe(0);
});

test("refresh failure returns to the login-required state without another registration", async () => {
  const url = await beginServerOAuth(runtime, {
    id: "server",
    serverUrl: resource,
    redirectUri: "http://127.0.0.1:45671/callback",
    isCurrent: async () => true,
    onSuccess: async () => {},
  });
  expect(
    await finishServerOAuth(runtime, (await callback(url)).searchParams),
  ).toBe(true);
  const before = await stats();
  await control({ expire: true, refreshFail: true });
  const provider = await backgroundServerOAuth(runtime, "server", resource);
  await expect(
    createRemoteClient("server", { url: resource }, undefined, provider),
  ).rejects.toBeInstanceOf(OAuthLoginNeeded);
  expect((await stats()).registrations).toBe(before.registrations);
});

test("a refresh failure during a tool call reports the challenge for re-login", async () => {
  const url = await beginServerOAuth(runtime, {
    id: "server",
    serverUrl: resource,
    redirectUri: "http://127.0.0.1:45671/callback",
    isCurrent: async () => true,
    onSuccess: async () => {},
  });
  expect(
    await finishServerOAuth(runtime, (await callback(url)).searchParams),
  ).toBe(true);
  const provider = await backgroundServerOAuth(runtime, "server", resource);
  const client = await createRemoteClient(
    "server",
    { url: resource },
    undefined,
    provider,
  );
  let observed: Error | undefined;
  client.onerror = (error) => {
    observed = error;
  };
  await control({ expire: true, refreshFail: true });
  await expect(
    client.callTool({ name: "echo", arguments: {} }),
  ).rejects.toThrow();
  expect(observed).toBeInstanceOf(OAuthLoginNeeded);
  expect((observed as OAuthLoginNeeded).resourceMetadataUrl).toBe(
    `${origin}/.well-known/oauth-protected-resource/mcp`,
  );
  await client.close();
});

test("a refresh already in flight cannot recreate credentials after sign-out", async () => {
  const url = await beginServerOAuth(runtime, {
    id: "server",
    serverUrl: resource,
    redirectUri: "http://127.0.0.1:45671/callback",
    isCurrent: async () => true,
    onSuccess: async () => {},
  });
  expect(
    await finishServerOAuth(runtime, (await callback(url)).searchParams),
  ).toBe(true);
  const provider = await backgroundServerOAuth(runtime, "server", resource);
  expect(provider).toBeDefined();
  invalidateServerOAuth(runtime, "server");
  await runtime.store.remove("server");
  await expect(
    provider!.saveTokens({ access_token: "stale", token_type: "Bearer" }),
  ).rejects.toThrow("MCP server changed");
  expect(await runtime.store.read("server", resource)).toBeUndefined();
});
