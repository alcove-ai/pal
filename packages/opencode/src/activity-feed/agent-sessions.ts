import type { ActivityEvent } from "./types"

// --- Constants ---

/** Inactivity gap that bounds a session (30 minutes) */
const SESSION_GAP_MS = 30 * 60 * 1000

/** Keywords that indicate failures in machine-generated metadata.
 * IMPORTANT: These are ONLY scanned against metadata fields (stderr, exit codes,
 * pipeline status). NEVER scan issue titles, commit messages, or human-authored text.
 */
const FAILURE_KEYWORDS = [
  "error",
  "failed",
  "failure",
  "exception",
  "traceback",
  "fatal",
  "panic",
  "segfault",
  "exit code 1",
  "exit code 2",
  "exit_code: 1",
  "exit_code: 2",
  "non-zero exit",
  "timed out",
  "timeout",
]

// --- Types ---

/** A work-item sub-group within a session */
export interface AgentWorkItem {
  /** The work-item key (Jira key or PR/MR URL) */
  key: string
  /** Events belonging to this work item */
  events: ActivityEvent[]
}

/** A single agent session bounded by inactivity gaps */
export interface AgentSession {
  /** Unique session ID derived from first event */
  id: string
  /** The agent actor (username) */
  actor: string
  /** Session start (earliest event timestamp) */
  startTs: number
  /** Session end (latest event timestamp) */
  endTs: number
  /** All events in this session */
  events: ActivityEvent[]
  /** Events sub-grouped by work item */
  workItems: AgentWorkItem[]
  /** Whether any event metadata indicates a failure */
  has_failures: boolean
}

// --- Helpers ---

/** Extract a work-item key from an event, preferring Jira keys and PR URLs */
function extractWorkItemKey(event: ActivityEvent): string {
  const meta = event.metadata as Record<string, unknown> | null
  if (!meta) return event.source_id

  // Jira key
  if (meta.jira_key && typeof meta.jira_key === "string") return meta.jira_key
  if (Array.isArray(meta.jira_keys) && meta.jira_keys.length > 0) {
    return meta.jira_keys[0] as string
  }

  // PR/MR URLs
  if (Array.isArray(meta.github_pr_urls) && meta.github_pr_urls.length > 0) {
    return meta.github_pr_urls[0] as string
  }

  // Fall back to source_id
  return event.source_id
}

/**
 * Detect failures in event metadata.
 * ONLY scans machine-generated metadata fields (stderr, exit codes, pipeline status).
 * NEVER scans issue titles, commit messages, or human-authored text.
 */
function detectFailure(event: ActivityEvent): boolean {
  const meta = event.metadata as Record<string, unknown> | null
  if (!meta) return false

  // Check explicit failure indicators
  if (meta.pipeline_status === "failed") return true

  const exitCode = meta.exit_code ?? meta.exitCode
  if (typeof exitCode === "number" && exitCode !== 0) return true
  if (typeof exitCode === "string" && exitCode !== "0" && exitCode !== "") return true

  // Check event type (ci_failed and pipeline_failed are inherently failures)
  if (event.event_type === "ci_failed" || event.event_type === "pipeline_failed") return true

  // Scan only machine-generated metadata fields for failure keywords
  const safeFields = ["stderr", "pipeline_output", "pipeline_status", "conclusion"]
  for (const field of safeFields) {
    const value = meta[field]
    if (typeof value === "string") {
      const lower = value.toLowerCase()
      for (const keyword of FAILURE_KEYWORDS) {
        if (lower.includes(keyword)) return true
      }
    }
  }

  // Check failed_checks / failed_jobs arrays
  if (Array.isArray(meta.failed_checks) && meta.failed_checks.length > 0) return true
  if (Array.isArray(meta.failed_jobs) && meta.failed_jobs.length > 0) return true

  return false
}

// --- Main grouping function ---

/**
 * Group agent events into sessions bounded by 30-minute inactivity gaps.
 * Within each session, sub-group events by work item (Jira key or PR URL).
 *
 * @param events - Activity events filtered to actor_type === "agent", sorted by timestamp ascending
 * @returns Array of AgentSession objects
 */
export function groupAgentSessions(events: ActivityEvent[]): AgentSession[] {
  if (events.length === 0) return []

  // Sort by timestamp ascending (defensive - caller should pre-sort)
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)

  // Group by actor first
  const byActor = new Map<string, ActivityEvent[]>()
  for (const event of sorted) {
    const actor = event.actor ?? "unknown-agent"
    let list = byActor.get(actor)
    if (!list) {
      list = []
      byActor.set(actor, list)
    }
    list.push(event)
  }

  const sessions: AgentSession[] = []

  for (const [actor, actorEvents] of byActor) {
    // Split into sessions by inactivity gap
    let currentSession: ActivityEvent[] = [actorEvents[0]]

    for (let i = 1; i < actorEvents.length; i++) {
      const gap = actorEvents[i].timestamp - actorEvents[i - 1].timestamp
      if (gap > SESSION_GAP_MS) {
        // Close current session and start new one
        sessions.push(buildSession(actor, currentSession))
        currentSession = [actorEvents[i]]
      } else {
        currentSession.push(actorEvents[i])
      }
    }

    // Close final session
    if (currentSession.length > 0) {
      sessions.push(buildSession(actor, currentSession))
    }
  }

  // Sort sessions by start time descending (most recent first)
  sessions.sort((a, b) => b.startTs - a.startTs)

  return sessions
}

function buildSession(actor: string, events: ActivityEvent[]): AgentSession {
  // Sub-group by work item
  const workItemMap = new Map<string, ActivityEvent[]>()
  for (const event of events) {
    const key = extractWorkItemKey(event)
    let list = workItemMap.get(key)
    if (!list) {
      list = []
      workItemMap.set(key, list)
    }
    list.push(event)
  }

  const workItems: AgentWorkItem[] = Array.from(workItemMap.entries()).map(([key, evts]) => ({
    key,
    events: evts,
  }))

  // Detect failures - ONLY in metadata, never in titles or human text
  const has_failures = events.some(detectFailure)

  return {
    id: `agent-session-${actor}-${events[0].timestamp}`,
    actor,
    startTs: events[0].timestamp,
    endTs: events[events.length - 1].timestamp,
    events,
    workItems,
    has_failures,
  }
}
