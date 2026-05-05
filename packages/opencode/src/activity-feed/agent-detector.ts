import type { ActorType } from "./types"

// --- Default known service/bot accounts ---

const DEFAULT_SERVICE_ACCOUNTS: string[] = [
  "dependabot[bot]",
  "renovate[bot]",
  "github-actions[bot]",
  "codecov[bot]",
  "snyk-bot",
  "mergify[bot]",
  "greenkeeper[bot]",
  "allcontributors[bot]",
]

// --- Content markers that indicate agent-generated events ---

const AGENT_CONTENT_MARKERS = [
  "Co-Authored-By: Claude",
  "Generated-by:",
  "Assisted-by:",
  "Signed-off-by: dependabot",
  "Co-authored-by: renovate",
]

// --- Configuration ---

export interface AgentDetectorConfig {
  /** Additional service account usernames to treat as agent actors */
  customAgentAccounts?: string[]
}

// --- Burst tracking (in-memory, per-process) ---

interface BurstEntry {
  timestamps: number[]
}

const BURST_WINDOW_MS = 10 * 60 * 1000 // 10 minutes
const BURST_THRESHOLD = 5

/** In-memory burst tracker keyed by "actor:event_type" */
const burstTracker = new Map<string, BurstEntry>()

/**
 * Record an event for burst detection and return whether this actor+event_type
 * combination has hit the burst threshold (>=5 events of the same type from the
 * same actor within 10 minutes).
 *
 * This is advisory only -- callers surface for user confirmation rather than
 * auto-classifying.
 */
export function recordBurst(actor: string, eventType: string, timestamp: number): boolean {
  const key = `${actor}:${eventType}`
  let entry = burstTracker.get(key)
  if (!entry) {
    entry = { timestamps: [] }
    burstTracker.set(key, entry)
  }

  // Add the new timestamp
  entry.timestamps.push(timestamp)

  // Prune timestamps outside the window
  const cutoff = timestamp - BURST_WINDOW_MS
  entry.timestamps = entry.timestamps.filter((t) => t >= cutoff)

  return entry.timestamps.length >= BURST_THRESHOLD
}

/**
 * Detect the actor type for a given event.
 *
 * Detection order:
 * 1. Service account list match (known bots) -> "agent"
 * 2. Content markers in metadata -> "agent"
 * 3. Otherwise -> "human"
 *
 * The burst heuristic is checked separately via `recordBurst` and surfaces
 * potential agent activity for confirmation without auto-classifying.
 */
export function detectActorType(
  actor: string | null,
  metadata: Record<string, unknown> | null,
  config?: AgentDetectorConfig,
): ActorType {
  // 1. Check service account list
  if (actor) {
    const allServiceAccounts = [
      ...DEFAULT_SERVICE_ACCOUNTS,
      ...(config?.customAgentAccounts ?? []),
    ]
    const lowerActor = actor.toLowerCase()
    for (const sa of allServiceAccounts) {
      if (lowerActor === sa.toLowerCase()) {
        return "agent"
      }
    }
    // Common bot suffixes
    if (lowerActor.endsWith("[bot]") || lowerActor.endsWith("-bot")) {
      return "agent"
    }
  }

  // 2. Check content markers in metadata
  if (metadata) {
    // Scan specific metadata fields for agent markers.
    // IMPORTANT: Only scan metadata fields that contain machine-generated content
    // (stderr, commit trailers, pipeline output). NEVER scan issue titles,
    // commit messages, or human-authored text.
    const fieldsToScan: string[] = []

    // Collect string values from safe metadata fields
    for (const [key, value] of Object.entries(metadata)) {
      // Only scan fields likely to contain agent markers
      if (
        key === "commit_message_trailers" ||
        key === "stderr" ||
        key === "pipeline_output" ||
        key === "description_trailers"
      ) {
        if (typeof value === "string") {
          fieldsToScan.push(value)
        }
      }
    }

    // Also check the top-level metadata for explicit agent marker flags
    if (metadata.generated_by || metadata.assisted_by || metadata.co_authored_by_agent) {
      return "agent"
    }

    for (const text of fieldsToScan) {
      for (const marker of AGENT_CONTENT_MARKERS) {
        if (text.includes(marker)) {
          return "agent"
        }
      }
    }
  }

  return "human"
}
