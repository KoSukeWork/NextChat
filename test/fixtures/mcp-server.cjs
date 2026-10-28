// Real stdio fixture used by the Rust process bridge tests. No external packages.
const readline = require("node:readline");
const { spawn } = require("node:child_process");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "exit") return process.exit(0);
  if (!Object.hasOwn(request, "id")) return;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: "2024-10-07",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
      break;
    case "tools/list":
      result = {
        tools: [
          {
            name: "echo",
            description: "Echo input",
            inputSchema: { type: "object" },
          },
        ],
      };
      break;
    case "tools/call":
      result = {
        content: [
          { type: "text", text: JSON.stringify(request.params.arguments) },
        ],
      };
      break;
    case "child": {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore", windowsHide: true },
      );
      result = { pid: child.pid };
      break;
    }
    default:
      result = {
        echo: request.params,
        args: process.argv.slice(2),
        env: process.env,
      };
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
  );
});
