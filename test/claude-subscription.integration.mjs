import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDriver } from "../plugins/claude-code/driver.mjs";
import {
  cleanCliEnvironment,
  createOwnedSessions,
} from "../plugins/claude-code/subscription.mjs";

const request = {
  credentials: "subscription",
  cliVersion: "1.2.3",
  model: "claude-test",
  sessionId: "one",
  enableTools: false,
  messages: [{ role: "user", content: "subscription-test" }],
};

test("subscription bridge is disabled by default and rejects gateway data", async () => {
  const root = await mkdtemp(join(tmpdir(), "nextchat-sub-disabled-"));
  const driver = await createDriver({
    executable: join(root, "missing.exe"),
    dataDirectory: join(root, "data"),
    workingDirectory: join(root, "work"),
  });
  try {
    await assert.rejects(
      driver.chat(request, {
        signal: new AbortController().signal,
        emit: async () => {},
      }),
      /disabled on this bridge/,
    );
    await assert.rejects(
      driver.chat(
        {
          ...request,
          endpoint: { baseUrl: "https://invalid.test", apiKey: "secret" },
        },
        { signal: new AbortController().signal, emit: async () => {} },
      ),
      /cannot contain gateway/,
    );
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "subscription uses official login environment without inherited Claude credentials",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nextchat-sub-fake-"));
    const binary = join(root, "claude.exe");
    execFileSync(
      "rustc",
      [resolve("test/fixtures/claude-cli-fake.rs"), "-o", binary],
      { windowsHide: true },
    );
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "inherited-dummy-key";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "inherited-dummy-token";
    const driver = await createDriver({
      executable: binary,
      subscriptionLogin: true,
      settingsSources: "user,project",
      dataDirectory: join(root, "data"),
      workingDirectory: join(root, "gateway-work"),
    });
    try {
      const env = cleanCliEnvironment();
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      const events = [];
      await driver.chat(request, {
        signal: new AbortController().signal,
        emit: async (e) => events.push(e),
      });
      assert.equal(events.at(-1).type, "done");
      assert.equal(events[0].text, "reply");
      const resumed = [];
      await driver.chat(
        {
          ...request,
          messages: [
            ...request.messages,
            { role: "assistant", content: "reply" },
            { role: "user", content: "subscription-test again" },
          ],
        },
        {
          signal: new AbortController().signal,
          emit: async (e) => resumed.push(e),
        },
      );
      assert.equal(resumed[0].text, "resumed");
      await assert.rejects(
        driver.chat(
          {
            ...request,
            sessionId: "limit",
            messages: [
              { role: "user", content: "subscription-test subscription-limit" },
            ],
          },
          { signal: new AbortController().signal, emit: async () => {} },
        ),
        /Usage limit reached; try again later/,
      );
      await writeFile(
        join(root, "data", "subscription-work", "fake-signed-out"),
        "",
      );
      await assert.rejects(
        driver.chat(
          { ...request, sessionId: "signed-out" },
          { signal: new AbortController().signal, emit: async () => {} },
        ),
        /运行 claude/,
      );
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
      if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
      await driver.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("different driver registries do not clean one another's active sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "nextchat-sub-concurrent-"));
  const work = join(root, "work"),
    config = join(root, "config"),
    data = join(root, "data");
  await mkdir(work, { recursive: true });
  const project = join(
    config,
    "projects",
    (await realpath(work)).replace(/[^A-Za-z0-9]/g, "-"),
  );
  await mkdir(project, { recursive: true });
  const options = {
    dataDirectory: data,
    workDirectory: work,
    configRoot: config,
    maxSessions: 1,
  };
  const firstRegistry = await createOwnedSessions(options),
    secondRegistry = await createOwnedSessions(options);
  const first = randomUUID(),
    second = randomUUID();
  try {
    await firstRegistry.begin(first);
    await secondRegistry.begin(second);
    await writeFile(join(project, `${first}.jsonl`), "active");
    await writeFile(join(project, `${second}.jsonl`), "idle");
    await secondRegistry.end(second);
    assert.equal(
      await readFile(join(project, `${first}.jsonl`), "utf8"),
      "active",
    );
    await firstRegistry.end(first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup refuses a linked project directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nextchat-sub-link-"));
  const work = join(root, "work"),
    config = join(root, "config"),
    outside = join(root, "outside");
  await mkdir(work, { recursive: true });
  await mkdir(join(config, "projects"), { recursive: true });
  await mkdir(outside);
  const project = join(
    config,
    "projects",
    (await realpath(work)).replace(/[^A-Za-z0-9]/g, "-"),
  );
  try {
    try {
      await symlink(
        outside,
        project,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (error.code === "EPERM") return t.skip("Symlink creation unavailable");
      throw error;
    }
    const registry = await createOwnedSessions({
      dataDirectory: join(root, "data"),
      workDirectory: work,
      configRoot: config,
      maxSessions: 0,
    });
    const id = randomUUID();
    await registry.begin(id);
    await writeFile(join(outside, `${id}.jsonl`), "keep");
    await registry.end(id);
    assert.equal(await readFile(join(outside, `${id}.jsonl`), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owned transcript cleanup leaves another session in the same project untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "nextchat-sub-owned-"));
  const work = join(root, "work");
  const config = join(root, "claude-config");
  await mkdir(work, { recursive: true });
  const project = join(
    config,
    "projects",
    (await realpath(work)).replace(/[^A-Za-z0-9]/g, "-"),
  );
  await mkdir(project, { recursive: true });
  const registry = await createOwnedSessions({
    dataDirectory: join(root, "data"),
    workDirectory: work,
    configRoot: config,
    maxSessions: 1,
  });
  const first = randomUUID(),
    second = randomUUID(),
    unrelated = randomUUID();
  try {
    await registry.begin(first);
    await registry.begin(second);
    await writeFile(join(project, `${first}.jsonl`), "owned");
    await writeFile(join(project, `${second}.jsonl`), "active");
    await writeFile(join(project, `${unrelated}.jsonl`), "keep");
    await registry.end(first);
    await assert.rejects(readFile(join(project, `${first}.jsonl`)), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(join(project, `${second}.jsonl`), "utf8"),
      "active",
    );
    assert.equal(
      await readFile(join(project, `${unrelated}.jsonl`), "utf8"),
      "keep",
    );
    await registry.end(second);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
