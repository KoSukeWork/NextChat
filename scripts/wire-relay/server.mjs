import { timingSafeEqual } from "node:crypto";

// This registry describes NETWORK runtimes, not model protocols. Adding a
// model adapter must not require modifications to this server.
export const RUNTIME_PROFILE = "bun-1.4.4-38afee6c8-win32-x64";
export function runtimeInfo() {
  return {
    name: "nextchat-wire-relay",
    protocolVersion: 1,
    runtime: globalThis.Bun?.version || "unsupported",
    revision: globalThis.Bun?.revision || "unsupported",
    platform: process.platform,
    arch: process.arch,
  };
}
export function verifyRuntime() {
  const info = runtimeInfo();
  if (
    info.runtime !== "1.4.4" ||
    info.revision !== "38afee6c84fcf48c0edb2466aa4b27d287a59c30" ||
    info.platform !== "win32" ||
    info.arch !== "x64"
  )
    throw new Error(
      `Unsupported wire runtime: ${JSON.stringify(
        info,
      )}. Use the pinned independent build; there is no fallback.`,
    );
  return { ...info, profiles: [RUNTIME_PROFILE] };
}

export function parseEnvelope(value, maxBodyBytes) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1
  )
    throw new Error("Invalid wire envelope version");
  if (value.profile !== RUNTIME_PROFILE)
    throw new Error("Unsupported wire profile");
  const url = new URL(value.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Invalid upstream URL");
  if (!["GET", "POST"].includes(value.method))
    throw new Error("Unsupported method");
  if (!Array.isArray(value.headers) || value.headers.length > 100)
    throw new Error("Invalid header list");
  const headers = Object.create(null);
  const names = new Set();
  for (const pair of value.headers) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      pair.some((v) => typeof v !== "string")
    )
      throw new Error("Invalid header entry");
    const [name, content] = pair;
    const lower = name.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      /[\r\n\0]/.test(content) ||
      content.length > 16000 ||
      names.has(lower)
    )
      throw new Error("Invalid or duplicate header");
    if (
      [
        "host",
        "content-length",
        "connection",
        "transfer-encoding",
        "proxy-authorization",
        "proxy-connection",
        "upgrade",
        "expect",
        "trailer",
        "te",
      ].includes(lower)
    )
      throw new Error(`Runtime-owned header: ${name}`);
    names.add(lower);
    headers[name] = content;
  }
  if (value.body !== undefined && typeof value.body !== "string")
    throw new Error("Body must be serialized text");
  if (value.method === "GET" && value.body !== undefined)
    throw new Error("GET must not have a body");
  if (Buffer.byteLength(value.body || "", "utf8") > maxBodyBytes)
    throw new Error("Body too large");
  return {
    url: url.toString(),
    method: value.method,
    headers,
    body: value.body,
  };
}

export function createWireRelay({
  token,
  host = "127.0.0.1",
  port = 8789,
  timeoutMs = 600000,
  maxBodyBytes = 16 * 1024 * 1024,
}) {
  const info = verifyRuntime();
  if (typeof token !== "string" || token.length < 16)
    throw new Error("Set NEXTCHAT_WIRE_TOKEN to at least 16 characters");
  const expected = Buffer.from(`Bearer ${token}`);
  const requests = new Set();
  const server = Bun.serve({
    hostname: host,
    port,
    idleTimeout: 0,
    maxRequestBodySize: maxBodyBytes * 2 + 1024 * 1024,
    async fetch(request) {
      const actual = Buffer.from(request.headers.get("authorization") || "");
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return new Response("Unauthorized", { status: 401 });
      const path = new URL(request.url).pathname;
      if (path === "/v1/info" && request.method === "GET")
        return Response.json(info, {
          headers: { "cache-control": "no-store" },
        });
      if (path !== "/v1/requests" || request.method !== "POST")
        return new Response("Not found", { status: 404 });
      let wire;
      try {
        wire = parseEnvelope(await request.json(), maxBodyBytes);
      } catch (error) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      const controller = new AbortController();
      requests.add(controller);
      const abort = () => controller.abort();
      const timeout = setTimeout(abort, timeoutMs);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      const clean = () => {
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", abort);
        requests.delete(controller);
      };
      try {
        // Do not construct Headers here: Bun's serializer uses original header
        // spelling. Neither a CLI binary nor CLI code is loaded by this process.
        const response = await fetch(wire.url, {
          method: wire.method,
          headers: wire.headers,
          body: wire.body,
          redirect: "manual",
          signal: controller.signal,
        });
        const headers = new Headers(response.headers);
        for (const name of [
          "content-encoding",
          "content-length",
          "transfer-encoding",
          "connection",
          "keep-alive",
        ])
          headers.delete(name);
        headers.set("x-nextchat-wire-profile", RUNTIME_PROFILE);
        if (!response.body) {
          clean();
          return new Response(null, { status: response.status, headers });
        }
        const reader = response.body.getReader();
        const body = new ReadableStream({
          async pull(stream) {
            try {
              const part = await reader.read();
              if (part.done) {
                clean();
                reader.releaseLock();
                stream.close();
              } else stream.enqueue(part.value);
            } catch (error) {
              clean();
              stream.error(error);
            }
          },
          async cancel(reason) {
            abort();
            clean();
            await reader.cancel(reason).catch(() => {});
          },
        });
        return new Response(body, { status: response.status, headers });
      } catch {
        clean();
        return Response.json(
          {
            error: controller.signal.aborted
              ? "Wire request cancelled or timed out"
              : "Wire upstream connection failed",
          },
          { status: controller.signal.aborted ? 504 : 502 },
        );
      }
    },
    error() {
      return new Response("Wire relay failed", { status: 500 });
    },
  });
  return {
    server,
    info,
    async stop() {
      for (const controller of requests) controller.abort();
      await server.stop(true);
    },
  };
}
