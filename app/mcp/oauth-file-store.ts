import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OAuthCredentials } from "./oauth";

/** Local-only credentials; never included in MCP config, sync or backup. */
export class OAuthFileStore {
  private operations: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => {});
    return result;
  }

  private async readAll(): Promise<Record<string, OAuthCredentials>> {
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error();
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
      throw new Error("OAuth credentials are unavailable");
    }
  }

  private async writeAll(entries: Record<string, OAuthCredentials>) {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const temporary = path.join(dir, `.mcp-oauth-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(entries), {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporary, this.file);
    } catch {
      await fs.unlink(temporary).catch(() => {});
      throw new Error("OAuth credentials could not be saved");
    }
  }

  read(id: string, serverUrl: string) {
    return this.queue(async () => {
      const entries = await this.readAll();
      const entry = Object.prototype.hasOwnProperty.call(entries, id)
        ? entries[id]
        : undefined;
      return entry?.serverUrl === serverUrl ? entry : undefined;
    });
  }

  write(
    id: string,
    serverUrl: string,
    credentials: OAuthCredentials,
    isCurrent?: () => Promise<boolean>,
  ) {
    return this.queue(async () => {
      if (isCurrent && !(await isCurrent()))
        throw new Error("MCP server changed");
      if (
        credentials.serverUrl !== serverUrl ||
        ["__proto__", "constructor", "prototype"].includes(id)
      )
        throw new Error("Invalid OAuth credentials");
      const entries = await this.readAll();
      entries[id] = credentials;
      await this.writeAll(entries);
    });
  }

  /** Serialize config changes with refresh and callback credential writes. */
  withConfiguration<T>(
    operation: (remove: (ids: string[]) => Promise<void>) => Promise<T>,
  ) {
    return this.queue(async () =>
      operation(async (ids) => {
        if (!ids.length) return;
        const entries = await this.readAll();
        let changed = false;
        for (const id of ids) {
          if (Object.prototype.hasOwnProperty.call(entries, id)) {
            delete entries[id];
            changed = true;
          }
        }
        if (changed) await this.writeAll(entries);
      }),
    );
  }

  remove(id: string) {
    return this.queue(async () => {
      const entries = await this.readAll();
      if (!Object.prototype.hasOwnProperty.call(entries, id)) return;
      delete entries[id];
      await this.writeAll(entries);
    });
  }
}
