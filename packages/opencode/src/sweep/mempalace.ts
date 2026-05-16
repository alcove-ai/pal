import * as Log from "@opencode-ai/core/util/log"
import { execSync } from "child_process"

const log = Log.create({ service: "sweep.mempalace" })

let mempalaceBin: string | null | undefined

function ensureInstalled(): string | null {
  if (mempalaceBin !== undefined) return mempalaceBin
  try {
    mempalaceBin = execSync("which mempalace", { encoding: "utf-8", timeout: 5000 }).trim()
    return mempalaceBin
  } catch {
    try {
      log.info("installing mempalace...")
      execSync("uv tool install mempalace", { encoding: "utf-8", timeout: 120_000 })
      mempalaceBin = execSync("which mempalace", { encoding: "utf-8", timeout: 5000 }).trim()
      log.info("mempalace installed", { path: mempalaceBin })
      return mempalaceBin
    } catch {
      log.info("could not install mempalace, memory features disabled")
      mempalaceBin = null
      return null
    }
  }
}

function deriveWing(): string {
  return process.cwd().replace(/\//g, "_")
}

export function searchRelated(query: string): string {
  const bin = ensureInstalled()
  if (!bin) return ""

  const wing = deriveWing()
  try {
    const result = execSync(
      `${bin} search ${JSON.stringify(query.slice(0, 200))} --wing ${JSON.stringify(wing)} --results 3`,
      { encoding: "utf-8", timeout: 10_000 },
    )
    return result.trim()
  } catch {
    return ""
  }
}

export function isAvailable(): boolean {
  return ensureInstalled() !== null
}
