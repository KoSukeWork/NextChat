// Compare the installed plugin with the FIRST simple text request captured by
// capture-interactive-request.mjs. The reference CLI is not needed here.
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { compareRequests, decodeRequest } from "./request-parity.mjs";
import { compareClientSurface } from "./request-surface.mjs";

const scope = process.argv[3] || "full-http";
if (!["full-http", "client-surface"].includes(scope))
  throw new Error("Scope must be full-http or client-surface");

const probe = JSON.parse(await readFile(process.argv[2], "utf8"));
const gateway = new URL(probe.url);
if (
  gateway.protocol !== "http:" ||
  gateway.hostname !== "127.0.0.1" ||
  gateway.username ||
  gateway.password
)
  throw new Error("Only the local capture gateway is supported");
const captures = JSON.parse(await readFile(probe.captures, "utf8"));
const reference = decodeRequest(captures.captures[0]);
const body = JSON.parse(reference.body.toString("utf8"));
if (
  body.messages.length !== 1 ||
  body.messages[0].role !== "user" ||
  body.messages[0].content.at(-1)?.type !== "text"
)
  throw new Error("Use a fresh interactive session with a simple text prompt");
const userText = body.messages[0].content.at(-1).text;
const identity = JSON.parse(body.metadata.user_id);
const pkg = JSON.parse(
  await readFile(
    resolve("public/request-plugins/nextchat.claude-code-3.0.0-beta.2.json"),
    "utf8",
  ),
);
const plugin = await import(
  `data:text/javascript;base64,${Buffer.from(pkg.source).toString("base64")}`
);
const config = Object.fromEntries(
  Object.entries(pkg.manifest.fields).map(([key, field]) => [
    key,
    field.default || "",
  ]),
);
config.deviceId = identity.device_id;
config.accountUuid = identity.account_uuid;
const wire = plugin.prepareRequest(
  {
    url: `${gateway.origin}/v1/messages`,
    headers: { "Content-Type": "application/json", "x-api-key": probe.key },
    body: {
      model: body.model,
      messages: [{ role: "user", content: userText }],
      stream: true,
    },
  },
  {
    operation: "chat",
    protocol: "anthropic",
    config,
    endpoint: {
      id: "independent-probe",
      baseUrl: gateway.origin,
      apiKey: probe.key,
    },
    sessionId: identity.session_id,
    requestId: "independent-probe",
  },
);
const token = randomBytes(24).toString("hex");
const executable = resolve(
  process.env.NEXTCHAT_TEST_WIRE_EXE || "build/nextchat-wire-relay.exe",
);
const child = spawn(executable, [], {
  env: {
    ...process.env,
    NEXTCHAT_WIRE_HOST: "127.0.0.1",
    NEXTCHAT_WIRE_PORT: "0",
    NEXTCHAT_WIRE_TOKEN: token,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
try {
  const relay = await new Promise((ready, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error("Wire relay startup timed out")),
      10000,
    );
    const fail = () => {
      clearTimeout(timeout);
      reject(new Error("Wire relay failed to start"));
    };
    child.once("error", fail);
    child.once("exit", fail);
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes("\n")) return;
      try {
        const info = JSON.parse(output.split("\n")[0]);
        clearTimeout(timeout);
        ready(info.listening);
      } catch {
        fail();
      }
    });
  });
  const response = await fetch(`${relay}/v1/requests`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      version: 1,
      profile: wire.transport.profile,
      url: wire.url,
      method: "POST",
      headers: Object.entries(wire.headers),
      body: JSON.stringify(wire.body),
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Probe request failed: ${response.status}`);
  await response.text();
  const updated = JSON.parse(await readFile(probe.captures, "utf8"));
  if (updated.captures.length !== captures.captures.length + 1)
    throw new Error(
      "Concurrent capture changed the comparison; retry with an idle probe",
    );
  const report = {
    plugin: `${pkg.manifest.id}@${pkg.manifest.version}`,
    input:
      "First user text and explicit device/session identity; native system, tools and reminders were not copied",
    ...compareRequests(captures.captures[0], updated.captures.at(-1)),
    clientSurface: compareClientSurface(
      captures.captures[0],
      updated.captures.at(-1),
    ),
  };
  const target = join(probe.directory, "plugin-parity-report.json");
  await writeFile(target, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        report: target,
        selectedScope: scope,
        equal: report.equal,
        clientSurfaceChecksPass: report.clientSurface.checksPass,
        clientSurface: report.clientSurface,
        headerBytesEqual: report.headerBytesEqual,
        bodyBytesEqual: report.bodyBytesEqual,
        reference: report.reference,
        candidate: report.candidate,
        changedPaths: report.changes.map((change) => change.path),
        omittedChanges: report.omittedChanges,
      },
      null,
      2,
    ),
  );
  if (
    !(scope === "client-surface"
      ? report.clientSurface.checksPass
      : report.equal)
  )
    process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.pid) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
}
