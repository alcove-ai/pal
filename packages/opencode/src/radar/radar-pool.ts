import * as Log from "@opencode-ai/core/util/log"
import { get as getRole } from "@/config/role"
import {
  queueAnalysis,
  getResult as getPoolResult,
  isRunning as isPoolRunning,
  isQueued as isPoolQueued,
} from "@/agent-pool/pool"
import type { ActivityItem } from "@/needs-me/needs-me-logic"
import {
  loadRadarItems,
  getResult as getRadarResult,
  persistResult,
} from "@/radar/radar-store"
import type { RadarItem, RadarResult } from "@/radar/radar-store"

const log = Log.create({ service: "radar-pool" })

/** Items are only re-queued if their last analysis is older than this. */
const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1_000 // 4 hours

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

export function buildRadarPrompt(
  item: RadarItem,
  previousResult: RadarResult | null,
): string {
  const role = getRole() ?? "(no role configured)"
  const lastScanned = previousResult?.analyzedAt
    ? new Date(previousResult.analyzedAt).toISOString()
    : "never"
  const previousSummary = previousResult?.summary ?? "(first scan)"

  return `You are a background monitoring agent. Your job is to analyze an external item the user is watching and assess how it affects their work. This is a background task — DO NOT ask questions or offer to take actions.

=== USER'S ROLE ===
${role}

=== WATCHED ITEM ===
URL: ${item.url}
Label: ${item.label ?? "(none)"}
Last scanned: ${lastScanned}

=== PREVIOUS ANALYSIS ===
${previousSummary}

Steps:
1. Fetch the full details of this item using your tools.
2. Determine the current state.
3. Assess how this item affects the user's work given their role.
4. If previously scanned, identify what changed.

STATE: <current state>
IMPACT: <how this affects the user's work, or "None">
CHANGE: <what changed since last scan, or "Initial scan">
URGENCY: <1-10>`
}

// ---------------------------------------------------------------------------
// Analysis extraction
// ---------------------------------------------------------------------------

export function extractRadarAnalysis(text: string): {
  summary: string
  impact: string | null
  changeDescription: string | null
  urgency: number
} {
  const lines = text.split("\n")

  const stateLine = lines.find((l) => l.trim().toUpperCase().startsWith("STATE:"))
  const impactLine = lines.find((l) => l.trim().toUpperCase().startsWith("IMPACT:"))
  const changeLine = lines.find((l) => l.trim().toUpperCase().startsWith("CHANGE:"))
  const urgencyLine = lines.find((l) => l.trim().toUpperCase().startsWith("URGENCY:"))

  // Parse urgency
  let urgency = 5
  if (urgencyLine) {
    const urgencyText = urgencyLine.trim().replace(/^URGENCY:\s*/i, "").trim()
    const parsed = parseInt(urgencyText, 10)
    if (!isNaN(parsed)) {
      urgency = Math.max(1, Math.min(10, parsed))
    }
  }

  const summary = stateLine ? stateLine.trim().replace(/^STATE:\s*/i, "").trim() : ""
  const impact = impactLine ? impactLine.trim().replace(/^IMPACT:\s*/i, "").trim() : null
  const changeDescription = changeLine ? changeLine.trim().replace(/^CHANGE:\s*/i, "").trim() : null

  if (summary) {
    return { summary, impact, changeDescription, urgency }
  }

  // Fallback: use the last non-empty line as summary
  const nonEmpty = lines.filter((l) => l.trim().length > 0)
  if (nonEmpty.length > 0) {
    return {
      summary: nonEmpty[nonEmpty.length - 1].replace(/^\*\*|\*\*$/g, "").trim().slice(0, 200),
      impact,
      changeDescription,
      urgency,
    }
  }

  return { summary: text.slice(0, 200), impact, changeDescription, urgency }
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

/** Converts a RadarItem to an ActivityItem-compatible shape and queues it via the shared pool. */
export function queueRadarAnalysis(
  item: RadarItem,
  previousResult: RadarResult | null,
): void {
  const sourceId = `radar:${item.url}`

  // Skip if already running or queued in the pool
  if (isPoolRunning(sourceId) || isPoolQueued(sourceId)) return

  // Check scan cadence: only re-queue if stale or no result exists
  if (previousResult && previousResult.status !== "error") {
    const age = Date.now() - previousResult.analyzedAt
    if (age < STALE_THRESHOLD_MS) return
  }

  // Build a minimal ActivityItem for the shared pool
  const activityItem: ActivityItem = {
    source_id: sourceId,
    source: "radar",
    title: item.label ?? item.url,
    url: item.url,
    actor: null,
    last_event_ts: Date.now(),
    event_type: "radar_scan",
    summary: previousResult?.summary ?? null,
    parent_key: null,
    issue_type: null,
    milestone: null,
    milestone_url: null,
  }

  queueAnalysis(activityItem)
  log.info("queued radar analysis", { url: item.url, label: item.label })
}

// ---------------------------------------------------------------------------
// Result checking
// ---------------------------------------------------------------------------

/**
 * Check the agent pool for completed radar analyses and persist them
 * to the radar-specific store. Call this periodically (e.g. from a tick loop).
 */
export function checkRadarResults(): void {
  const items = loadRadarItems()

  for (const item of items) {
    const sourceId = `radar:${item.url}`
    const poolResult = getPoolResult(sourceId)
    if (!poolResult) continue
    if (poolResult.status !== "done") continue

    // Check if we already persisted this exact result
    const existing = getRadarResult(item.url)
    if (existing && existing.analyzedAt >= poolResult.analyzedAt) continue

    // Extract radar-specific fields from the pool result's summary text.
    // The pool stores what it extracts via its own extractAnalysis(); we
    // re-parse the same summary for IMPACT/CHANGE fields that the pool
    // does not track.
    const { summary, impact, changeDescription, urgency } = extractRadarAnalysis(poolResult.summary)

    const radarResult: RadarResult = {
      url: item.url,
      sessionId: poolResult.sessionId,
      summary,
      impact,
      changeDescription,
      urgency,
      status: "done",
      analyzedAt: poolResult.analyzedAt,
    }

    persistResult(radarResult)
    log.info("persisted radar result", { url: item.url, summary: summary.slice(0, 80) })
  }
}

// ---------------------------------------------------------------------------
// Convenience: queue all stale radar items
// ---------------------------------------------------------------------------

/**
 * Scan all configured radar items and queue any that need (re-)analysis.
 * Call this periodically from the radar tab's refresh cycle.
 */
export function queueStaleRadarItems(): void {
  const items = loadRadarItems()
  for (const item of items) {
    const existing = getRadarResult(item.url)
    queueRadarAnalysis(item, existing)
  }
}

export * as RadarPool from "./radar-pool"
