#!/usr/bin/env bun
/**
 * CI build script for PAL.
 *
 * Uses Bun.build() API with compile:true and the SolidJS transform plugin.
 * Calls process.exit(0) after build completes because the API leaves open
 * handles that prevent the process from exiting naturally.
 *
 * Has a 10-minute safety timeout to detect genuine hangs.
 */
import fs from "fs"
import path from "path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

// Safety timeout — if Bun.build() genuinely hangs, exit with error
const TIMEOUT = setTimeout(() => {
  console.error("TIMEOUT: Bun.build() did not complete within 10 minutes")
  process.exit(2)
}, 600_000)

const target = process.argv[2]
const outfile = process.argv[3]
const version = process.env.OPENCODE_VERSION || "0.0.0"
const channel = process.env.OPENCODE_CHANNEL || "latest"

if (!target || !outfile) {
  console.error("Usage: OPENCODE_VERSION=x.y.z bun run ci-build.ts <target> <outfile>")
  process.exit(1)
}

const [, targetOs] = target.match(/^bun-(\w+)-(\w+)$/) ?? []

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

const plugin = createSolidTransformPlugin()

console.log(`Building ${target} -> ${outfile}`)
const result = await Bun.build({
  conditions: ["browser"],
  plugins: [plugin],
  external: ["node-gyp"],
  format: "esm",
  minify: true,
  sourcemap: "none",
  splitting: true,
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: true,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    target: target as any,
    outfile,
  },
  entrypoints: ["./src/index.ts", parserWorker, workerPath],
  define: {
    OPENCODE_VERSION: `'${version}'`,
    OPENCODE_CHANNEL: `'${channel}'`,
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
    OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
    OPENCODE_WORKER_PATH: workerPath,
    OPENCODE_LIBC: targetOs === "linux" ? `'glibc'` : "",
  },
})

clearTimeout(TIMEOUT)

if (!result.success) {
  console.error("Build failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`Done: ${outfile}`)
process.exit(0)
