import * as Log from "@opencode-ai/core/util/log"
import { generateObject } from "ai"
import z from "zod"
import { Database } from "@/storage/db"
import { ActivityEventTable } from "@/activity-feed/activity-feed.sql"
import { SweepResultTable } from "./sweep.sql"
import { desc, eq, sql } from "drizzle-orm"
import { load as loadProcessDoc } from "@/process/process-doc"
import { get as getRole } from "@/config/role"
import { searchRelated, storeResults, type SweepResult as MemPalaceSweepResult } from "./mempalace"

interface McpTool {
  execute?: (input: any, options?: any) => any
}
type McpToolsAccessor = () => Promise<Record<string, McpTool> | undefined>

const log = Log.create({ service: "sweep" })

const SWEEP_SCHEMA = z.object({
  summary: z.string().describe("1-2 sentence summary of the issue's current state"),
  action: z.string().describe("What the user should do next given their role"),
  priority: z.enum(["urgent", "soon", "normal", "low"]).describe("How urgently this needs attention"),
  phase: z.string().optional().describe("Where in the team process this work item is"),
})

const CONCURRENCY = 5
let sweeping = false
let modelInstance: any = null

async function getModel() {
  if (modelInstance) return modelInstance
  try {
    const { createVertexAnthropic } = await import("@ai-sdk/google-vertex/anthropic")
    const vertex = createVertexAnthropic({
      project: process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION ?? "global",
    })
    modelInstance = vertex("claude-sonnet-4-6@default")
    return modelInstance
  } catch (err) {
    log.error("failed to create model for sweep", { error: err })
    return null
  }
}

interface IssueSnapshot {
  source_id: string
  source: string
  title: string
  url: string | null
  actor: string | null
  last_event_ts: number
  feed: string | null
  mode: string | null
  events: Array<{
    event_type: string
    summary: string | null
    actor: string | null
    timestamp: number
    metadata: Record<string, unknown> | null
  }>
}

function loadIssueSnapshots(): IssueSnapshot[] {
  return Database.use((db) => {
    const rows = db
      .select()
      .from(ActivityEventTable)
      .orderBy(desc(ActivityEventTable.timestamp))
      .limit(1000)
      .all()

    const byIssue = new Map<string, IssueSnapshot>()
    for (const row of rows) {
      const key = row.source_id
      if (!byIssue.has(key)) {
        byIssue.set(key, {
          source_id: key,
          source: row.source,
          title: row.title,
          url: row.url,
          actor: row.actor,
          last_event_ts: row.timestamp,
          feed: row.feed ?? null,
          mode: row.mode ?? null,
          events: [],
        })
      }
      byIssue.get(key)!.events.push({
        event_type: row.event_type,
        summary: row.summary,
        actor: row.actor,
        timestamp: row.timestamp,
        metadata: row.metadata as Record<string, unknown> | null,
      })
    }
    return Array.from(byIssue.values())
  })
}

function buildIssueContext(issue: IssueSnapshot, memoryContext?: string): string {
  const lines: string[] = [
    `Title: ${issue.title}`,
    `Source: ${issue.source} (${issue.source_id})`,
    `URL: ${issue.url ?? "none"}`,
    `Latest activity: ${new Date(issue.last_event_ts).toISOString()}`,
  ]

  if (memoryContext && memoryContext.trim().length > 0) {
    lines.push("", "=== RELATED CONTEXT FROM MEMORY ===", memoryContext)
  }

  lines.push("", "Recent events:")
  for (const evt of issue.events.slice(0, 10)) {
    const ts = new Date(evt.timestamp).toISOString().slice(0, 10)
    lines.push(`  - [${ts}] ${evt.event_type}: ${evt.summary ?? "(no summary)"} (by ${evt.actor ?? "unknown"})`)

    const meta = evt.metadata
    if (meta) {
      if (meta.status) lines.push(`    Status: ${meta.status}`)
      if (meta.priority) lines.push(`    Priority: ${meta.priority}`)
      if (meta.assignee) lines.push(`    Assignee: ${meta.assignee}`)
      if (meta.description) {
        const desc = String(meta.description).slice(0, 500)
        lines.push(`    Description: ${desc}${String(meta.description).length > 500 ? "..." : ""}`)
      }
    }
  }
  return lines.join("\n")
}

async function sweepIssue(issue: IssueSnapshot, processDoc: string, role: string, getMcpTools?: McpToolsAccessor): Promise<void> {
  const model = await getModel()
  if (!model) return

  let memoryContext = ""
  if (getMcpTools) {
    memoryContext = await searchRelated(issue.title, getMcpTools)
  }

  const issueContext = buildIssueContext(issue, memoryContext)

  try {
    const result = await generateObject({
      model,
      schema: SWEEP_SCHEMA,
      system: [
        "You are a process facilitator for a software team.",
        "You understand the team's development process and the user's role in it.",
        "Assess each work item and tell the user specifically what THEY need to do next given their role.",
        "Be concise — 1-2 sentences for summary, 1 sentence for action.",
        "",
        "=== TEAM PROCESS ===",
        processDoc,
        "",
        "=== USER'S ROLE ===",
        role,
      ].join("\n"),
      prompt: issueContext,
      maxOutputTokens: 300,
      temperature: 0,
    })

    Database.use((db) => {
      db.insert(SweepResultTable)
        .values({
          source_id: issue.source_id,
          source: issue.source,
          title: issue.title,
          summary: result.object.summary,
          action: result.object.action,
          priority: result.object.priority,
          phase: result.object.phase ?? null,
          url: issue.url,
          actor: issue.actor,
          last_event_ts: issue.last_event_ts,
          swept_at: Date.now(),
          feed: issue.feed,
          mode: issue.mode,
        })
        .onConflictDoUpdate({
          target: SweepResultTable.source_id,
          set: {
            title: issue.title,
            summary: result.object.summary,
            action: result.object.action,
            priority: result.object.priority,
            phase: result.object.phase ?? null,
            url: issue.url,
            actor: issue.actor,
            last_event_ts: issue.last_event_ts,
            swept_at: Date.now(),
            feed: issue.feed,
            mode: issue.mode,
          },
        })
        .run()
    })

    log.info("swept issue", { source_id: issue.source_id, priority: result.object.priority })
  } catch (err) {
    log.error("failed to sweep issue", { source_id: issue.source_id, error: err })
  }
}

async function sweepBatch(issues: IssueSnapshot[], processDoc: string, role: string, getMcpTools?: McpToolsAccessor): Promise<number> {
  let swept = 0
  for (let i = 0; i < issues.length; i += CONCURRENCY) {
    const batch = issues.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map((issue) => sweepIssue(issue, processDoc, role, getMcpTools)))
    swept += batch.length
    log.info("sweep progress", { swept, total: issues.length })
  }
  return swept
}

export async function runFullSweep(opts?: { getMcpTools?: McpToolsAccessor }): Promise<number> {
  if (sweeping) {
    log.info("sweep already in progress, skipping")
    return 0
  }

  const processDoc = loadProcessDoc()
  if (!processDoc) {
    log.info("no process doc found, skipping sweep")
    return 0
  }

  const role = getRole()
  if (!role) {
    log.info("no role configured, skipping sweep")
    return 0
  }

  sweeping = true
  try {
    const issues = loadIssueSnapshots()
    log.info("starting full sweep", { issues: issues.length })
    const swept = await sweepBatch(issues, processDoc, role, opts?.getMcpTools)
    log.info("full sweep complete", { swept })

    if (opts?.getMcpTools && swept > 0) {
      const results = getSweepResults()
      await storeResults(
        results.map((r): MemPalaceSweepResult => ({
          source_id: r.source_id,
          title: r.title,
          summary: r.summary,
          action: r.action,
          priority: r.priority,
          phase: r.phase,
        })),
        opts.getMcpTools,
      )
    }

    return swept
  } finally {
    sweeping = false
  }
}

export async function sweepChanged(changedSourceIds: string[], opts?: { getMcpTools?: McpToolsAccessor }): Promise<number> {
  if (sweeping || changedSourceIds.length === 0) return 0

  const processDoc = loadProcessDoc()
  const role = getRole()
  if (!processDoc || !role) return 0

  const issues = loadIssueSnapshots().filter((i) => changedSourceIds.includes(i.source_id))
  if (issues.length === 0) return 0

  sweeping = true
  try {
    log.info("sweeping changed issues", { count: issues.length })
    return await sweepBatch(issues, processDoc, role, opts?.getMcpTools)
  } finally {
    sweeping = false
  }
}

export function getSweepResults(): Array<{
  source_id: string
  source: string
  title: string
  summary: string
  action: string
  priority: string
  phase: string | null
  url: string | null
  actor: string | null
  last_event_ts: number
  swept_at: number
  feed: string | null
  mode: string | null
}> {
  try {
    return Database.use((db) =>
      db
        .select()
        .from(SweepResultTable)
        .orderBy(
          sql`CASE priority WHEN 'urgent' THEN 0 WHEN 'soon' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END`,
          desc(SweepResultTable.last_event_ts),
        )
        .all(),
    )
  } catch {
    return []
  }
}
