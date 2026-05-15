import fsNode from "fs"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "config.role" })

let cached: string | null | undefined

function rolePath(): string {
  return path.join(process.cwd(), ".opencode", "role.md")
}

export function get(): string | null {
  if (cached !== undefined) return cached
  const p = rolePath()
  try {
    if (!fsNode.existsSync(p)) {
      cached = null
      return null
    }
    cached = fsNode.readFileSync(p, "utf-8").trim()
    log.info("loaded role", { path: p })
    return cached
  } catch {
    cached = null
    return null
  }
}

export function set(content: string): void {
  const p = rolePath()
  const dir = path.dirname(p)
  try {
    if (!fsNode.existsSync(dir)) fsNode.mkdirSync(dir, { recursive: true })
    fsNode.writeFileSync(p, content + "\n", "utf-8")
    cached = content.trim()
    log.info("saved role", { path: p })
  } catch (err) {
    log.error("failed to save role", { error: err })
  }
}

export function clear(): void {
  cached = undefined
}

export * as Role from "./role"
