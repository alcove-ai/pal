import type { ActivityEvent } from "@/activity-feed/types"

export type HealthLevel = "green" | "yellow" | "red"

export interface HealthSignals {
  /** Ratio of inflow to outflow (created vs resolved). >2 = red, >1.5 = yellow */
  flowRatio: { value: number; level: HealthLevel }
  /** Days since last activity event. >7 = red, >3 = yellow */
  staleness: { value: number; level: HealthLevel }
  /** Number of currently blocked issues */
  blockageCount: { value: number; level: HealthLevel }
  /** Trend of activity over recent windows. negative = declining */
  activityTrend: { value: number; level: HealthLevel }
  /** Worst-signal-wins overall health */
  overall: HealthLevel
}

const STALENESS_RED_DAYS = 7
const STALENESS_YELLOW_DAYS = 3
const FLOW_RATIO_RED = 2.0
const FLOW_RATIO_YELLOW = 1.5
const BLOCKAGE_RED = 3
const BLOCKAGE_YELLOW = 1
const MIN_EVENTS_FOR_TREND = 5
const TREND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Compute the 4 health signals for a domain's set of events.
 */
export function computeHealth(events: ActivityEvent[]): HealthSignals {
  const now = Date.now()

  const flowRatio = computeFlowRatio(events)
  const staleness = computeStaleness(events, now)
  const blockageCount = computeBlockageCount(events)
  const activityTrend = computeActivityTrend(events, now)

  const overall = worstLevel([flowRatio.level, staleness.level, blockageCount.level, activityTrend.level])

  return { flowRatio, staleness, blockageCount, activityTrend, overall }
}

function computeFlowRatio(events: ActivityEvent[]): { value: number; level: HealthLevel } {
  let inflow = 0
  let outflow = 0

  for (const e of events) {
    if (e.event_type === "issue_created") {
      inflow++
    }
    if (e.event_type === "status_changed") {
      const meta = e.metadata as Record<string, unknown> | null
      const changeTo = (meta?.change_to as string)?.toLowerCase() ?? ""
      if (changeTo === "closed" || changeTo === "done" || changeTo === "resolved") {
        outflow++
      }
    }
  }

  // Avoid division by zero: if no outflow, ratio is inflow (or 0 if no inflow)
  const value = outflow === 0 ? (inflow > 0 ? inflow : 0) : inflow / outflow
  const roundedValue = Math.round(value * 100) / 100

  let level: HealthLevel = "green"
  if (value >= FLOW_RATIO_RED) level = "red"
  else if (value >= FLOW_RATIO_YELLOW) level = "yellow"

  return { value: roundedValue, level }
}

function computeStaleness(events: ActivityEvent[], now: number): { value: number; level: HealthLevel } {
  if (events.length === 0) {
    return { value: 0, level: "green" }
  }

  let latestTs = 0
  for (const e of events) {
    if (e.timestamp > latestTs) latestTs = e.timestamp
  }

  const daysSince = (now - latestTs) / (24 * 60 * 60 * 1000)
  const roundedDays = Math.round(daysSince * 10) / 10

  let level: HealthLevel = "green"
  if (daysSince >= STALENESS_RED_DAYS) level = "red"
  else if (daysSince >= STALENESS_YELLOW_DAYS) level = "yellow"

  return { value: roundedDays, level }
}

function computeBlockageCount(events: ActivityEvent[]): { value: number; level: HealthLevel } {
  // Track which issues are currently blocked
  // An issue is blocked if the most recent "blocked" event for it is more recent
  // than any "status_changed" event that would unblock it
  const issueBlocked = new Map<string, boolean>()

  // Sort by timestamp ascending to replay in order
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)

  for (const e of sorted) {
    if (e.event_type === "blocked") {
      issueBlocked.set(e.source_id, true)
    } else if (e.event_type === "status_changed") {
      const meta = e.metadata as Record<string, unknown> | null
      const changeTo = (meta?.change_to as string)?.toLowerCase() ?? ""
      // Status changes away from blocked states unblock
      if (changeTo === "in progress" || changeTo === "closed" || changeTo === "done" || changeTo === "resolved") {
        issueBlocked.set(e.source_id, false)
      }
    }
  }

  let count = 0
  for (const blocked of issueBlocked.values()) {
    if (blocked) count++
  }

  let level: HealthLevel = "green"
  if (count >= BLOCKAGE_RED) level = "red"
  else if (count >= BLOCKAGE_YELLOW) level = "yellow"

  return { value: count, level }
}

function computeActivityTrend(events: ActivityEvent[], now: number): { value: number; level: HealthLevel } {
  if (events.length < MIN_EVENTS_FOR_TREND) {
    // Not enough data to compute trend -- neutral
    return { value: 0, level: "green" }
  }

  // Compare activity in the recent window vs the prior window
  const recentStart = now - TREND_WINDOW_MS
  const priorStart = recentStart - TREND_WINDOW_MS

  let recentCount = 0
  let priorCount = 0

  for (const e of events) {
    if (e.timestamp >= recentStart) {
      recentCount++
    } else if (e.timestamp >= priorStart) {
      priorCount++
    }
  }

  // Trend: positive = increasing activity, negative = declining
  // Normalized as percentage change from prior
  let value: number
  if (priorCount === 0 && recentCount === 0) {
    value = 0
  } else if (priorCount === 0) {
    value = 100 // New activity from nothing
  } else {
    value = Math.round(((recentCount - priorCount) / priorCount) * 100)
  }

  let level: HealthLevel = "green"
  // Declining activity is a concern
  if (value <= -50) level = "red"
  else if (value <= -25) level = "yellow"

  return { value, level }
}

function worstLevel(levels: HealthLevel[]): HealthLevel {
  if (levels.includes("red")) return "red"
  if (levels.includes("yellow")) return "yellow"
  return "green"
}

export * as Health from "./health"
