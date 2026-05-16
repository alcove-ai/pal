import * as Log from "@opencode-ai/core/util/log"
import { execFile, execSync } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)
const log = Log.create({ service: "sweep.mempalace" })

let mempalaceBin: string | null | undefined

function ensureInstalled(): string | null {
  if (mempalaceBin !== undefined) return mempalaceBin
  try {
    mempalaceBin = execSync("which mempalace", { encoding: "utf-8", timeout: 5000 }).trim()
    log.info("found existing mempalace installation", { path: mempalaceBin })
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

export async function searchRelated(query: string): Promise<string> {
  const bin = ensureInstalled()
  if (!bin) return ""

  const wing = deriveWing()
  log.info("searching mempalace", { query: query.slice(0, 100), wing })

  try {
    const { stdout } = await execFileAsync(bin, [
      "search", query.slice(0, 200), "--wing", wing, "--results", "3",
    ], { encoding: "utf-8", timeout: 10_000 })
    const result = stdout.trim()
    log.info("mempalace search returned results", { resultLength: result.length })
    return result
  } catch (err) {
    log.error("mempalace search failed", { error: err })
    return ""
  }
}
