import * as Log from "@opencode-ai/core/util/log"
import { execFile, execSync } from "child_process"
import { promisify } from "util"
import * as PalConfig from "@/config/pal-config"

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

export function resolveWing(projectHint?: string): string {
  if (projectHint) {
    const wingMap = PalConfig.get().mempalace?.wingMap
    if (wingMap && wingMap[projectHint]) {
      return wingMap[projectHint]
    }
  }
  return deriveWing()
}

export async function writeAnalysis(
  sourceId: string,
  title: string,
  summary: string,
  action: string | null,
  urgency: number,
  wing?: string,
): Promise<void> {
  const bin = ensureInstalled()
  if (!bin) return

  const resolvedWing = wing ?? deriveWing()
  const lines = [
    `[${sourceId}] ${title}`,
    `State: ${summary}`,
    `Action: ${action ?? "none"}`,
    `Urgency: ${urgency}/10`,
  ]
  const content = lines.join("\n")

  log.info("writing analysis to mempalace", { sourceId, wing: resolvedWing })

  try {
    await execFileAsync(
      bin,
      ["add", "--wing", resolvedWing, "--room", "analysis", "--content", content],
      { encoding: "utf-8", timeout: 10_000 },
    )
    log.info("mempalace write succeeded", { sourceId })
  } catch (err) {
    log.error("mempalace write failed", { sourceId, error: err })
  }
}

export async function searchRelated(query: string, projectHint?: string): Promise<string> {
  const bin = ensureInstalled()
  if (!bin) return ""

  const wing = resolveWing(projectHint)
  log.info("searching mempalace", { query: query.slice(0, 100), wing: wing ?? "(all)" })

  try {
    const args = ["search", query.slice(0, 200), "--results", "3"]
    if (wing) {
      args.push("--wing", wing)
    }
    const { stdout } = await execFileAsync(bin, args, { encoding: "utf-8", timeout: 10_000 })
    const result = stdout.trim()
    log.info("mempalace search returned results", { resultLength: result.length })
    return result
  } catch (err) {
    log.error("mempalace search failed", { error: err })
    return ""
  }
}
