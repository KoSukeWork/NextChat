import { createWireRelay, verifyRuntime } from "./wire-relay/server.mjs";
import { startStandaloneBridge } from "./client-bridge/standalone.mjs";

// The desktop attaches a kill-on-close process job before allowing startup.
// This prevents CLI grandchildren from escaping the parent's lifecycle.
if (process.env.NEXTCHAT_SERVICE_MANAGED === "1") {
  await new Promise((resolve, reject) => {
    process.stdin.once("data", (data) =>
      data.toString().trim() === "start"
        ? resolve()
        : reject(new Error("Invalid startup signal")),
    );
    process.stdin.once("end", () =>
      reject(new Error("Desktop disconnected before startup")),
    );
  });
}

if (process.argv.includes("--version")) {
  console.log(
    JSON.stringify({ ...verifyRuntime(), services: ["wire", "claude-cli"] }),
  );
} else if (process.argv.includes("--bridge")) {
  verifyRuntime();
  await startStandaloneBridge();
} else {
  const port = Number(process.env.NEXTCHAT_WIRE_PORT || 8789);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid wire relay port");
  const relay = createWireRelay({
    token: process.env.NEXTCHAT_WIRE_TOKEN,
    host: process.env.NEXTCHAT_WIRE_HOST || "127.0.0.1",
    port,
  });
  console.log(
    JSON.stringify({
      ...relay.info,
      listening: `http://${relay.server.hostname}:${relay.server.port}`,
    }),
  );
  const stop = async () => {
    await relay.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
