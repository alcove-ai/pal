import type { ActivityEvent, ActivityEventType } from "@/activity-feed/types"

// --- Scoring weight defaults ---

/** Default base weights per event type. Overridable via config. */
export const DEFAULT_BASE_WEIGHTS: Record<string, number> = {
  review_requested: 40,
  blocked: 35,
  ci_failed: 30,
  pipeline_failed: 30,
  agent_needs_review: 30,
  question_in_domain: 25,
  status_changed: 15,
  assigned: 15,
  mentioned: 10,
  pr_commented: 10,
  mr_commented: 10,
  issue_commented: 10,
  commented: 10,
  review_submitted: 20,
  pr_opened: 10,
  mr_opened: 10,
  pr_merged: 5,
  mr_merged: 5,
  pr_closed: 5,
  issue_created: 5,
  issue_opened: 5,
  priority_changed: 15,
  field_updated: 5,
}

/** Age penalty: points per hour, capped */
export const DEFAULT_AGE_PENALTY_PER_HOUR = 2
export const DEFAULT_AGE_PENALTY_CAP = 20

/** Blocking multiplier applied to base weight when item blocks another's in-progress work */
export const DEFAULT_BLOCKING_MULTIPLIER = 1.5

/** Maximum possible score */
export const MAX_SCORE = 100

// --- Types ---

export interface NeedsMeConfig {
  /** Override base weights per event type */
  baseWeights?: Record<string, number>
  /** Points of age penalty per hour since event */
  agePenaltyPerHour?: number
  /** Maximum age penalty */
  agePenaltyCap?: number
  /** Multiplier when item blocks another team member's in-progress work */
  blockingMultiplier?: number
  /** Per-domain bonus, e.g. { reliability: 10, CDN: 5 } */
  domainBonus?: Record<string, number>
  /** Username / display name of the current user (for needsMe detection) */
  currentUser?: string
  /** GitHub login of the current user */
  githubLogin?: string
}

/** Classification tier for an event */
export type NeedsMeTier = 1 | 2

/** A single queue entry after classification and scoring */
export interface NeedsMeItem {
  /** Unique ID for this queue item */
  id: string
  /** The work-item dedup key (Jira key, PR URL, or source_id) */
  workItemKey: string
  /** Tier 1 = synchronous / direct, Tier 2 = async / indirect */
  tier: NeedsMeTier
  /** Classifier rule that matched, e.g. "review_requested" */
  rule: string
  /** Combined rule+source key for auto-suppression, e.g. "review_requested:github" */
  ruleSource: string
  /** Computed priority score 0-100 */
  score: number
  /** Human-readable score breakdown */
  scoreBreakdown: string
  /** Title from the highest-priority source event */
  title: string
  /** URL to the work item */
  url: string | null
  /** Actor who triggered the event */
  actor: string | null
  /** Timestamp of the event (epoch ms) */
  timestamp: number
  /** Source(s) as badges for cross-source deduplication */
  sources: string[]
  /** All underlying ActivityEvent IDs collapsed into this item */
  eventIds: string[]
  /** Whether this item is blocking someone else's in-progress work */
  isBlocking: boolean
  /** Domain labels if any */
  domains: string[]
  /** Whether the item has security labels or critical priority (exempt from suppression) */
  isExemptFromSuppression: boolean
}

// --- Tier 1 rules: synchronous / direct signals ---

const TIER1_EVENT_TYPES = new Set<ActivityEventType>([
  "review_requested",
  "mentioned",
  "assigned",
])

// Tier 1 also includes events where metadata.needsMe === true (Phase 2 flag)

// --- Tier 2 rules: async / indirect signals ---

const TIER2_EVENT_TYPES = new Set<ActivityEventType>([
  "ci_failed",
  "pipeline_failed",
  "blocked",
  "status_changed",
])

// --- Classification logic ---

function isNeedsMePhase2(event: ActivityEvent): boolean {
  if (!event.metadata || typeof event.metadata !== "object") return false
  return (event.metadata as Record<string, unknown>).needsMe === true
}

function isAgentNeedsReview(event: ActivityEvent): boolean {
  // Agent sessions that create items needing review:
  // - PRs/MRs opened by agents
  // - @-mentions from agents
  // - Agent failures in owned domains
  if (event.actor_type !== "agent") return false

  if (event.event_type === "pr_opened" || event.event_type === "mr_opened") return true
  if (event.event_type === "mentioned") return true
  if (event.event_type === "ci_failed" || event.event_type === "pipeline_failed") return true

  return false
}

function isTier1(event: ActivityEvent, config: NeedsMeConfig): boolean {
  if (isNeedsMePhase2(event)) return true
  if (TIER1_EVENT_TYPES.has(event.event_type)) return true

  // Agent-created items needing review
  if (isAgentNeedsReview(event)) return true

  // review_submitted directed at user
  if (event.event_type === "review_submitted") return true

  // Assignee on status change: if the user is the assignee and status changed
  if (event.event_type === "status_changed") {
    const meta = event.metadata as Record<string, unknown> | null
    if (meta) {
      const assignee = meta.assignee as string | undefined
      if (assignee && config.currentUser && assignee.toLowerCase() === config.currentUser.toLowerCase()) {
        return true
      }
    }
  }

  return false
}

function isTier2(event: ActivityEvent, _config: NeedsMeConfig): boolean {
  if (TIER2_EVENT_TYPES.has(event.event_type)) return true

  // PR comments on user's own PRs (author notifications)
  if (event.event_type === "pr_commented" || event.event_type === "issue_commented") {
    const meta = event.metadata as Record<string, unknown> | null
    if (meta?.reason === "author") return true
  }

  return false
}

function isBlocking(event: ActivityEvent): boolean {
  const meta = event.metadata as Record<string, unknown> | null
  if (!meta) return false
  if (meta.blocked === true) return true
  if (meta.priority === "Blocker" || meta.priority === "Critical") return true
  return false
}

function isSecurityOrCritical(event: ActivityEvent): boolean {
  const meta = event.metadata as Record<string, unknown> | null
  if (!meta) return false
  const labels = meta.labels as string[] | undefined
  if (labels?.some((l) => l.toLowerCase().includes("security"))) return true
  if (meta.priority === "Blocker" || meta.priority === "Critical") return true
  return false
}

function extractDomains(event: ActivityEvent): string[] {
  const meta = event.metadata as Record<string, unknown> | null
  if (!meta) return []
  const labels = meta.labels as string[] | undefined
  if (!labels) return []
  // Domain labels are conventionally lowercase domain names
  return labels.filter(
    (l) =>
      !l.startsWith("Blocked") &&
      !l.startsWith("security") &&
      !["bug", "enhancement", "feature", "task"].includes(l.toLowerCase()),
  )
}

function extractWorkItemKey(event: ActivityEvent): string {
  // Prefer Jira key cross-reference
  const meta = event.metadata as Record<string, unknown> | null
  if (meta?.jira_key) return meta.jira_key as string
  if (meta?.jira_keys && Array.isArray(meta.jira_keys) && meta.jira_keys.length > 0) {
    return meta.jira_keys[0] as string
  }
  // Fall back to source_id which is already deduplicatable
  return event.source_id
}

function computeScore(
  event: ActivityEvent,
  config: NeedsMeConfig,
  blocking: boolean,
  domains: string[],
): { score: number; breakdown: string } {
  const weights = { ...DEFAULT_BASE_WEIGHTS, ...config.baseWeights }
  const agePenaltyPerHour = config.agePenaltyPerHour ?? DEFAULT_AGE_PENALTY_PER_HOUR
  const agePenaltyCap = config.agePenaltyCap ?? DEFAULT_AGE_PENALTY_CAP
  const blockingMult = config.blockingMultiplier ?? DEFAULT_BLOCKING_MULTIPLIER
  const domainBonusMap = config.domainBonus ?? {}

  // Base weight
  const baseWeight = weights[event.event_type] ?? 5
  const parts: string[] = [`${event.event_type}(${baseWeight})`]

  // Age penalty
  const ageHours = Math.max(0, (Date.now() - event.timestamp) / 3_600_000)
  const agePenalty = Math.min(Math.round(agePenaltyPerHour * ageHours), agePenaltyCap)
  if (agePenalty > 0) {
    parts.push(`${Math.round(ageHours)}h-old(${agePenalty})`)
  }

  // Domain bonus
  let domainBonus = 0
  for (const d of domains) {
    const bonus = domainBonusMap[d] ?? domainBonusMap[d.toLowerCase()] ?? 0
    if (bonus > 0) {
      domainBonus += bonus
      parts.push(`domain:${d}(+${bonus})`)
    }
  }

  // Blocking multiplier
  let multiplier = 1
  if (blocking) {
    multiplier = blockingMult
    parts.push(`blocks(x${blockingMult})`)
  }

  const raw = Math.round((baseWeight + agePenalty + domainBonus) * multiplier)
  const score = Math.min(raw, MAX_SCORE)

  parts.push(`= ${score}`)

  return { score, breakdown: parts.join("  ") }
}

// --- Main classifier ---

export interface ClassifyResult {
  items: NeedsMeItem[]
}

/**
 * Classify and score a batch of ActivityEvents into NeedsMeItems.
 * Performs cross-source deduplication by work-item key.
 * Returns items sorted by score descending.
 */
export function classify(events: ActivityEvent[], config: NeedsMeConfig): ClassifyResult {
  // First pass: classify each event
  const classified: Array<{
    event: ActivityEvent
    tier: NeedsMeTier
    rule: string
    workItemKey: string
    blocking: boolean
    domains: string[]
    exempt: boolean
  }> = []

  for (const event of events) {
    let tier: NeedsMeTier | null = null
    let rule = event.event_type as string

    if (isTier1(event, config)) {
      tier = 1
      if (isNeedsMePhase2(event)) rule = "needsMe"
      else if (isAgentNeedsReview(event)) rule = "agent_needs_review"
    } else if (isTier2(event, config)) {
      tier = 2
    }

    if (tier === null) continue

    classified.push({
      event,
      tier,
      rule,
      workItemKey: extractWorkItemKey(event),
      blocking: isBlocking(event),
      domains: extractDomains(event),
      exempt: isSecurityOrCritical(event),
    })
  }

  // Second pass: deduplicate by work-item key, keeping highest-priority signal
  const byWorkItem = new Map<
    string,
    {
      events: typeof classified
      bestScore: number
      bestIdx: number
    }
  >()

  for (let i = 0; i < classified.length; i++) {
    const c = classified[i]
    const key = c.workItemKey
    const { score } = computeScore(c.event, config, c.blocking, c.domains)

    const existing = byWorkItem.get(key)
    if (!existing) {
      byWorkItem.set(key, { events: [c], bestScore: score, bestIdx: 0 })
    } else {
      existing.events.push(c)
      if (score > existing.bestScore) {
        existing.bestScore = score
        existing.bestIdx = existing.events.length - 1
      }
    }
  }

  // Third pass: build final items
  const items: NeedsMeItem[] = []

  for (const [workItemKey, group] of byWorkItem) {
    const best = group.events[group.bestIdx]
    const { score, breakdown } = computeScore(best.event, config, best.blocking, best.domains)

    const sources = [...new Set(group.events.map((e) => e.event.source))]
    const eventIds = group.events.map((e) => e.event.id)

    items.push({
      id: `nm_${workItemKey}_${best.event.id}`,
      workItemKey,
      tier: best.tier,
      rule: best.rule,
      ruleSource: `${best.rule}:${best.event.source}`,
      score,
      scoreBreakdown: breakdown,
      title: best.event.title,
      url: best.event.url,
      actor: best.event.actor,
      timestamp: best.event.timestamp,
      sources,
      eventIds,
      isBlocking: group.events.some((e) => e.blocking),
      domains: [...new Set(group.events.flatMap((e) => e.domains))],
      isExemptFromSuppression: group.events.some((e) => e.exempt),
    })
  }

  // Sort by score descending
  items.sort((a, b) => b.score - a.score)

  return { items }
}
