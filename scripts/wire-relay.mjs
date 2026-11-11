import { createWireRelay, verifyRuntime } from "./wire-relay/server.mjs";

if (process.argv.includes("--version")) {
  console.log(JSON.stringify(verifyRuntime()));
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
