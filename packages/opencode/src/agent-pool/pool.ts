import { eq } from "drizzle-orm"
import * as Log from "@opencode-ai/core/util/log"
import { Database } from "@/storage/db"
import { AgentResultTable } from "./pool.sql"
import { searchRelated, writeAnalysis, resolveWing } from "@/sweep/mempalace"
import type { ActivityItem } from "@/needs-me/needs-me-logic"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

const log = Log.create({ service: "agent-pool" })

const MIN_CONCURRENT = 1
const MAX_CONCURRENT_CEILING = 20
let maxConcurrent = 10
const POLL_INTERVAL_MS = 2_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentResult {
  sourceId: string
  sessionId: string | null
  summary: string
  recommendedAction: string | null
  urgency: number
  status: "running" | "done" | "error"
  analyzedEventTs: number
  analyzedAt: number
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let api: TuiPluginApi | undefined
let timer: ReturnType<typeof setInterval> | undefined

/** Items waiting to be analyzed. */
const queue: ActivityItem[] = []

/** source_id -> in-flight tracking for all active sessions. */
const running = new Map<
  string,
  {
    sessionId: string
    item: ActivityItem
    startedAt: number
    userInitiated: boolean
  }
>()

/** source_id -> result for already-completed analyses (in-memory cache). */
const results = new Map<string, AgentResult>()

/** Set of source_ids currently queued, to avoid duplicates. */
const queued = new Set<string>()

/**
 * Cross-references between items: primary source_id -> linked ActivityItems.
 * Populated by the link resolver after each Needs Me refresh cycle.
 * When a Jira issue links to PRs, the issue is the primary and the PRs are linked.
 * When a PR links to a Jira issue, the PR is the primary and the issue is linked.
 */
const linkedItems = new Map<string, ActivityItem[]>()

/**
 * Reverse index: source_id of a linked (non-primary) item -> primary source_id.
 * Used by queueAnalysis() to skip items that will be analyzed as part of a primary item.
 */
const linkedSecondaryIds = new Set<string>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractProject(sourceId: string): string | undefined {
  const jiraMatch = sourceId.match(/^([A-Z]+)-\d+$/)
  if (jiraMatch) return jiraMatch[1]
  return undefined
}

function rowToResult(row: typeof AgentResultTable.$inferSelect): AgentResult {
  return {
    sourceId: row.source_id,
    sessionId: row.session_id ?? null,
    summary: row.summary,
    recommendedAction: row.recommended_action ?? null,
    urgency: row.urgency,
    status: row.status as AgentResult["status"],
    analyzedEventTs: row.analyzed_event_ts,
    analyzedAt: row.analyzed_at,
  }
}

function loadResultsFromDb(): void {
  try {
    Database.use((db) => {
      const rows = db.select().from(AgentResultTable).all()
      for (const row of rows) {
        results.set(row.source_id, rowToResult(row))
      }
    })
  } catch {
    // DB may not be ready yet; skip
  }
}

function buildPrompt(item: ActivityItem, mempalaceContext?: string): string {
  // Build the related items section if cross-references exist
  let relatedSection = ""
  const links = linkedItems.get(item.source_id)
  if (links && links.length > 0) {
    const lines = links.map((linked) => {
      const kind = linked.source.startsWith("jira") ? "Issue" : "PR"
      const label = linked.source_id.replace(/^(github|jira):/, "")
      return `- [${kind}] ${label} "${linked.title}" (${linked.url ?? "no url"})`
    })
    relatedSection = `
=== RELATED ITEMS ===
${lines.join("\n")}

`
  }

  // Build the mempalace context section if available
  let mempalaceSection = ""
  if (mempalaceContext && mempalaceContext.trim().length > 0) {
    mempalaceSection = `
=== RELATED CONTEXT FROM MEMORY ===
${mempalaceContext.trim()}

`
  }

  // Role and process doc are injected by the instruction system (instruction.ts ADDITIVE_FILES).
  // Only include work item details and structured output instructions here.
  return `You are a background analysis agent. Your job is to analyze a work item and produce a recommendation. This is a background task — DO NOT ask the user any questions, DO NOT request confirmation, DO NOT offer to take actions. Just analyze and report.

=== WORK ITEM ===
Title: ${item.title}
URL: ${item.url ?? "(none)"}
Source: ${item.source_id}
${relatedSection}${mempalaceSection}Steps:
1. Fetch the full details of this work item using your tools (issue description, comments, labels, milestone, assignees).${links && links.length > 0 ? "\n   Also consider the related items listed above — fetch their details if needed for a complete picture." : ""}
2. Determine the current state of this item in the team's process (described in your system instructions).
3. Determine what action the user should take next given their role (described in your system instructions).
4. If applicable, draft what that action would look like (e.g., a comment draft, a spec outline).

CRITICAL: Do NOT ask "shall I post this?" or "would you like me to...?" — just write your analysis and stop. The user will review your analysis later and decide what to do.

End your response with exactly these three lines:
STATE: <one sentence describing the current state of this item>
ACTION: <one sentence recommending what the user should do next>
URGENCY: <number 1-10, where 10=user must act immediately, 1=no action needed>`
}

export function extractAnalysis(text: string): { summary: string; recommendedAction: string | null; urgency: number } {
  const lines = text.split("\n")

  // Look for STATE:, ACTION:, and URGENCY: lines
  const stateLine = lines.find((l) => l.trim().toUpperCase().startsWith("STATE:"))
  const actionLine = lines.find((l) => l.trim().toUpperCase().startsWith("ACTION:"))
  const urgencyLine = lines.find((l) => l.trim().toUpperCase().startsWith("URGENCY:"))

  // Parse urgency
  let urgency = 5 // default
  if (urgencyLine) {
    const urgencyText = urgencyLine.trim().replace(/^URGENCY:\s*/i, "").trim()
    const parsed = parseInt(urgencyText, 10)
    if (!isNaN(parsed)) {
      urgency = Math.max(1, Math.min(10, parsed)) // clamp to 1-10
    }
  }

  if (stateLine || actionLine) {
    const summary = stateLine ? stateLine.trim().replace(/^STATE:\s*/i, "").trim() : ""
    const action = actionLine ? actionLine.trim().replace(/^ACTION:\s*/i, "").trim() : null
    return { summary: summary || action || text.slice(0, 200), recommendedAction: action, urgency }
  }

  // Fallback: look for SUMMARY: (old format)
  const summaryLine = lines.find((l) => l.trim().toUpperCase().startsWith("SUMMARY:"))
  if (summaryLine) {
    const summary = summaryLine.trim().replace(/^SUMMARY:\s*/i, "").trim()
    return { summary, recommendedAction: null, urgency }
  }

  // Last resort: use the last non-empty line
  const nonEmpty = lines.filter((l) => l.trim().length > 0)
  if (nonEmpty.length > 0) {
    return { summary: nonEmpty[nonEmpty.length - 1].replace(/^\*\*|\*\*$/g, "").trim().slice(0, 200), recommendedAction: null, urgency }
  }

  return { summary: text.slice(0, 200), recommendedAction: null, urgency }
}

function persistResult(result: AgentResult): void {
  try {
    Database.use((db) => {
      db.insert(AgentResultTable)
        .values({
          source_id: result.sourceId,
          session_id: result.sessionId,
          summary: result.summary,
          recommended_action: result.recommendedAction,
          urgency: result.urgency,
          status: result.status,
          analyzed_event_ts: result.analyzedEventTs,
          analyzed_at: result.analyzedAt,
        })
        .onConflictDoUpdate({
          target: AgentResultTable.source_id,
          set: {
            session_id: result.sessionId,
            summary: result.summary,
            recommended_action: result.recommendedAction,
            urgency: result.urgency,
            status: result.status,
            analyzed_event_ts: result.analyzedEventTs,
            analyzed_at: result.analyzedAt,
          },
        })
        .run()
    })
  } catch (err) {
    log.error("failed to persist agent result", { sourceId: result.sourceId, error: err })
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function launchSession(item: ActivityItem): Promise<void> {
  if (!api) return

  // Reserve the slot immediately to prevent tick overlap from over-launching
  const now = Date.now()
  running.set(item.source_id, { sessionId: "", item, startedAt: now, userInitiated: false })

  const title = `Analysis: ${item.title.slice(0, 60)}`

  // Enrich with mempalace context before building the prompt
  let mempalaceContext = ""
  try {
    mempalaceContext = await searchRelated(item.title, extractProject(item.source_id))
  } catch {
    // mempalace not available or search failed — continue without context
  }

  try {
    const createRes = await api.client.session.create({ title })
    const sessionId = createRes.data?.id
    if (!sessionId) {
      log.error("session.create returned no id", { sourceId: item.source_id })
      running.delete(item.source_id)
      markError(item, null)
      return
    }

    log.info("session created for analysis", { sourceId: item.source_id, sessionId })

    running.set(item.source_id, { sessionId, item, startedAt: now, userInitiated: false })

    const result: AgentResult = {
      sourceId: item.source_id,
      sessionId,
      summary: "Analyzing...",
      recommendedAction: null,
      urgency: 5,
      status: "running",
      analyzedEventTs: item.last_event_ts,
      analyzedAt: now,
    }
    results.set(item.source_id, result)
    persistResult(result)

    // Fire the prompt async — returns immediately, LLM processes in background
    try {
      await api.client.session.promptAsync({
        sessionID: sessionId,
        parts: [{ type: "text" as const, text: buildPrompt(item, mempalaceContext) }],
      })
      log.info("prompt fired async", { sourceId: item.source_id, sessionId })
    } catch (err) {
      log.error("promptAsync failed", { sourceId: item.source_id, sessionId, error: err })
      markError(item, sessionId)
      running.delete(item.source_id)
    }
  } catch (err) {
    log.error("failed to create analysis session", { sourceId: item.source_id, error: err })
    markError(item, null)
  }
}

function markError(item: ActivityItem, sessionId: string | null): void {
  const now = Date.now()
  const result: AgentResult = {
    sourceId: item.source_id,
    sessionId,
    summary: "Analysis failed",
    recommendedAction: null,
    urgency: 5,
    status: "error",
    analyzedEventTs: item.last_event_ts,
    analyzedAt: now,
  }
  results.set(item.source_id, result)
  persistResult(result)
}

async function checkRunning(): Promise<void> {
  if (!api || running.size === 0) return

  // Batch-check statuses for all running sessions
  let statuses: Record<string, any> = {}
  try {
    const res = await api.client.session.status()
    statuses = (res.data ?? {}) as Record<string, any>
    log.info("session.status()", { keys: Object.keys(statuses).length, running: running.size })
  } catch (err) {
    log.info("session.status() failed", { error: err })
    return
  }

  for (const [sourceId, info] of running) {
    const st = statuses[info.sessionId]
    if (!st) {
      // Session not in status response = it went idle (status endpoint only returns busy sessions)
      log.info("session completed (not in busy list)", { sourceId, sessionId: info.sessionId })
    } else {
      const statusType = st?.type ?? st?.status ?? (typeof st === "string" ? st : null)
      if (statusType === "busy") continue
      log.info("session completed", { sourceId, sessionId: info.sessionId, statusType })
    }

    // User-initiated sessions: just remove from running when idle
    if (info.userInitiated) {
      running.delete(sourceId)
      const existing = results.get(sourceId)
      if (existing) {
        existing.sessionId = info.sessionId
      } else {
        results.set(sourceId, {
          sourceId,
          sessionId: info.sessionId,
          summary: "Session available — press Enter to resume",
          recommendedAction: null,
          urgency: 5,
          status: "done",
          analyzedEventTs: info.item.last_event_ts,
          analyzedAt: Date.now(),
        })
      }
      log.info("user session went idle", { sourceId, sessionId: info.sessionId })
      continue
    }

    // Background analysis session idle — read messages and extract result.
    try {
      const msgRes = await api.client.session.messages({
        sessionID: info.sessionId,
        limit: 50,
      })
      const messages = msgRes.data
      if (!messages) {
        markError(info.item, info.sessionId)
        running.delete(sourceId)
        continue
      }

      let allText = ""
      let lastText = ""
      for (const msg of messages) {
        if (msg.info.role === "assistant") {
          let msgText = ""
          for (const part of msg.parts) {
            if (part.type === "text" && (part as any).text) {
              msgText += (part as any).text
            }
          }
          if (msgText) {
            allText += msgText + "\n"
            lastText = msgText
          }
        }
      }

      let responseText = ""
      if (allText.toUpperCase().includes("SUMMARY:")) {
        responseText = allText
      } else if (lastText) {
        responseText = lastText
      } else {
        responseText = allText || "Analysis complete — review session for details"
      }

      log.info("raw response text", { sourceId, length: responseText.length, first200: responseText.slice(0, 200), last200: responseText.slice(-200) })
      const { summary, recommendedAction, urgency } = extractAnalysis(responseText)
      const now = Date.now()
      const result: AgentResult = {
        sourceId,
        sessionId: info.sessionId,
        summary,
        recommendedAction,
        urgency,
        status: "done",
        analyzedEventTs: info.item.last_event_ts,
        analyzedAt: now,
      }
      results.set(sourceId, result)
      persistResult(result)
      running.delete(sourceId)

      log.info("analysis completed", { sourceId, sessionId: info.sessionId, summary: summary.slice(0, 80) })

      // Write analysis to mempalace for future context enrichment
      void writeAnalysis(sourceId, info.item.title, summary, recommendedAction, urgency, resolveWing(extractProject(sourceId)))
    } catch (err) {
      log.error("failed to read analysis response", { sourceId, sessionId: info.sessionId, error: err })
      markError(info.item, info.sessionId)
      running.delete(sourceId)
    }
  }
}

async function evictOldest(): Promise<void> {
  if (!api) return
  // Find the oldest completed result that still has a session_id
  let oldest: AgentResult | undefined
  for (const r of results.values()) {
    if (r.status !== "done" || !r.sessionId) continue
    if (running.has(r.sourceId)) continue
    if (!oldest || r.analyzedAt < oldest.analyzedAt) {
      oldest = r
    }
  }
  if (!oldest || !oldest.sessionId) return

  try {
    await api.client.session.delete({ sessionID: oldest.sessionId })
    log.info("evicted old analysis session", { sourceId: oldest.sourceId, sessionId: oldest.sessionId })
  } catch {
    // session may already be gone — that's fine
  }

  // Clear session_id but keep the result
  oldest.sessionId = null
  results.set(oldest.sourceId, oldest)
  persistResult(oldest)
}

// ---------------------------------------------------------------------------
// Processing loop
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  try {
    // 1. Check running sessions for completion
    if (running.size > 0) {
      log.info("tick: checking running sessions", { running: running.size, queued: queue.length })
    }
    await checkRunning()

    // 2. Launch new sessions from queue
    const slotsAvailable = maxConcurrent - running.size
    const toLaunch = Math.min(slotsAvailable, queue.length)

    for (let i = 0; i < toLaunch; i++) {
      const item = queue.shift()
      if (!item) break
      queued.delete(item.source_id)

      // If pool is full, evict oldest completed session
      if (running.size >= maxConcurrent) {
        await evictOldest()
      }

      await launchSession(item)
    }
  } catch (err) {
    log.error("agent-pool tick error", { error: err })
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function init(pluginApi: TuiPluginApi): void {
  api = pluginApi

  // Load existing results from DB into memory
  loadResultsFromDb()

  // Start the processing loop
  timer = setInterval(() => {
    void tick()
  }, POLL_INTERVAL_MS)

  log.info("agent pool initialized", { pollInterval: POLL_INTERVAL_MS, maxConcurrent: maxConcurrent })
}

export function queueAnalysis(item: ActivityItem): void {
  // Already queued or running?
  if (queued.has(item.source_id) || running.has(item.source_id)) return

  // Skip items that are linked as secondary to a primary item.
  // They'll be analyzed as context when the primary item is processed.
  if (linkedSecondaryIds.has(item.source_id)) {
    log.info("skipped queueing linked secondary item", { sourceId: item.source_id })
    return
  }

  // Check if we already have a recent-enough result
  const existing = results.get(item.source_id)
  if (existing && existing.analyzedEventTs >= item.last_event_ts && existing.status !== "error") {
    return // already analyzed and no new events
  }

  queue.push(item)
  queued.add(item.source_id)
  log.info("queued analysis", { sourceId: item.source_id, title: item.title.slice(0, 60) })
}

export function registerSession(item: ActivityItem, sessionId: string): void {
  if (running.has(item.source_id)) return
  running.set(item.source_id, { sessionId, item, startedAt: Date.now(), userInitiated: true })
  log.info("registered user session", { sourceId: item.source_id, sessionId })
}

export function forceRequeue(item: ActivityItem): void {
  if (running.has(item.source_id)) return
  results.delete(item.source_id)
  queued.delete(item.source_id)
  const idx = queue.findIndex((i) => i.source_id === item.source_id)
  if (idx >= 0) queue.splice(idx, 1)
  queue.push(item)
  queued.add(item.source_id)
  log.info("force re-queued analysis", { sourceId: item.source_id })
}

export function getResult(sourceId: string): AgentResult | null {
  return results.get(sourceId) ?? null
}

export function getAllResults(): Map<string, AgentResult> {
  return new Map(results)
}

export function getRunningCount(): number {
  return running.size
}

export function getQueueCount(): number {
  return queue.length
}

export function getAnalyzedCount(): number {
  let count = 0
  for (const r of results.values()) {
    if (r.status === "done") count++
  }
  return count
}

export function isRunning(sourceId: string): boolean {
  return running.has(sourceId)
}

export function isQueued(sourceId: string): boolean {
  return queued.has(sourceId)
}

export function getElapsedMs(sourceId: string): number | null {
  const info = running.get(sourceId)
  if (!info) return null
  return Date.now() - info.startedAt
}

export function getMaxConcurrent(): number {
  return maxConcurrent
}

export function setMaxConcurrent(n: number): number {
  maxConcurrent = Math.max(MIN_CONCURRENT, Math.min(MAX_CONCURRENT_CEILING, n))
  log.info("max concurrent updated", { maxConcurrent, running: running.size })
  return maxConcurrent
}

/**
 * Update the cross-reference map with linked items from the link resolver.
 * Called by the Needs Me refresh cycle after link resolution completes.
 *
 * @param links - Map from primary source_id to its linked ActivityItems.
 *   For example, a Jira issue source_id maps to its associated PRs.
 */
export function setLinkedItems(links: Map<string, ActivityItem[]>): void {
  linkedItems.clear()
  linkedSecondaryIds.clear()

  for (const [primaryId, items] of links) {
    linkedItems.set(primaryId, items)
    for (const item of items) {
      linkedSecondaryIds.add(item.source_id)
    }
  }

  log.info("linked items updated", {
    primaryCount: linkedItems.size,
    secondaryCount: linkedSecondaryIds.size,
  })
}

export function stop(): void {
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
  api = undefined
  log.info("agent pool stopped")
}

export * as AgentPool from "./pool"
