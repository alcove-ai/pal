import { eq } from "drizzle-orm"
import * as Log from "@opencode-ai/core/util/log"
import { Database } from "@/storage/db"
import { AgentResultTable } from "./pool.sql"
import { get as getRole } from "@/config/role"
import { load as loadProcessDoc } from "@/process/process-doc"
import type { ActivityItem } from "@/needs-me/needs-me-logic"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

const log = Log.create({ service: "agent-pool" })

const MAX_CONCURRENT = 10
const POLL_INTERVAL_MS = 2_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentResult {
  sourceId: string
  sessionId: string | null
  summary: string
  recommendedAction: string | null
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

/** source_id -> in-flight tracking for sessions we launched. */
const running = new Map<
  string,
  {
    sessionId: string
    item: ActivityItem
    startedAt: number
  }
>()

/** source_id -> result for already-completed analyses (in-memory cache). */
const results = new Map<string, AgentResult>()

/** Set of source_ids currently queued, to avoid duplicates. */
const queued = new Set<string>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToResult(row: typeof AgentResultTable.$inferSelect): AgentResult {
  return {
    sourceId: row.source_id,
    sessionId: row.session_id ?? null,
    summary: row.summary,
    recommendedAction: row.recommended_action ?? null,
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

function buildPrompt(item: ActivityItem): string {
  const processDoc = loadProcessDoc() ?? "(no process document found)"
  const role = getRole() ?? "(no role configured)"
  const ts = new Date(item.last_event_ts).toISOString()

  return `You are a process facilitator for the user's team. Analyze this work item.

=== TEAM PROCESS ===
${processDoc}

=== USER'S ROLE ===
${role}

=== WORK ITEM ===
Title: ${item.title}
URL: ${item.url ?? "(none)"}
Source: ${item.source_id}
Latest activity: ${ts}
Event: ${item.event_type}: ${item.summary ?? ""}

Based on the team's process and the user's role:
1. What is the current state of this item?
2. What specific action should the user take next?
3. Prepare a draft of that action if possible (e.g., a comment, a spec outline).

Be concise. Start your response with a one-line summary prefixed with "SUMMARY:" that will be shown inline in the dashboard.`
}

function extractSummary(text: string): { summary: string; recommendedAction: string | null } {
  const lines = text.split("\n")
  const summaryLine = lines.find((l) => l.trim().startsWith("SUMMARY:"))
  const summary = summaryLine ? summaryLine.replace(/^SUMMARY:\s*/i, "").trim() : text.slice(0, 200)
  // Everything after the summary line is the recommended action
  if (summaryLine) {
    const idx = lines.indexOf(summaryLine)
    const rest = lines
      .slice(idx + 1)
      .join("\n")
      .trim()
    return { summary, recommendedAction: rest || null }
  }
  return { summary, recommendedAction: null }
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
  const title = `Analysis: ${item.title.slice(0, 60)}`

  try {
    const createRes = await api.client.session.create({ title })
    const sessionId = createRes.data?.id
    if (!sessionId) {
      log.error("session.create returned no id", { sourceId: item.source_id })
      markError(item, null)
      return
    }

    log.info("session created for analysis", { sourceId: item.source_id, sessionId })

    const now = Date.now()
    running.set(item.source_id, { sessionId, item, startedAt: now })

    const result: AgentResult = {
      sourceId: item.source_id,
      sessionId,
      summary: "Analyzing...",
      recommendedAction: null,
      status: "running",
      analyzedEventTs: item.last_event_ts,
      analyzedAt: now,
    }
    results.set(item.source_id, result)
    persistResult(result)

    // Fire the prompt — don't await. The processing loop will poll for completion.
    void api.client.session
      .prompt({
        sessionID: sessionId,
        parts: [{ type: "text", text: buildPrompt(item) }],
      })
      .catch((err) => {
        log.error("prompt failed", { sourceId: item.source_id, sessionId, error: err })
        markError(item, sessionId)
        running.delete(item.source_id)
      })
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
  let statuses: Record<string, { type: string }> | undefined
  try {
    const res = await api.client.session.status()
    statuses = res.data as Record<string, { type: string }> | undefined
  } catch {
    return // will retry next tick
  }
  if (!statuses) return

  for (const [sourceId, info] of running) {
    const st = statuses[info.sessionId]
    if (!st || st.type !== "idle") continue

    // Session is idle — the prompt finished. Read messages.
    try {
      const msgRes = await api.client.session.messages({
        sessionID: info.sessionId,
        limit: 5,
      })
      const messages = msgRes.data
      if (!messages) {
        markError(info.item, info.sessionId)
        running.delete(sourceId)
        continue
      }

      // Find the first assistant message's text parts
      let responseText = ""
      for (const msg of messages) {
        if (msg.info.role === "assistant") {
          for (const part of msg.parts) {
            if (part.type === "text") {
              responseText += part.text
            }
          }
          if (responseText) break
        }
      }

      if (!responseText) {
        responseText = "No response from analysis"
      }

      const { summary, recommendedAction } = extractSummary(responseText)
      const now = Date.now()
      const result: AgentResult = {
        sourceId,
        sessionId: info.sessionId,
        summary,
        recommendedAction,
        status: "done",
        analyzedEventTs: info.item.last_event_ts,
        analyzedAt: now,
      }
      results.set(sourceId, result)
      persistResult(result)
      running.delete(sourceId)

      log.info("analysis completed", { sourceId, sessionId: info.sessionId, summary: summary.slice(0, 80) })
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
    await checkRunning()

    // 2. Launch new sessions from queue
    const slotsAvailable = MAX_CONCURRENT - running.size
    const toLaunch = Math.min(slotsAvailable, queue.length)

    for (let i = 0; i < toLaunch; i++) {
      const item = queue.shift()
      if (!item) break
      queued.delete(item.source_id)

      // If pool is full, evict oldest completed session
      if (running.size >= MAX_CONCURRENT) {
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

  log.info("agent pool initialized", { pollInterval: POLL_INTERVAL_MS, maxConcurrent: MAX_CONCURRENT })
}

export function queueAnalysis(item: ActivityItem): void {
  // Already queued or running?
  if (queued.has(item.source_id) || running.has(item.source_id)) return

  // Check if we already have a recent-enough result
  const existing = results.get(item.source_id)
  if (existing && existing.analyzedEventTs >= item.last_event_ts && existing.status !== "error") {
    return // already analyzed and no new events
  }

  queue.push(item)
  queued.add(item.source_id)
  log.info("queued analysis", { sourceId: item.source_id, title: item.title.slice(0, 60) })
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
  return MAX_CONCURRENT
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
