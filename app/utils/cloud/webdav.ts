import { STORAGE_KEY } from "@/app/constant";
import type { SyncStore } from "@/app/store/sync";
import { assertStatus, cloudRequest, proxyPath, SyncError } from "./transport";

export type WebDAVConfig = SyncStore["webdav"];
export type WebDavClient = ReturnType<typeof createWebDavClient>;

export function createWebDavClient(store: SyncStore) {
  const folder = STORAGE_KEY;
  const fileName = `${folder}/backup.json`;
  const config = store.webdav;
  const proxy = store.useProxy ? store.proxyUrl : "";
  const request = (path: string, method: string, body?: string) => {
    const bytes = new TextEncoder().encode(
      `${config.username}:${config.password}`,
    );
    const auth = btoa(
      Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
    );
    return cloudRequest({
      endpoint: config.endpoint,
      path,
      method,
      body,
      proxyPath: proxyPath(
        "/api/webdav/",
        path,
        config.endpoint,
        proxy,
        method === "MKCOL" ? method : undefined,
      ),
      proxyMethod: method === "MKCOL" ? "GET" : undefined,
      headers: { Authorization: `Basic ${auth}` },
      credentials: { username: config.username, password: config.password },
    });
  };
  return {
    async prepare() {
      const res = await request(folder, "MKCOL");
      if (res.status !== 405) assertStatus(res.status);
    },
    async check() {
      await this.prepare();
      // An existing collection (405) still needs an authenticated read check.
      const res = await request(fileName, "GET");
      if (res.status !== 404) {
        assertStatus(res.status);
        if (res.body.trimStart().startsWith("<"))
          throw new SyncError("INVALID_JSON");
      }
      return true;
    },
    async get(_key: string) {
      const res = await request(fileName, "GET");
      if (res.status === 404) return "";
      assertStatus(res.status);
      return res.body;
    },
    async set(_key: string, value: string) {
      const res = await request(fileName, "PUT", value);
      assertStatus(res.status);
    },
  };
}
