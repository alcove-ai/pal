/**
 * Epic proposal detector.
 *
 * Pure metadata overlap: if 3+ issues sharing the same component or label
 * are created within 7 days without a parent epic, suggest creating an epic.
 *
 * No embeddings. No LLM. Just metadata grouping.
 *
 * Cooldown: 30 days before re-suggesting the same cluster key.
 */

import * as Log from "@opencode-ai/core/util/log"
import { Database } from "@/storage/db"
import { ProposedEpicTable } from "./process.sql"
import { Identifier } from "@/id/id"
import { eq, and, gt } from "drizzle-orm"

const log = Log.create({ service: "process.epic-proposer" })

/** Minimum cluster size to trigger a proposal */
const MIN_CLUSTER_SIZE = 3

/** Time window: issues must be created within 7 days of each other */
const CLUSTER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Cooldown: don't re-propose the same cluster for 30 days */
const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000

// --- Types ---

export interface IssueMetadata {
  key: string
  issueType: string
  components: string[]
  labels: string[]
  parentKey: string | null
  createdAt: number
}

export interface EpicProposal {
  id: string
  clusterKey: string
  issueKeys: string[]
  proposedAt: number
}

// --- Core logic ---

/**
 * Given a batch of recently-created issues, detect clusters that could benefit
 * from an epic and return proposals (respecting cooldown).
 */
export function detectProposals(issues: IssueMetadata[]): EpicProposal[] {
  // Only consider issues without a parent epic
  const orphans = issues.filter((i) => !i.parentKey && i.issueType !== "Epic")

  // Group by each component and label dimension
  const groups = new Map<string, IssueMetadata[]>()

  for (const issue of orphans) {
    for (const component of issue.components) {
      const key = `component:${component}`
      const list = groups.get(key) ?? []
      list.push(issue)
      groups.set(key, list)
    }
    for (const label of issue.labels) {
      const key = `label:${label}`
      const list = groups.get(key) ?? []
      list.push(issue)
      groups.set(key, list)
    }
  }

  const proposals: EpicProposal[] = []
  const now = Date.now()

  for (const [clusterKey, members] of groups) {
    if (members.length < MIN_CLUSTER_SIZE) continue

    // Check if all members fall within the time window
    const sorted = members.sort((a, b) => a.createdAt - b.createdAt)
    const earliest = sorted[0].createdAt
    const latest = sorted[sorted.length - 1].createdAt
    if (latest - earliest > CLUSTER_WINDOW_MS) continue

    // Check cooldown
    if (isOnCooldown(clusterKey, now)) continue

    const issueKeys = [...new Set(sorted.map((m) => m.key))]

    proposals.push({
      id: Identifier.create("epp", "ascending"),
      clusterKey,
      issueKeys,
      proposedAt: now,
    })
  }

  return proposals
}

/**
 * Check if a cluster key is on cooldown (proposed within the last 30 days).
 */
function isOnCooldown(clusterKey: string, now: number): boolean {
  const cutoff = now - COOLDOWN_MS
  return Database.use((db) => {
    const rows = db
      .select({ id: ProposedEpicTable.id })
      .from(ProposedEpicTable)
      .where(
        and(
          eq(ProposedEpicTable.cluster_key, clusterKey),
          gt(ProposedEpicTable.proposed_at, cutoff),
        ),
      )
      .limit(1)
      .all()
    return rows.length > 0
  })
}

/**
 * Persist new proposals to SQLite.
 */
export function storeProposals(proposals: EpicProposal[]): void {
  if (proposals.length === 0) return

  Database.use((db) => {
    for (const proposal of proposals) {
      db.insert(ProposedEpicTable)
        .values({
          id: proposal.id,
          cluster_key: proposal.clusterKey,
          issue_keys: proposal.issueKeys.join(","),
          proposed_at: proposal.proposedAt,
          dismissed: 0,
        })
        .onConflictDoNothing()
        .run()
    }
  })

  log.info("stored epic proposals", { count: proposals.length })
}

/**
 * Get all active (non-dismissed) proposals.
 */
export function getActiveProposals(): EpicProposal[] {
  return Database.use((db) => {
    const rows = db
      .select()
      .from(ProposedEpicTable)
      .where(eq(ProposedEpicTable.dismissed, 0))
      .all()

    return rows.map((r) => ({
      id: r.id,
      clusterKey: r.cluster_key,
      issueKeys: r.issue_keys.split(","),
      proposedAt: r.proposed_at,
    }))
  })
}

/**
 * Dismiss a proposal by ID.
 */
export function dismissProposal(proposalId: string): void {
  Database.use((db) => {
    db.update(ProposedEpicTable)
      .set({ dismissed: 1 })
      .where(eq(ProposedEpicTable.id, proposalId))
      .run()
  })
}
