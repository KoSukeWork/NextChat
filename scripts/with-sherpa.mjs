// Pinned, verified native dependencies. Web builds do not invoke this script.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifests = JSON.parse(
  await fs.readFile(path.join(root, "scripts/sherpa-native.json"), "utf8"),
);
const platform = `${process.platform}-${process.arch}`;
const spec = manifests[platform];
if (!spec) throw new Error(`No verified sherpa-onnx build for ${platform}`);
const cache = path.join(root, "src-tauri/target/sherpa-native");
const current = path.join(cache, "current");
const stamp = path.join(current, "verified.json");
const exists = async (p) => !!(await fs.stat(p).catch(() => null));
async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function prepare() {
  if (await exists(current)) {
    const verified = JSON.parse(await fs.readFile(stamp, "utf8"));
    if (verified.sha256 !== spec.sha256 || verified.platform !== platform)
      throw new Error(
        `Native cache differs from the pinned platform/version: ${current}`,
      );
    return;
  }
  await fs.mkdir(cache, { recursive: true });
  const archive =
    process.env.NEXTCHAT_SHERPA_ARCHIVE || path.join(cache, spec.name);
  if (!(await exists(archive))) {
    // Bounded ranges also work on connections where a single large transfer stalls.
    const parts = path.join(cache, `${spec.name}.parts`);
    await fs.mkdir(parts, { recursive: true });
    const chunkSize = 4 * 1024 * 1024;
    const ranges = Array.from(
      { length: Math.ceil(spec.bytes / chunkSize) },
      (_, i) => i * chunkSize,
    );
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (cursor < ranges.length) {
          const start = ranges[cursor++];
          const end = Math.min(start + chunkSize, spec.bytes) - 1;
          const file = path.join(parts, String(start));
          if ((await fs.stat(file).catch(() => null))?.size === end - start + 1)
            continue;
          let lastError;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const response = await fetch(spec.url, {
                headers: { Range: `bytes=${start}-${end}` },
                signal: AbortSignal.timeout(120_000),
              });
              if (response.status !== 206)
                throw new Error(
                  `Range download returned HTTP ${response.status}`,
                );
              const data = Buffer.from(await response.arrayBuffer());
              if (data.length !== end - start + 1)
                throw new Error("Wrong range length");
              await fs.writeFile(file, data);
              lastError = undefined;
              break;
            } catch (error) {
              lastError = error;
            }
          }
          if (lastError) throw lastError;
        }
      }),
    );
    const temporary = `${archive}.${randomUUID()}.tmp`;
    const output = await fs.open(temporary, "wx");
    try {
      for (const start of ranges)
        await output.writeFile(
          await fs.readFile(path.join(parts, String(start))),
        );
    } finally {
      await output.close();
    }
    if ((await hash(temporary)) !== spec.sha256) {
      await fs.unlink(temporary);
      throw new Error("sherpa-onnx archive SHA256 mismatch");
    }
    await fs.rename(temporary, archive);
  }
  if (
    (await fs.stat(archive)).size !== spec.bytes ||
    (await hash(archive)) !== spec.sha256
  )
    throw new Error("sherpa-onnx archive size/SHA256 mismatch");
  const stage = await fs.mkdtemp(path.join(cache, "extract-"));
  try {
    // Only the exact pinned archive reaches tar; model imports use the Rust path validator.
    const result = spawnSync("tar", ["-xjf", archive, "-C", stage], {
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error || result.status !== 0)
      throw result.error || new Error("Native archive extraction failed");
    const extracted = path.join(stage, spec.name.replace(/\.tar\.bz2$/, ""));
    if (!(await exists(path.join(extracted, "lib"))))
      throw new Error("Native archive has no lib directory");
    await fs.writeFile(
      path.join(extracted, "verified.json"),
      JSON.stringify({ ...spec, platform }, null, 2),
    );
    await fs.rename(extracted, current);
  } finally {
    const realCache = await fs.realpath(cache);
    const realStage = await fs.realpath(stage);
    if (
      path.dirname(realStage) !== realCache ||
      !path.basename(realStage).startsWith("extract-")
    ) throw new Error("Refusing to clean a path outside the native staging directory");
    await fs.rm(realStage, { recursive: true, force: true });
  }
  console.log(
    `Verified sherpa-onnx ${manifests.version || "2.0.1"} for ${platform}`,
  );
}

await prepare();
const [command, ...args] = process.argv.slice(2);
if (command) {
  const env = {
    ...process.env,
    SHERPA_ONNX_LIB_DIR: path.join(current, "lib"),
  };
  const executable = command === "tauri" ? process.execPath : command;
  const argv =
    command === "tauri"
      ? [path.join(root, "node_modules/@tauri-apps/cli/tauri.js"), ...args]
      : args;
  const result = spawnSync(executable, argv, {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
