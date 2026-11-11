import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
const run = promisify(execFile);
const bun = process.argv[2] || "bun";
const output = resolve(process.argv[3] || "build/nextchat-wire-relay.exe");
const { stdout } = await run(bun, ["--revision"], { windowsHide: true });
if (
  stdout.trim() !== "1.4.4+38afee6c8" ||
  process.platform !== "win32" ||
  process.arch !== "x64"
)
  throw new Error(
    "This verified target requires the official Bun 1.4.4+38afee6c8 Windows x64 runtime",
  );
await mkdir(dirname(output), { recursive: true });
await run(
  bun,
  ["build", "--compile", "./scripts/wire-relay.mjs", "--outfile", output],
  { windowsHide: true },
);
const verification = await run(output, ["--version"], { windowsHide: true });
console.log(output);
console.log(verification.stdout.trim());
