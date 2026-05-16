import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "sweep.mempalace" })

interface McpTool {
  execute?: (input: any, options?: any) => any
}

type McpToolsAccessor = () => Promise<Record<string, McpTool> | undefined>

function deriveWing(): string {
  return process.cwd().replace(/\//g, "_")
}

function findTool(tools: Record<string, McpTool>, substring: string): McpTool | null {
  const name = Object.keys(tools).find((n) => n.includes(substring))
  if (!name) return null
  const tool = tools[name]
  return tool?.execute ? tool : null
}

function extractText(result: unknown): string {
  if (!result || typeof result !== "object") return ""
  const r = result as Record<string, unknown>
  if ("structuredContent" in r && r.structuredContent) {
    const sc = r.structuredContent as Record<string, unknown>
    if (typeof sc.result === "string") return sc.result
  }
  if ("content" in r && Array.isArray(r.content)) {
    for (const item of r.content) {
      if (item && typeof item === "object" && "text" in item) return String(item.text)
    }
  }
  if (typeof r === "object" && "text" in r) return String(r.text)
  return ""
}

export interface SweepResult {
  source_id: string
  title: string
  summary: string
  action: string
  priority: string
  phase: string | null
}

export async function storeResults(
  results: SweepResult[],
  getMcpTools: McpToolsAccessor,
): Promise<number> {
  let tools: Record<string, McpTool> | undefined
  try {
    tools = await getMcpTools()
  } catch {
    log.info("MCP tools not available, skipping mempalace store")
    return 0
  }
  if (!tools) return 0

  const checkDup = findTool(tools, "mempalace_check_duplicate")
  const addDrawer = findTool(tools, "mempalace_add_drawer")
  if (!addDrawer) {
    log.info("mempalace_add_drawer not found, skipping store")
    return 0
  }

  const wing = deriveWing()
  let stored = 0

  for (const result of results) {
    const content = [
      `# ${result.title}`,
      `Issue: ${result.source_id}`,
      `Priority: ${result.priority}`,
      `Phase: ${result.phase ?? "unknown"}`,
      "",
      `Summary: ${result.summary}`,
      `Action: ${result.action}`,
    ].join("\n")

    try {
      if (checkDup) {
        const dupResult = await checkDup.execute!(
          { content, threshold: 0.9 },
          { abortSignal: AbortSignal.timeout(5000) },
        )
        const dupText = extractText(dupResult)
        if (dupText.includes("duplicate") || dupText.includes("similar")) {
          continue
        }
      }

      await addDrawer.execute!(
        { wing, room: "sweep", content, added_by: "pal-sweep" },
        { abortSignal: AbortSignal.timeout(5000) },
      )
      stored++
    } catch (err) {
      log.info("failed to store result in mempalace", { source_id: result.source_id, error: err })
    }
  }

  if (stored > 0) log.info("stored sweep results in mempalace", { stored, total: results.length, wing })
  return stored
}

export async function searchRelated(
  query: string,
  getMcpTools: McpToolsAccessor,
): Promise<string> {
  let tools: Record<string, McpTool> | undefined
  try {
    tools = await getMcpTools()
  } catch {
    return ""
  }
  if (!tools) return ""

  const searchTool = findTool(tools, "mempalace_search")
  if (!searchTool) return ""

  const wing = deriveWing()

  try {
    const result = await searchTool.execute!(
      { query: query.slice(0, 250), wing, room: "sweep", limit: 3, max_distance: 1.0 },
      { abortSignal: AbortSignal.timeout(5000) },
    )
    const text = extractText(result)
    return text.trim()
  } catch {
    return ""
  }
}
