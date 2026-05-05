#!/usr/bin/env bun
/**
 * CI build script for PAL — two-phase approach.
 *
 * Bun.build() API with compile:true hangs on CI runners (the promise
 * never resolves). The CLI `bun build --compile` works but can't load
 * plugins. So we split:
 *
 *   Phase 1: Bun.build() API — bundles with SolidJS plugin, no compile
 *   Phase 2: `bun build --compile` CLI — compiles the pre-bundled JS
 *
 * Phase 1 defines process.platform/process.arch so the @opentui/core
 * dynamic import resolves at bundle time. minify is off so phase 2
 * can safely re-process the bundle.
 */
import { $ } from "bun"
import fs from "fs"
import path from "path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const target = process.argv[2]
const outfile = process.argv[3]
const version = process.env.OPENCODE_VERSION || "0.0.0"
const channel = process.env.OPENCODE_CHANNEL || "latest"

if (!target || !outfile) {
  console.error("Usage: OPENCODE_VERSION=x.y.z bun run ci-build.ts <target> <outfile>")
  process.exit(1)
}

const [, targetOs, targetArch] = target.match(/^bun-(\w+)-(\w+)$/) ?? []
if (!targetOs || !targetArch) {
  console.error(`Invalid target: ${target} (expected bun-<os>-<arch>)`)
  process.exit(1)
}

const dir = path.resolve(import.meta.dir, "..")
const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
const workerPath = "./src/cli/cmd/tui/worker.ts"
const bunfsRoot = targetOs === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

// Load migrations
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

// Phase 1: Bundle with SolidJS transform (no compile)
console.log(`Phase 1: bundling for ${targetOs}-${targetArch}...`)
const plugin = createSolidTransformPlugin()
const outdir = path.resolve(dir, "dist/ci-bundle")
await $`rm -rf ${outdir}`

const bundleResult = await Bun.build({
  conditions: ["browser"],
  plugins: [plugin],
  external: ["node-gyp"],
  format: "esm",
  minify: false,
  sourcemap: "none",
  target: "bun",
  splitting: true,
  entrypoints: ["./src/index.ts", parserWorker, workerPath],
  outdir,
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

if (!bundleResult.success) {
  console.error("Phase 1 failed:")
  for (const log of bundleResult.logs) console.error(log)
  process.exit(1)
}

const entryBundle = bundleResult.outputs.find((o) => o.path.endsWith("index.js"))
if (!entryBundle) {
  console.error("Could not find index.js in bundle output")
  process.exit(1)
}
console.log(`  -> ${entryBundle.path}`)

// Phase 2: Compile with CLI (doesn't hang)
console.log(`Phase 2: compiling ${target} -> ${outfile}`)
await $`bun build --compile --target=${target} --no-compile-autoload-bunfig --outfile ${outfile} ${entryBundle.path}`

console.log(`Done: ${outfile}`)
process.exit(0)
