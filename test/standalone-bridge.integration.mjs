import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, relative, isAbsolute } from "node:path";
import { once } from "node:events";
import { mockAnthropic } from "./fixtures/anthropic-http.mjs";

const executable = resolve(
  process.env.NEXTCHAT_TEST_WIRE_EXE || "build/nextchat-wire-relay.exe",
);
test(
  "bundled bridge runs real CLI -p without a separate Node installation",
  {
    skip:
      process.env.NEXTCHAT_TEST_REAL_CLAUDE !== "1" || !existsSync(executable),
    timeout: 45000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "nextchat-managed-bridge-"));
    const upstream = await mockAnthropic();
    const child = spawn(executable, ["--bridge"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NEXTCHAT_SERVICE_MANAGED: "1",
        NEXTCHAT_BRIDGE_HOST: "127.0.0.1",
        NEXTCHAT_BRIDGE_PORT: "0",
        NEXTCHAT_BRIDGE_TOKEN: "managed-bridge-test-token",
        NEXTCHAT_CLAUDE_PATH: process.env.NEXTCHAT_CLAUDE_PATH || "claude",
        NEXTCHAT_SERVICE_WORK_DIR: join(directory, "work"),
        NEXTCHAT_SERVICE_DATA_DIR: join(directory, "sessions"),
      },
    });
    try {
      const ready = new Promise((done, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Bridge did not become ready")),
          15000,
        );
        let text = "",
          errors = "";
        child.stderr.on("data", (b) => (errors += b));
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("exit", () => {
          clearTimeout(timer);
          reject(new Error(`Bridge exited: ${errors}`));
        });
        child.stdout.on("data", (b) => {
          text += b;
          if (text.includes("\n")) {
            clearTimeout(timer);
            done(JSON.parse(text.split("\n")[0]));
          }
        });
      });
      child.stdin.end("start\n");
      const info = await ready;
      assert.equal(info.name, "nextchat-cli-bridge");
      const pkg = JSON.parse(
        await readFile(
          new URL(
            "../public/request-plugins/nextchat.claude-code-3.2.0-beta.1.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const hooks = await import(
        `data:text/javascript;base64,${Buffer.from(pkg.source).toString(
          "base64",
        )}`
      );
      const request = hooks.prepareChat(
        {
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "Local managed bridge probe" }],
          enableTools: false,
        },
        {
          config: {
            mode: "cli",
            bridgeUrl: info.listening,
            bridgeToken: "managed-bridge-test-token",
            nativeCliVersion: info.versions[0],
            authType: "api-key",
          },
          endpoint: { baseUrl: upstream.url, apiKey: "dummy-gateway-key" },
          sessionId: "managed-probe",
          requestId: "test",
        },
      );
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(20000),
      });
      const events = (await response.text()).trim().split("\n").map(JSON.parse);
      assert.equal(events.at(-1).type, "done", JSON.stringify(events));
      assert.ok(events.some((event) => event.type === "text"));
      assert.equal(
        upstream.captures[0].headers["x-api-key"],
        "dummy-gateway-key",
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "exit");
        child.kill();
        await closed;
      }
      await upstream.close();
      const rel = relative(resolve(tmpdir()), resolve(directory));
      if (!rel || rel.startsWith("..") || isAbsolute(rel))
        throw new Error("Unsafe test cleanup path");
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  },
);
