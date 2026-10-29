import { jest } from "@jest/globals";
import { TextEncoder, TextDecoder } from "util";
import { createWebDavClient } from "../app/utils/cloud/webdav";
import { createUpstashClient, backupChunks } from "../app/utils/cloud/upstash";
import { SyncError } from "../app/utils/cloud/transport";
import type { SyncStore } from "../app/store/sync";

jest.unstable_mockModule("@/app/store/config", () => ({
  SubmitKey: {
    Enter: "Enter",
    CtrlEnter: "CtrlEnter",
    ShiftEnter: "ShiftEnter",
    AltEnter: "AltEnter",
    MetaEnter: "MetaEnter",
  },
}));
const cn = (await import("../app/locales/cn")).default;
const en = (await import("../app/locales/en")).default;
jest.unstable_mockModule("@/app/locales", () => ({ default: cn }));
const local = { "chat-next-web-store": { sessions: [] } };
const getLocal = jest.fn(() => local);
const merge = jest.fn((a: any, b: any) => {
  Object.assign(a, b);
});
const setLocal = jest.fn();
jest.unstable_mockModule("@/app/utils/sync", () => ({
  getLocalAppState: getLocal,
  mergeAppState: merge,
  setLocalAppState: setLocal,
}));
jest.unstable_mockModule("@/app/utils", () => ({
  downloadAs: jest.fn(),
  readFromFile: jest.fn(),
}));
jest.unstable_mockModule("@/app/components/ui-lib", () => ({
  showToast: jest.fn(),
}));
jest.unstable_mockModule("@/app/utils/indexedDB-storage", () => ({
  indexedDBStorage: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));
const { useSyncStore } = await import("../app/store/sync");
const { syncErrorMessage } = await import("../app/utils/cloud/errors");
const { ProviderType } = await import("../app/utils/cloud");

const originalFetch = global.fetch;
const originalTauri = Object.getOwnPropertyDescriptor(window, "__TAURI__");
let native: ReturnType<
  typeof jest.fn<
    (command: string, args?: any) => Promise<{ status: number; body: string }>
  >
>;
let web: ReturnType<
  typeof jest.fn<(input: any, options?: any) => Promise<any>>
>;
const config = () =>
  ({
    ...useSyncStore.getState(),
    useProxy: true,
    proxyUrl: "https://proxy.example",
    webdav: {
      endpoint: "https://dav.example/base",
      username: "user",
      password: "secret",
    },
    upstash: {
      endpoint: "https://redis.example",
      username: "backup",
      apiKey: "secret-token",
    },
  }) as SyncStore;

beforeEach(() => {
  Object.assign(global, { TextEncoder, TextDecoder });
  native = jest.fn(async () => ({ status: 200, body: "" }));
  web = jest.fn(async () => ({ status: 200, ok: true, text: async () => "" }));
  global.fetch = web as typeof fetch;
  Object.defineProperty(window, "__TAURI__", {
    configurable: true,
    value: { invoke: native },
  });
  useSyncStore.setState({
    ...config(),
    provider: ProviderType.WebDAV,
    lastSyncTime: 0,
  });
  merge.mockClear();
  setLocal.mockClear();
});
afterEach(() => {
  global.fetch = originalFetch;
  if (originalTauri) Object.defineProperty(window, "__TAURI__", originalTauri);
  else Reflect.deleteProperty(window, "__TAURI__");
});

test("desktop WebDAV bypasses proxy and uses native MKCOL/GET/PUT; first upload marks time", async () => {
  native
    .mockResolvedValueOnce({ status: 201, body: "" })
    .mockResolvedValueOnce({ status: 404, body: "" })
    .mockResolvedValueOnce({ status: 201, body: "" });
  await useSyncStore.getState().sync();
  expect(native.mock.calls.map(([, args]) => args.request.method)).toEqual([
    "MKCOL",
    "GET",
    "PUT",
  ]);
  expect(native.mock.calls[0]).toEqual([
    "sync_http",
    {
      request: expect.objectContaining({
        endpoint: "https://dav.example/base",
        path: "chatgpt-next-web",
        username: "user",
        password: "secret",
      }),
    },
  ]);
  expect(web).not.toHaveBeenCalled();
  expect(useSyncStore.getState().lastSyncTime).toBeGreaterThan(0);
});

test("existing backup is downloaded once, merged and uploaded", async () => {
  native
    .mockResolvedValueOnce({ status: 405, body: "" })
    .mockResolvedValueOnce({ status: 200, body: '{"remote":true}' })
    .mockResolvedValueOnce({ status: 204, body: "" });
  await useSyncStore.getState().sync();
  expect(
    native.mock.calls.filter(([, a]) => a.request.method === "GET"),
  ).toHaveLength(1);
  expect(merge).toHaveBeenCalledTimes(1);
  expect(JSON.parse(native.mock.calls[2][1].request.body).remote).toBe(true);
  expect(setLocal).toHaveBeenCalledTimes(1);
});

test("failed PUT rejects and never updates sync time or live state", async () => {
  native
    .mockResolvedValueOnce({ status: 405, body: "" })
    .mockResolvedValueOnce({ status: 200, body: '{"remote":true}' })
    .mockResolvedValueOnce({ status: 403, body: "" });
  await expect(useSyncStore.getState().sync()).rejects.toMatchObject({
    code: "HTTP",
    status: 403,
  });
  expect(useSyncStore.getState().lastSyncTime).toBe(0);
  expect(setLocal).not.toHaveBeenCalled();
  expect(local).not.toHaveProperty("remote");
});

test.each([401, 403, 404, 409, 429, 503, 307])(
  "check rejects MKCOL HTTP %i",
  async (status) => {
    native.mockResolvedValueOnce({ status, body: "" });
    await expect(createWebDavClient(config()).check()).rejects.toMatchObject({
      code: "HTTP",
      status,
    });
  },
);
test("existing collection still verifies authenticated read; HTML fallback cannot pass", async () => {
  native
    .mockResolvedValueOnce({ status: 405, body: "" })
    .mockResolvedValueOnce({ status: 401, body: "" });
  await expect(createWebDavClient(config()).check()).rejects.toMatchObject({
    status: 401,
  });
  native
    .mockResolvedValueOnce({ status: 200, body: "<html>" })
    .mockResolvedValueOnce({ status: 200, body: "<html>" });
  await expect(createWebDavClient(config()).check()).rejects.toMatchObject({
    code: "INVALID_JSON",
  });
});
test("invalid remote JSON never gets overwritten", async () => {
  native
    .mockResolvedValueOnce({ status: 405, body: "" })
    .mockResolvedValueOnce({
      status: 200,
      body: "<html>private response</html>",
    });
  await expect(useSyncStore.getState().sync()).rejects.toMatchObject({
    code: "INVALID_JSON",
  });
  expect(native).toHaveBeenCalledTimes(2);
});
test("Web retains server proxy path and MKCOL tunnel", async () => {
  Reflect.deleteProperty(window, "__TAURI__");
  web.mockResolvedValueOnce({ status: 201, ok: true, text: async () => "" });
  await createWebDavClient(config()).prepare();
  const [url, options] = web.mock.calls[0];
  expect(url).toBe(
    "https://proxy.example/api/webdav/chatgpt-next-web?endpoint=https%3A%2F%2Fdav.example%2Fbase&proxy_method=MKCOL",
  );
  expect(options.method).toBe("GET");
  expect(native).not.toHaveBeenCalled();
  await createWebDavClient({ ...config(), useProxy: false }).get("user");
  expect(web.mock.calls[1][0]).toMatch(/^\/api\/webdav\//);
});
test("Upstash desktop is direct and rejects set failures", async () => {
  native.mockResolvedValueOnce({ status: 200, body: '{"result":null}' });
  expect(await createUpstashClient(config()).check()).toBe(true);
  expect(native.mock.calls[0][1].request).toMatchObject({
    endpoint: "https://redis.example",
    path: "get/backup",
    token: "secret-token",
  });
  native.mockResolvedValueOnce({ status: 503, body: "" });
  await expect(
    createUpstashClient(config()).set("", "data"),
  ).rejects.toMatchObject({ status: 503 });
  Reflect.deleteProperty(window, "__TAURI__");
  web.mockResolvedValueOnce({
    status: 200,
    ok: true,
    text: async () => '{"result":null}',
  });
  await createUpstashClient(config()).check();
  expect(web.mock.calls[0][0]).toMatch(
    /^https:\/\/proxy.example\/api\/upstash\/get\/backup\//,
  );
});
test("Upstash chunks preserve JSON spaces and multibyte characters", () => {
  const value = JSON.stringify({ text: "你好 some words 😊 ".repeat(20) });
  const parts = [...backupChunks(value, 17)];
  expect(parts.join("")).toBe(value);
  expect(parts.every((p) => new TextEncoder().encode(p).length <= 17)).toBe(
    true,
  );
});
test.each([
  "file:///private",
  "ftp://host",
  "https://user:secret@host",
  "https://host?password=secret",
])(
  "invalid endpoint is rejected before credentials leave: %s",
  async (endpoint) => {
    await expect(
      createWebDavClient({
        ...config(),
        webdav: { ...config().webdav, endpoint },
      }).get("user"),
    ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
    expect(native).not.toHaveBeenCalled();
    expect(web).not.toHaveBeenCalled();
  },
);
test.each([cn.Settings.Sync.Errors, en.Settings.Sync.Errors])(
  "localized errors retain status/reason and omit sensitive raw text",
  async (messages) => {
    for (const [status, key] of [
      [401, "AUTH"],
      [403, "FORBIDDEN"],
      [404, "PATH"],
      [409, "PATH"],
      [429, "BUSY"],
      [503, "BUSY"],
      [302, "REDIRECT"],
      [500, "HTTP"],
    ] as const)
      expect(syncErrorMessage(new SyncError("HTTP", status), messages)).toBe(
        `${messages[key]} (HTTP ${status})`,
      );
    for (const code of [
      "INVALID_JSON",
      "NETWORK_DNS",
      "NETWORK_TLS",
      "NETWORK_TIMEOUT",
      "NETWORK_REFUSED",
    ] as const)
      expect(syncErrorMessage(new SyncError(code), messages)).toBe(
        messages[code],
      );
    expect(
      syncErrorMessage(
        new Error("user:secret Authorization Basic private"),
        messages,
      ),
    ).toBe(messages.UNKNOWN);
    native.mockRejectedValueOnce({
      code: "NETWORK_REFUSED",
      detail: "password:secret",
    });
    await expect(
      createWebDavClient(config()).get("user"),
    ).rejects.toMatchObject({
      code: "NETWORK_REFUSED",
      message: "NETWORK_REFUSED",
    });
  },
);
