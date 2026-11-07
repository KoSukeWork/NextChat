const fs = require("node:fs");

const [eventsFile, readyFile] = process.argv.slice(2);
fs.appendFileSync(eventsFile, "spawn\n");
if (!fs.existsSync(readyFile)) process.exit(1);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === "initialize") {
      setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "synthetic-stdio", version: "1" },
      } }), 5000);
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
      } });
    } else if (message.method === "tools/call") {
      const mode = message.params.name;
      fs.appendFileSync(eventsFile, `call:${mode}\n`);
      if (mode === "slow") continue;
      if (mode === "invalid") {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Invalid params" } });
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: {
          ...(mode === "error" ? { isError: true } : {}),
          content: [{ type: "text", text: mode }],
        } });
      }
    }
  }
});
