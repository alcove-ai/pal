import fsNode from "fs"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "process-doc" })

let cached: string | null | undefined
let watchedPath: string | undefined
let watcher: fsNode.FSWatcher | undefined

function resolve(): string | null {
  const cwd = process.cwd()
  const candidates = [
    path.join(cwd, ".opencode", "process.md"),
    path.join(cwd, "CONTRIBUTING.md"),
  ]
  for (const p of candidates) {
    if (fsNode.existsSync(p)) return p
  }
  return null
}

function read(filePath: string): string | null {
  try {
    return fsNode.readFileSync(filePath, "utf-8")
  } catch {
    return null
  }
}

function watch(filePath: string): void {
  if (watcher && watchedPath === filePath) return
  if (watcher) { try { watcher.close() } catch {} }
  watchedPath = filePath
  try {
    watcher = fsNode.watch(filePath, () => {
      log.info("process doc changed, reloading")
      cached = read(filePath)
    })
    watcher.on("error", () => {})
  } catch {}
}

export function load(): string | null {
  if (cached !== undefined) return cached
  const filePath = resolve()
  if (!filePath) {
    log.info("no process doc found (.opencode/process.md or CONTRIBUTING.md)")
    cached = null
    return null
  }
  cached = read(filePath)
  if (cached) {
    log.info("loaded process doc", { path: filePath, length: cached.length })
    watch(filePath)
  }
  return cached
}

export function reload(): string | null {
  cached = undefined
  return load()
}
