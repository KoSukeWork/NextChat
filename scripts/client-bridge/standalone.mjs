import { createDriver } from "../../plugins/claude-code/driver.mjs";
import { createBridge } from "./server.mjs";
import { readFile } from "node:fs/promises";

export async function startStandaloneBridge() {
  const port = Number(process.env.NEXTCHAT_BRIDGE_PORT || 8788);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid bridge port");
  const driver = await createDriver({
    executable: process.env.NEXTCHAT_CLAUDE_PATH,
    workingDirectory: process.env.NEXTCHAT_SERVICE_WORK_DIR,
    dataDirectory: process.env.NEXTCHAT_SERVICE_DATA_DIR,
    versionPolicy:
      process.env.NEXTCHAT_SERVICE_MANAGED === "1" ? "installed" : "exact",
  });
  const info = await driver.info();
  const server = createBridge({
    token: process.env.NEXTCHAT_BRIDGE_TOKEN,
    drivers: new Map([[driver.id, driver]]),
    timeoutMs: Number(process.env.NEXTCHAT_BRIDGE_TIMEOUT_MS || 0),
    getSettings: async () =>
      process.env.NEXTCHAT_SERVICE_OPTIONS_FILE
        ? JSON.parse(
            await readFile(process.env.NEXTCHAT_SERVICE_OPTIONS_FILE, "utf8"),
          )
        : {},
  });
  const host = process.env.NEXTCHAT_BRIDGE_HOST || "127.0.0.1";
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(
    JSON.stringify({
      name: "nextchat-cli-bridge",
      protocolVersion: 1,
      versions: info.versions,
      listening: `http://${host}:${server.address().port}`,
    }),
  );
  const stop = () => {
    server.closeAllConnections();
    server.close();
    void driver.close().catch(() => {});
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return server;
}
