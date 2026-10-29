import { STORAGE_KEY } from "@/app/constant";
import type { SyncStore } from "@/app/store/sync";
import { assertStatus, cloudRequest, proxyPath, SyncError } from "./transport";

export type UpstashConfig = SyncStore["upstash"];
export type UpStashClient = ReturnType<typeof createUpstashClient>;

// Preserve every byte of the JSON backup, including spaces inside strings.
export function* backupChunks(value: string, limit = 1_000_000) {
  const bytes = new TextEncoder().encode(value);
  const decoder = new TextDecoder();
  for (let start = 0; start < bytes.length; ) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    if (end === start) throw new SyncError("INVALID_JSON");
    yield decoder.decode(bytes.slice(start, end));
    start = end;
  }
}

export function createUpstashClient(store: SyncStore) {
  const config = store.upstash;
  const storeKey = config.username || STORAGE_KEY;
  const chunkCountKey = `${storeKey}-chunk-count`;
  const chunkIndexKey = (i: number) => `${storeKey}-chunk-${i}`;
  const proxy = store.useProxy ? store.proxyUrl : "";
  const request = async (action: string, key: string, body?: string) => {
    const res = await cloudRequest({
      endpoint: config.endpoint,
      path: `${action}/${key}`,
      proxyPath: proxyPath(
        "/api/upstash/",
        `${action}/${encodeURIComponent(key)}/`,
        config.endpoint,
        proxy,
      ),
      method: action === "get" ? "GET" : "POST",
      body,
      headers: { Authorization: `Bearer ${config.apiKey}` },
      credentials: { token: config.apiKey },
    });
    assertStatus(res.status);
    let parsed: { result?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new SyncError("INVALID_JSON");
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("result" in parsed) ||
      parsed.error
    )
      throw new SyncError("REMOTE_ERROR");
    return parsed.result;
  };
  return {
    async check() {
      await request("get", storeKey);
      return true;
    },
    async redisGet(key: string) {
      const value = await request("get", key);
      if (value !== null && typeof value !== "string")
        throw new SyncError("INVALID_JSON");
      return value as string | null;
    },
    async redisSet(key: string, value: string) {
      await request("set", key, value);
    },
    async get() {
      const count = await this.redisGet(chunkCountKey);
      if (count === null) return "";
      const chunkCount = Number(count);
      if (!Number.isInteger(chunkCount) || chunkCount < 0 || chunkCount > 10000)
        throw new SyncError("INVALID_JSON");
      const values = await Promise.all(
        Array.from({ length: chunkCount }, (_, i) =>
          this.redisGet(chunkIndexKey(i)),
        ),
      );
      if (values.some((value) => value === null))
        throw new SyncError("INVALID_JSON");
      return values.join("");
    },
    async set(_: string, value: string) {
      let index = 0;
      for (const chunk of backupChunks(value)) {
        await this.redisSet(chunkIndexKey(index++), chunk);
      }
      await this.redisSet(chunkCountKey, index.toString());
    },
  };
}
