import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDriver } from "../plugins/claude-code/driver.mjs";
import { createOwnedSessions } from "../plugins/claude-code/subscription.mjs";

test(
  "official subscription CLI supports a turn and a resumed turn",
  {
    skip: process.env.NEXTCHAT_TEST_REAL_CLAUDE_SUBSCRIPTION !== "1",
    timeout: 180000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nextchat-real-sub-"));
    const dataDirectory = join(root, "data");
    const workDirectory = join(dataDirectory, "subscription-work");
    const driver = await createDriver({
      subscriptionLogin: true,
      dataDirectory,
      workingDirectory: join(root, "gateway-work"),
    });
    let sent = 0;
    try {
      const cliVersion = (await driver.info()).versions[0];
      const base = {
        credentials: "subscription",
        cliVersion,
        model: "sonnet",
        sessionId: "real-test",
        enableTools: false,
      };
      const ask = async (messages) => {
        const events = [];
        // Count conservatively, even if the request fails before reaching Claude.
        sent++;
        await driver.chat(
          { ...base, messages },
          {
            signal: new AbortController().signal,
            emit: async (event) => events.push(event),
          },
        );
        assert.equal(events.at(-1)?.type, "done");
        const reply = events
          .filter((event) => event.type === "text")
          .map((event) => event.text)
          .join("");
        assert.ok(reply.trim());
        return { reply, session: events.at(-1).sessionId };
      };
      const first = await ask([
        { role: "user", content: "Reply with the word hello." },
      ]);
      const second = await ask([
        { role: "user", content: "Reply with the word hello." },
        { role: "assistant", content: first.reply },
        { role: "user", content: "Reply with the word yes." },
      ]);
      assert.equal(second.session, first.session);
    } finally {
      console.log(`Real Claude subscription prompts attempted: ${sent}`);
      await driver.close();
      if (await stat(workDirectory).catch(() => null)) {
        const registry = await createOwnedSessions({
          dataDirectory,
          workDirectory,
          maxSessions: 0,
        });
        await registry.sweep();
        const remaining = (
          await readdir(join(dataDirectory, "subscription-owned"))
        ).filter((name) => name.endsWith(".json"));
        assert.deepEqual(
          remaining,
          [],
          `test-owned transcripts could not be cleaned safely; index kept at ${root}`,
        );
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
