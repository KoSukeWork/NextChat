import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import webpack from "webpack";

const directory = resolve(process.argv[2] || "plugins/claude-code");
const manifest = JSON.parse(
  await readFile(resolve(directory, "manifest.json"), "utf8"),
);
// Bundle dependencies once at publication time. Installed packages remain a
// self-contained ESM and never resolve imports in the user's browser.
const tempRoot = resolve(tmpdir());
const buildDirectory = await mkdtemp(resolve(tempRoot, "nextchat-plugin-"));
let source;
try {
  const compiler = webpack({
    mode: "production",
    context: directory,
    entry: "./index.mjs",
    target: ["webworker", "es2022"],
    devtool: false,
    experiments: { outputModule: true },
    optimization: { minimize: false },
    output: {
      path: buildDirectory,
      filename: "plugin.mjs",
      library: { type: "module" },
    },
  });
  try {
    await new Promise((resolve, reject) =>
      compiler.run((error, stats) => {
        if (error || stats.hasErrors())
          reject(
            error || new Error(stats.toString({ all: false, errors: true })),
          );
        else if (
          stats.compilation
            .getAssets()
            .some((asset) => asset.name !== "plugin.mjs")
        )
          reject(
            new Error(
              "Plugin must bundle into one ESM file; dynamic chunks and external assets are unsupported",
            ),
          );
        else resolve();
      }),
    );
    source = await readFile(resolve(buildDirectory, "plugin.mjs"), "utf8");
  } finally {
    await new Promise((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve())),
    );
  }
} finally {
  const childPath = relative(tempRoot, resolve(buildDirectory));
  if (!childPath || childPath.startsWith("..") || isAbsolute(childPath))
    throw new Error("Refusing to clean a build directory outside the temp root");
  await rm(buildDirectory, { recursive: true, force: true });
}
const target = resolve(
  process.argv[3] ||
    `public/request-plugins/${manifest.id}-${manifest.version}.json`,
);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify({ manifest, source }, null, 2) + "\n");
console.log(target);
