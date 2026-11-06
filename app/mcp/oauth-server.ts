import { randomBytes } from "node:crypto";
import {
  auth,
  discoverOAuthServerInfo,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  McpOAuthProvider,
  OAuthPreRegisteredClientRequired,
  httpUrl,
} from "./oauth";
import type { OAuthCredentials } from "./oauth";
import { OAuthFileStore } from "./oauth-file-store";

type PendingLogin = {
  id: string;
  serverUrl: string;
  expires: number;
  provider: McpOAuthProvider;
  resourceMetadataUrl?: URL;
  isCurrent: () => Promise<boolean>;
  onSuccess: () => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
};

type Runtime = {
  store: OAuthFileStore;
  pending: Map<string, PendingLogin>;
  epochs: Map<string, number>;
};
const runtimeKey = Symbol.for("nextchat.mcp.oauth.server.runtimes");
const shared = globalThis as typeof globalThis & {
  [runtimeKey]?: Map<string, Runtime>;
};

/** Next route handlers and server actions may be compiled into different chunks. */
export function oauthRuntime(file: string): Runtime {
  const runtimes = (shared[runtimeKey] ??= new Map());
  let runtime = runtimes.get(file);
  if (!runtime) {
    runtime = {
      store: new OAuthFileStore(file),
      pending: new Map(),
      epochs: new Map(),
    };
    runtimes.set(file, runtime);
  }
  runtime.epochs ??= new Map();
  return runtime;
}

export function cancelServerOAuth(runtime: Runtime, id: string) {
  for (const [state, pending] of runtime.pending) {
    if (pending.id === id) {
      clearTimeout(pending.timer);
      runtime.pending.delete(state);
    }
  }
}

export function invalidateServerOAuth(runtime: Runtime, id: string) {
  cancelServerOAuth(runtime, id);
  runtime.epochs.set(id, (runtime.epochs.get(id) ?? 0) + 1);
}

export async function backgroundServerOAuth(
  runtime: Runtime,
  id: string,
  serverUrl: string,
  isCurrent: () => Promise<boolean> = async () => true,
) {
  const epoch = runtime.epochs.get(id) ?? 0;
  const credentials = await runtime.store.read(id, serverUrl);
  if (
    !credentials?.tokens ||
    !credentials.client ||
    (runtime.epochs.get(id) ?? 0) !== epoch
  )
    return undefined;
  const valid = async () =>
    (runtime.epochs.get(id) ?? 0) === epoch && (await isCurrent());
  return new McpOAuthProvider(
    credentials,
    (next) => runtime.store.write(id, serverUrl, next, valid),
    false,
  );
}

export async function beginServerOAuth(
  runtime: Runtime,
  args: {
    id: string;
    serverUrl: string;
    redirectUri: string;
    resourceMetadataUrl?: string;
    isCurrent: () => Promise<boolean>;
    onSuccess: () => Promise<void>;
  },
) {
  const serverUrl = httpUrl(args.serverUrl).href;
  const redirectUri = httpUrl(args.redirectUri).href;
  const resourceMetadataUrl = args.resourceMetadataUrl
    ? httpUrl(args.resourceMetadataUrl)
    : undefined;
  const info = await discoverOAuthServerInfo(serverUrl, {
    resourceMetadataUrl,
  });
  const metadata = info.authorizationServerMetadata;
  if (!metadata?.authorization_endpoint || !metadata.token_endpoint)
    throw new Error("OAuth metadata unavailable");
  httpUrl(metadata.authorization_endpoint);
  httpUrl(metadata.token_endpoint);
  if (!metadata.registration_endpoint)
    throw new OAuthPreRegisteredClientRequired();
  httpUrl(metadata.registration_endpoint);
  if (!(await args.isCurrent())) throw new Error("MCP server changed");

  invalidateServerOAuth(runtime, args.id);
  const epoch = runtime.epochs.get(args.id) ?? 0;
  const valid = async () =>
    (runtime.epochs.get(args.id) ?? 0) === epoch && (await args.isCurrent());

  const previous = await runtime.store.read(args.id, serverUrl);
  const credentials: OAuthCredentials =
    previous?.redirectUri === redirectUri
      ? { ...previous, tokens: undefined }
      : { serverUrl, redirectUri };
  const state = randomBytes(32).toString("base64url");
  const provider = new McpOAuthProvider(
    credentials,
    async (next) => {
      await runtime.store.write(args.id, serverUrl, next, valid);
    },
    true,
    state,
  );
  const result = await auth(provider, { serverUrl, resourceMetadataUrl });
  const authorizationUrl = provider.takeAuthorizationUrl();
  if (result !== "REDIRECT" || !authorizationUrl)
    throw new Error("OAuth login could not start");

  const timer = setTimeout(() => runtime.pending.delete(state), 5 * 60_000);
  timer.unref?.();
  runtime.pending.set(state, {
    id: args.id,
    serverUrl,
    expires: Date.now() + 5 * 60_000,
    provider,
    resourceMetadataUrl,
    isCurrent: valid,
    onSuccess: args.onSuccess,
    timer,
  });
  return authorizationUrl.href;
}

/** State is single-use, expires, and can only originate in an authorized action. */
export async function finishServerOAuth(
  runtime: Runtime,
  params: URLSearchParams,
): Promise<boolean> {
  const states = params.getAll("state");
  const codes = params.getAll("code");
  if (states.length !== 1 || !states[0]) return false;
  const pending = runtime.pending.get(states[0]);
  if (!pending) return false;
  runtime.pending.delete(states[0]);
  clearTimeout(pending.timer);
  if (
    pending.expires <= Date.now() ||
    codes.length !== 1 ||
    !codes[0] ||
    params.has("error")
  )
    return false;
  try {
    if (!(await pending.isCurrent())) return false;
    const result = await auth(pending.provider, {
      serverUrl: pending.serverUrl,
      resourceMetadataUrl: pending.resourceMetadataUrl,
      authorizationCode: codes[0],
    });
    if (result !== "AUTHORIZED" || !(await pending.isCurrent())) return false;
    await pending.onSuccess();
    return true;
  } catch {
    return false;
  }
}
