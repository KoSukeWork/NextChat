import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBridge } from "../scripts/client-bridge/server.mjs";
import {
  createDriver,
  createUnverifiedDriver,
} from "../plugins/antigravity/driver.mjs";
import {
  promptBlocks,
  selectModel,
  supportedEffort,
} from "../plugins/antigravity/acp.mjs";

test("ACP replay caps UTF-8 bytes and maps model effort to supported levels", () => {
  const prompt = promptBlocks(
    [
      { role: "user", content: "首".repeat(100000) },
      { role: "assistant", content: "earlier" },
      { role: "user", content: "current" },
    ],
    false,
  );
  assert.ok(Buffer.byteLength(prompt[0].text) < 115000);
  assert.equal(prompt.at(-1).text, "current");
  const selection = selectModel(
    [{ id: "model", options: [{ value: "gemini-4-hydrogen" }] }],
    "gemini-4-hydrogen-xhigh",
    "",
  );
  assert.deepEqual(selection, { model: "gemini-4-hydrogen", effort: "xhigh" });
  assert.equal(
    supportedEffort(selection.effort, ["low", "medium", "high", "xhigh"]),
    "xhigh",
  );
  assert.equal(
    supportedEffort(selection.effort, ["low", "medium", "high"]),
    "high",
  );
});

test("the registered driver refuses requests until isolation is verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "nextchat-agy-disabled-"));
  const driver = await createDriver({
    executable: join(root, "nonexistent.exe"),
    dataDirectory: root,
  });
  try {
    await assert.rejects(
      () => driver.models({ cliVersion: "1.5.11" }),
      /isolation is verified/,
    );
    await assert.rejects(() => driver.chat({}, {}), /isolation is verified/);
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "ACP bridge discovers models, resumes and routes only authorized host tools",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nextchat-agy-fixture-"));
    const executable = join(root, "agy.exe");
    execFileSync(
      "rustc",
      [resolve("test/fixtures/fake-agy.rs"), "-o", executable],
      { windowsHide: true },
    );
    process.env.NEXTCHAT_TEST_AGY_NODE = process.execPath;
    process.env.NEXTCHAT_TEST_AGY_SCRIPT = resolve(
      "test/fixtures/fake-agy.mjs",
    );
    const driver = await createUnverifiedDriver({
      executable,
      dataDirectory: join(root, "data"),
    });
    const token = "bridge-integration-token";
    const server = createBridge({
      token,
      drivers: new Map([[driver.id, driver]]),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    async function chat(input, signal) {
      const response = await fetch(`${url}/v1/drivers/antigravity/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
        signal,
      });
      const events = [];
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += Buffer.from(chunk).toString();
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const event = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          events.push(event);
          if (event.type === "host_tool_call") {
            assert.equal(event.name, "probe");
            assert.deepEqual(event.input, { value: 42 });
            const reply = await fetch(
              `${url}/v1/runs/${event.runId}/results/${event.id}`,
              {
                method: "POST",
                headers,
                body: JSON.stringify({
                  content: "from NextChat",
                  isError: false,
                }),
              },
            );
            assert.equal(reply.status, 204);
          }
        }
      }
      return events;
    }
    try {
      const found = await fetch(
        `${url}/v1/drivers/antigravity/models?version=1.5.11`,
        { headers },
      );
      assert.deepEqual(
        (await found.json()).data.map((item) => item.id),
        ["test-model-low", "test-model-high"],
      );
      const input = {
        sessionId: "conversation",
        cliVersion: "1.5.11",
        model: "test-model-low",
        enableTools: true,
        hostTools: [
          {
            name: "probe",
            description: "Test",
            inputSchema: { type: "object" },
          },
        ],
        messages: [
          { role: "system", content: "unchanged system" },
          { role: "user", content: "use tool" },
        ],
      };
      const first = await chat(input);
      assert.deepEqual(
        first.map((event) => event.type),
        ["text", "tool_start", "host_tool_call", "tool_end", "text", "done"],
      );
      const second = await chat({
        ...input,
        messages: [
          ...input.messages,
          { role: "assistant", content: "before\n\nafter" },
          { role: "user", content: "continue" },
        ],
      });
      assert.equal(second[0].text, "resumed");
      const denied = await chat({
        ...input,
        sessionId: "denial",
        enableTools: false,
        hostTools: [],
        messages: [
          { role: "system", content: "unchanged system" },
          { role: "user", content: "try builtin" },
        ],
      });
      assert.equal(denied[0].text, "denied");
      assert.equal(denied.at(-1).type, "done");
      const failure = await chat({
        ...input,
        sessionId: "failure",
        enableTools: false,
        hostTools: [],
        messages: [
          { role: "system", content: "unchanged system" },
          { role: "user", content: "emit error" },
        ],
      });
      assert.equal(failure.at(-1).type, "error");
      assert.ok(!failure.at(-1).message.includes("another-secret"));
      const login = await chat({
        ...input,
        sessionId: "login",
        enableTools: false,
        hostTools: [],
        messages: [
          { role: "system", content: "unchanged system" },
          { role: "user", content: "login-needed" },
        ],
      });
      assert.match(login.at(-1).message, /登录/);
      const backgroundWarning = await chat({
        ...input,
        sessionId: "background-warning",
        enableTools: false,
        hostTools: [],
        messages: [
          { role: "system", content: "unchanged system" },
          { role: "user", content: "auxiliary-login-warning" },
        ],
      });
      assert.match(
        backgroundWarning.at(-1).message,
        /Google rejected the request/,
      );
      for (const mode of ["unsupported", "denied"]) {
        const starting = {
          ...input,
          sessionId: `resume-${mode}`,
          enableTools: false,
          hostTools: [],
          messages: [
            { role: "system", content: "unchanged system" },
            { role: "user", content: `resume-${mode} init` },
          ],
        };
        const initial = await chat(starting);
        assert.equal(initial[0].text, "reply");
        const followup = await chat({
          ...starting,
          messages: [
            ...starting.messages,
            { role: "assistant", content: "reply" },
            { role: "user", content: "continue" },
          ],
        });
        if (mode === "unsupported") {
          assert.equal(followup[0].text, "reply");
          assert.equal(followup.at(-1).type, "done");
        } else {
          assert.equal(followup.at(-1).type, "error");
          assert.match(followup.at(-1).message, /Google rejected the request/);
          assert.ok(!followup.some((event) => event.type === "text"));
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await driver.close();
      delete process.env.NEXTCHAT_TEST_AGY_NODE;
      delete process.env.NEXTCHAT_TEST_AGY_SCRIPT;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "real agy supports a host tool, a resumed turn, and denies a shell request",
  { skip: process.env.NEXTCHAT_TEST_REAL_AGY !== "1", timeout: 180000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nextchat-real-agy-"));
    const executable =
      process.env.NEXTCHAT_AGY_PATH ||
      join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe");
    const driver = await createUnverifiedDriver({
      executable,
      dataDirectory: join(root, "data"),
    });
    const token = "real-test-bridge-token";
    const server = createBridge({
      token,
      drivers: new Map([[driver.id, driver]]),
      timeoutMs: 60000,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    async function chat(body) {
      const response = await fetch(`${url}/v1/drivers/antigravity/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const events = [];
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += Buffer.from(chunk).toString();
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const event = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          events.push(event);
          if (event.type === "host_tool_call") {
            assert.equal(event.name, "probe_ping");
            const reply = await fetch(
              `${url}/v1/runs/${event.runId}/results/${event.id}`,
              {
                method: "POST",
                headers,
                body: JSON.stringify({ content: "PONG", isError: false }),
              },
            );
            assert.equal(reply.status, 204);
          }
        }
      }
      assert.notEqual(
        events.at(-1)?.type,
        "error",
        `${events.at(-1)?.message}; events: ${events
          .map((event) => `${event.type}${event.name ? `:${event.name}` : ""}`)
          .join(", ")}`,
      );
      assert.equal(events.at(-1)?.type, "done");
      return events;
    }
    try {
      const input = {
        sessionId: "real-conversation",
        cliVersion: "1.5.11",
        model: "gemini-3.8-flash-low",
        enableTools: true,
        hostTools: [
          {
            name: "probe_ping",
            description: "Return a short test token",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        messages: [
          { role: "system", content: "Answer concisely." },
          {
            role: "user",
            content: "Call the probe_ping tool once, then return its token.",
          },
        ],
      };
      const first = await chat(input);
      assert.ok(
        first.some((event) => event.type === "host_tool_call"),
        `agy did not call the NextChat test tool: ${JSON.stringify(
          first.map((event) => ({
            type: event.type,
            name: event.name,
            text: event.text,
          })),
        )}`,
      );
      const answer = first
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join("");
      const second = await chat({
        ...input,
        messages: [
          ...input.messages,
          { role: "assistant", content: answer },
          {
            role: "user",
            content: "What token did that tool return? Reply in one word.",
          },
        ],
      });
      assert.equal(second.at(-1).sessionId, first.at(-1).sessionId);
      const shell = await chat({
        ...input,
        sessionId: "real-shell-test",
        enableTools: false,
        hostTools: [],
        messages: [
          { role: "system", content: "Answer concisely." },
          {
            role: "user",
            content:
              "Run the shell command echo NEXTCHAT_TEST, then tell me if you could run it.",
          },
        ],
      });
      assert.ok(!shell.some((event) => event.type === "host_tool_call"));
      assert.ok(
        !shell.some(
          (event) =>
            event.type === "tool_start" &&
            /shell|command|terminal/i.test(event.name),
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await driver.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "real agy denies shell without host tools",
  { skip: process.env.NEXTCHAT_TEST_REAL_AGY !== "1", timeout: 90000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nextchat-real-shell-"));
    const executable =
      process.env.NEXTCHAT_AGY_PATH ||
      join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe");
    const driver = await createUnverifiedDriver({
      executable,
      dataDirectory: join(root, "data"),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const events = [];
    try {
      await driver.chat(
        {
          sessionId: "shell-test",
          cliVersion: "1.5.11",
          model: "gemini-3.8-flash-low",
          enableTools: false,
          messages: [
            {
              role: "user",
              content:
                "Run the shell command echo NEXTCHAT_TEST and tell me whether you can execute it.",
            },
          ],
        },
        {
          signal: controller.signal,
          emit: async (event) => events.push(event),
        },
      );
      assert.ok(
        !events.some(
          (event) =>
            event.type === "tool_start" &&
            /shell|command|terminal/i.test(event.name),
        ),
        JSON.stringify(events),
      );
      assert.equal(events.at(-1)?.type, "done");
    } finally {
      clearTimeout(timer);
      await driver.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
