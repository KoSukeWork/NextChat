// SDK v1 bridge host. Drivers are trusted local ESM modules installed by the
// operator, never code or executable paths supplied by an HTTP client.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";

export function createBridge({
  token,
  drivers,
  maxBodyBytes = 12 * 1024 * 1024,
  timeoutMs = 600000,
}) {
  if (typeof token !== "string" || token.length < 16)
    throw new Error("Set a bridge token of at least 16 characters");
  const expected = Buffer.from(`Bearer ${token}`);
  const server = http.createServer(async (req, res) => {
    const actual = Buffer.from(req.headers.authorization || "");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res.writeHead(401);
      return res.end("Unauthorized");
    }
    const route = new URL(req.url, "http://bridge.local").pathname;
    if (req.method === "GET" && route === "/v1/drivers") {
      try {
        const info = await Promise.all(
          [...drivers].map(async ([id, driver]) => ({
            id,
            ...(await driver.info()),
          })),
        );
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        return res.end(JSON.stringify(info));
      } catch {
        res.writeHead(503);
        return res.end("Client driver is unavailable");
      }
    }
    const id = /^\/v1\/drivers\/([a-z0-9.-]+)\/chat$/.exec(route)?.[1];
    const driver = drivers.get(id);
    if (req.method !== "POST" || !driver) {
      res.writeHead(404);
      return res.end("Unknown client driver");
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.on("close", cancel);
    const timeout = setTimeout(cancel, timeoutMs);
    let pending = Promise.resolve();
    const emit = (value) => {
      pending = pending.then(async () => {
        if (controller.signal.aborted || res.destroyed)
          throw new Error("Request cancelled");
        if (!res.write(JSON.stringify(value) + "\n"))
          await once(res, "drain", { signal: controller.signal });
      });
      return pending;
    };
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          res.writeHead(413);
          res.end("Request too large");
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Invalid request");
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      });
      res.flushHeaders();
      await driver.chat(body, { signal: controller.signal, emit });
      await pending;
    } catch (error) {
      if (!res.destroyed) {
        if (!res.headersSent)
          res.writeHead(400, { "content-type": "application/x-ndjson" });
        const message = controller.signal.aborted
          ? "Client driver timed out or was cancelled"
          : error instanceof Error
          ? error.message
          : "Client driver failed";
        res.write(JSON.stringify({ type: "error", message }) + "\n");
      }
    } finally {
      clearTimeout(timeout);
      res.removeListener("close", cancel);
      res.end();
    }
  });
  server.requestTimeout = timeoutMs;
  return server;
}
