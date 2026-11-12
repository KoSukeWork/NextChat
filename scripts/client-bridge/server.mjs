// SDK v1 bridge host. Drivers are trusted local ESM modules installed by the
// operator, never code or executable paths supplied by an HTTP client.
import http from "node:http";
import { once } from "node:events";
import { authorized, readJson, createHostTools } from "./host-tools.mjs";

export function createBridge({
  token,
  drivers,
  maxBodyBytes = 12 * 1024 * 1024,
  timeoutMs = 0,
  getSettings = async () => ({}),
}) {
  if (typeof token !== "string" || token.length < 16)
    throw new Error("Set a bridge token of at least 16 characters");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647)
    throw new Error("Invalid bridge timeout");
  const hostTools = createHostTools();
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, "http://bridge.local").pathname;
    if (await hostTools.handle(req, res, route, token)) return;
    if (!authorized(req.headers.authorization, token)) {
      res.writeHead(401);
      return res.end("Unauthorized");
    }
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
    let timeout, facade;
    let timedOut = false;
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
      const body = await readJson(req, maxBodyBytes);
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Invalid request");
      const settings = await getSettings();
      const limit = settings.requestTimeoutMs ?? timeoutMs;
      if (!Number.isInteger(limit) || limit < 0 || limit > 2147483647)
        throw new Error("Invalid bridge timeout");
      if (limit)
        timeout = setTimeout(() => {
          timedOut = true;
          cancel();
        }, limit);
      if (body.enableTools && body.hostTools?.length) {
        facade = hostTools.begin(
          body.hostTools,
          server,
          emit,
          controller.signal,
        );
      }
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      });
      res.flushHeaders();
      await driver.chat(body, {
        signal: controller.signal,
        emit,
        hostMcp: facade,
        settings,
      });
      await pending;
    } catch (error) {
      if (!res.destroyed) {
        if (!res.headersSent)
          res.writeHead(400, { "content-type": "application/x-ndjson" });
        const message = controller.signal.aborted
          ? timedOut
            ? "Client driver request timed out"
            : "Client driver request cancelled"
          : error instanceof Error
          ? error.message
          : "Client driver failed";
        res.write(JSON.stringify({ type: "error", message }) + "\n");
      }
    } finally {
      clearTimeout(timeout);
      facade?.dispose();
      res.removeListener("close", cancel);
      res.end();
    }
  });
  // Bound uploads, not model generation or tool execution.
  server.requestTimeout = 120000;
  server.timeout = 0;
  return server;
}
