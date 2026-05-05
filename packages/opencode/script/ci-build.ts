#!/usr/bin/env bun
/**
 * CI build script for PAL — bundle only (no compile).
 *
 * Bun.build() API hangs on the CI runner after the promise resolves.
 * This script uses a hard timeout to force exit after bundling.
 * The CI pipeline then calls `bun build --compile` CLI separately.
 */
import fs from "fs"
import path from "path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

// Force exit after 5 minutes no matter what
setTimeout(() => {
  console.error("TIMEOUT: ci-build.ts exceeded 5 minute limit")
  process.exit(2)
}, 300_000)

const outdir = process.argv[2]
const version = process.env.OPENCODE_VERSION || "0.0.0"
const channel = process.env.OPENCODE_CHANNEL || "latest"
const targetOs = process.env.TARGET_OS || "linux"
const targetArch = process.env.TARGET_ARCH || "x64"

if (!outdir) {
  console.error("Usage: TARGET_OS=linux TARGET_ARCH=x64 bun run ci-build.ts <outdir>")
  process.exit(1)
}

const dir = path.resolve(import.meta.dir, "..")
const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
const workerPath = "./src/cli/cmd/tui/worker.ts"
const bunfsRoot = targetOs === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]))
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

const plugin = createSolidTransformPlugin()
const resolvedOutdir = path.resolve(dir, outdir)
fs.rmSync(resolvedOutdir, { recursive: true, force: true })

console.log(`Bundling for ${targetOs}-${targetArch}...`)
const result = await Bun.build({
  conditions: ["browser"],
  plugins: [plugin],
  external: ["node-gyp"],
  format: "esm",
  minify: false,
  sourcemap: "none",
  target: "bun",
  splitting: true,
  entrypoints: ["./src/index.ts", parserWorker, workerPath],
  outdir: resolvedOutdir,
  define: {
    OPENCODE_VERSION: `'${version}'`,
    OPENCODE_CHANNEL: `'${channel}'`,
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
    OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
    OPENCODE_WORKER_PATH: workerPath,
    OPENCODE_LIBC: targetOs === "linux" ? `'glibc'` : "",
    "process.platform": `'${targetOs}'`,
    "process.arch": `'${targetArch}'`,
  },
})

if (!result.success) {
  console.error("Bundle failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const entry = result.outputs.find((o) => o.path.endsWith("index.js"))
console.log(`Bundle: ${entry?.path}`)
process.exit(0)
