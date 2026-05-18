import * as Log from "@opencode-ai/core/util/log"
import { Database } from "@/storage/db"
import { ActivityEventTable } from "@/activity-feed/activity-feed.sql"
import { SweepResultTable } from "./sweep.sql"
import { desc, eq, sql } from "drizzle-orm"
import { load as loadProcessDoc } from "@/process/process-doc"
import { get as getRole } from "@/config/role"
import { searchRelated } from "./mempalace"

const log = Log.create({ service: "sweep" })

const CONCURRENCY = 3
let sweeping = false

let authClient: any = null

async function getAuthToken(): Promise<string | null> {
  try {
    if (!authClient) {
      const { GoogleAuth } = await import("google-auth-library")
      const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
      authClient = await auth.getClient()
    }
    const token = await authClient.getAccessToken()
    return token?.token ?? null
  } catch (err) {
    log.error("failed to get GCP auth token for sweep", { error: err })
    return null
  }
}

async function callVertexClaude(system: string, prompt: string): Promise<{ summary: string; action: string; priority: string; phase?: string } | null> {
  const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? "global"
  if (!project) { log.error("GOOGLE_CLOUD_PROJECT not set"); return null }

  const token = await getAuthToken()
  if (!token) return null

  const host = location === "global" ? "" : `${location}-`
  const url = `https://${host}aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models/claude-sonnet-4-6@default:rawPredict`

  const body = {
    anthropic_version: "vertex-2023-10-16",
    max_tokens: 400,
    temperature: 0,
    system,
    messages: [{ role: "user", content: prompt }],
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })

  if (!resp.ok) {
    log.error("vertex API error", { status: resp.status, body: (await resp.text()).slice(0, 200) })
    return null
  }

  const result = await resp.json() as any
  const text = result.content?.[0]?.text ?? ""

  try {
    const parsed = JSON.parse(text)
    return {
      summary: parsed.summary ?? "No summary",
      action: parsed.action ?? "Review this item",
      priority: parsed.priority ?? "normal",
      phase: parsed.phase,
    }
  } catch {
    return { summary: text.slice(0, 200), action: "Review this item", priority: "normal" }
  }
}

export interface IssueSnapshot {
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

export function buildSystemPrompt(processDoc: string, role: string): string {
  return [
    "You are a process facilitator for a software team.",
    "You understand the team's development process and the user's role in it.",
    "Assess each work item and tell the user specifically what THEY need to do next given their role.",
    "Respond with ONLY a JSON object: {\"summary\": \"...\", \"action\": \"...\", \"priority\": \"urgent|soon|normal|low\", \"phase\": \"...\"}",
    "Be concise — 1-2 sentences for summary, 1 sentence for action.",
    "",
    "=== TEAM PROCESS ===",
    processDoc,
    "",
    "=== USER'S ROLE ===",
    role,
  ].join("\n")
}

export function buildIssueContext(issue: IssueSnapshot, memoryContext?: string): string {
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
      if (meta.parent_key) lines.push(`    Parent: ${meta.parent_key}`)
      if (meta.issue_type) lines.push(`    Type: ${meta.issue_type}`)
      if (meta.milestone) lines.push(`    Milestone: ${meta.milestone}`)
      if (meta.components && Array.isArray(meta.components) && meta.components.length > 0) lines.push(`    Components: ${meta.components.join(", ")}`)
      if (meta.labels && Array.isArray(meta.labels) && meta.labels.length > 0) lines.push(`    Labels: ${meta.labels.join(", ")}`)
    }
  }
  return lines.join("\n")
}

async function sweepIssue(issue: IssueSnapshot, processDoc: string, role: string): Promise<void> {
  const memoryContext = await searchRelated(issue.title)
  const issueContext = buildIssueContext(issue, memoryContext)

  const system = buildSystemPrompt(processDoc, role)

  try {
    const result = await callVertexClaude(system, issueContext)
    if (!result) return

    Database.use((db) => {
      db.insert(SweepResultTable)
        .values({
          source_id: issue.source_id,
          source: issue.source,
          title: issue.title,
          summary: result.summary,
          action: result.action,
          priority: result.priority,
          phase: result.phase ?? null,
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
            summary: result.summary,
            action: result.action,
            priority: result.priority,
            phase: result.phase ?? null,
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

    log.info("swept issue", { source_id: issue.source_id, priority: result.priority })
  } catch (err) {
    log.error("failed to sweep issue", { source_id: issue.source_id, error: err })
  }
}

async function sweepBatch(issues: IssueSnapshot[], processDoc: string, role: string): Promise<number> {
  let swept = 0
  for (let i = 0; i < issues.length; i += CONCURRENCY) {
    const batch = issues.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map((issue) => sweepIssue(issue, processDoc, role)))
    swept += batch.length
    log.info("sweep progress", { swept, total: issues.length })
  }
  return swept
}

export async function runFullSweep(): Promise<number> {
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
    const swept = await sweepBatch(issues, processDoc, role)
    log.info("full sweep complete", { swept })
    return swept
  } finally {
    sweeping = false
  }
}

export async function sweepChanged(changedSourceIds: string[]): Promise<number> {
  if (sweeping || changedSourceIds.length === 0) return 0

  const processDoc = loadProcessDoc()
  const role = getRole()
  if (!processDoc || !role) return 0

  const issues = loadIssueSnapshots().filter((i) => changedSourceIds.includes(i.source_id))
  if (issues.length === 0) return 0

  sweeping = true
  try {
    log.info("sweeping changed issues", { count: issues.length })
    return await sweepBatch(issues, processDoc, role)
  } finally {
    sweeping = false
  }
}

export async function sweepSingle(sourceId: string): Promise<{
  summary: string
  action: string
  priority: string
  phase?: string
} | null> {
  const processDoc = loadProcessDoc()
  const role = getRole()
  if (!processDoc || !role) {
    log.info("no process doc or role configured, cannot sweep")
    return null
  }

  // Find the issue in recent activity events
  const issues = loadIssueSnapshots()
  const issue = issues.find((i) => i.source_id === sourceId)
  if (!issue) {
    log.info("issue not found in activity snapshots", { sourceId })
    return null
  }

  // Search mempalace for related context
  const memoryContext = await searchRelated(issue.title)
  if (memoryContext) {
    log.info("mempalace context found for issue", { sourceId, contextLength: memoryContext.length })
  } else {
    log.info("no mempalace context found for issue", { sourceId })
  }
  const issueContext = buildIssueContext(issue, memoryContext)

  const system = buildSystemPrompt(processDoc, role)

  try {
    const result = await callVertexClaude(system, issueContext)
    if (result) {
      log.info("swept single issue", { source_id: sourceId, priority: result.priority })
    }
    return result
  } catch (err) {
    log.error("failed to sweep single issue", { sourceId, error: err })
    return null
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
