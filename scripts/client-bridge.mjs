import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBridge } from "./client-bridge/server.mjs";

const configPath = process.argv[2];
const config = configPath
  ? JSON.parse(await readFile(resolve(configPath), "utf8"))
  : {};
const entries = config.drivers || [
  { module: "plugins/claude-code/driver.mjs", options: {} },
];
const drivers = new Map();
for (const entry of entries) {
  const module = await import(pathToFileURL(resolve(entry.module)).href);
  const driver = await module.createDriver(entry.options || {});
  if (drivers.has(driver.id)) throw new Error(`Duplicate driver: ${driver.id}`);
  drivers.set(driver.id, driver);
}
const server = createBridge({
  token: process.env.NEXTCHAT_BRIDGE_TOKEN,
  drivers,
  timeoutMs: config.timeoutMs,
});
const host = config.host || "127.0.0.1";
const port = config.port || 8788;
server.listen(port, host, () =>
  console.log(
    `NextChat client bridge: http://${host}:${port} (${[...drivers.keys()].join(
      ", ",
    )})`,
  ),
);
const stop = () => {
  server.closeAllConnections();
  server.close();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
