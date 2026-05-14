/**
 * Enriches NeedsMeItems with process phase information from the assessor.
 *
 * - Wraps NeedsMeItem with process lifecycle phase and facilitation data.
 * - For items with Jira metadata (issue_type + description), runs an inline
 *   assessment for freshness instead of relying solely on the DB cache.
 * - Builds phase-specific facilitation prompts for the LLM.
 */

import type { NeedsMeItem } from "./classifier"
import { Database } from "@/storage/db"
import { IssueProcessStateTable } from "@/process/process.sql"
import { ActivityEventTable } from "@/activity-feed/activity-feed.sql"
import { assess, type IssueInput, type Phase } from "@/process/assessor"
import { desc, eq, and } from "drizzle-orm"

// --- Types ---

export interface ProcessEnrichedItem {
  item: NeedsMeItem
  processPhase: string | null // "problem" / "spec" / "plan" / "ready" / null
  processNeed: string | null // "Write statement" / "Write scope" / "Create subtasks" / null
  phaseColor: "error" | "warning" | "info" | "success" | "muted"
}

// --- Helpers ---

/** Jira issue keys follow the pattern PROJECT-123 */
const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/

function isJiraKey(key: string): boolean {
  return JIRA_KEY_RE.test(key)
}

/** Map an assessor Phase to the display values used in the enriched item. */
function mapPhase(phase: Phase): {
  processPhase: string
  processNeed: string | null
  phaseColor: ProcessEnrichedItem["phaseColor"]
} {
  switch (phase) {
    case "needs_problem":
      return { processPhase: "problem", processNeed: "Write statement", phaseColor: "error" }
    case "has_problem":
    case "needs_scope":
      return { processPhase: "spec", processNeed: "Write scope", phaseColor: "warning" }
    case "ready":
      return { processPhase: "ready", processNeed: null, phaseColor: "success" }
  }
}

/**
 * Try to get event metadata for a Jira work item key.
 * Returns issue_type and description if available.
 */
function getEventMetadata(workItemKey: string): {
  issueType: string | null
  description: string | null
  summary: string | null
  labels: string[]
} | null {
  return Database.use((db) => {
    const row = db
      .select({
        title: ActivityEventTable.title,
        metadata: ActivityEventTable.metadata,
      })
      .from(ActivityEventTable)
      .where(
        and(
          eq(ActivityEventTable.source, "jira"),
          eq(ActivityEventTable.source_id, workItemKey),
        ),
      )
      .orderBy(desc(ActivityEventTable.timestamp))
      .limit(1)
      .get()

    if (!row) return null

    const meta = row.metadata as Record<string, unknown> | null
    if (!meta) return null

    return {
      issueType: (meta.issue_type as string) ?? null,
      description: (meta.description as string) ?? null,
      summary: row.title.replace(`${workItemKey}: `, ""),
      labels: (meta.labels as string[]) ?? [],
    }
  })
}

/**
 * Look up the cached process state from IssueProcessStateTable.
 */
function getCachedPhase(issueKey: string): Phase | null {
  return Database.use((db) => {
    const row = db
      .select({ phase: IssueProcessStateTable.phase })
      .from(IssueProcessStateTable)
      .where(eq(IssueProcessStateTable.issue_key, issueKey))
      .get()

    if (!row) return null
    return row.phase as Phase
  })
}

// --- Public API ---

/**
 * Enrich NeedsMeItems with process phase information.
 *
 * For each item with a Jira work item key:
 * 1. If event metadata has issue_type and description, run an inline
 *    assessment for freshness.
 * 2. Otherwise, fall back to the IssueProcessStateTable cache.
 * 3. Non-Jira items get null phase (muted color).
 */
export function enrichWithProcessState(items: NeedsMeItem[]): ProcessEnrichedItem[] {
  return items.map((item): ProcessEnrichedItem => {
    // Non-Jira items: no process data
    if (!isJiraKey(item.workItemKey)) {
      return {
        item,
        processPhase: null,
        processNeed: null,
        phaseColor: "muted",
      }
    }

    // Try inline assessment from event metadata first (fresher)
    const eventMeta = getEventMetadata(item.workItemKey)
    if (eventMeta?.issueType && eventMeta.description !== undefined) {
      const input: IssueInput = {
        key: item.workItemKey,
        summary: eventMeta.summary ?? item.title,
        issueType: eventMeta.issueType,
        description: eventMeta.description,
        labels: eventMeta.labels,
      }
      const result = assess(input)
      const mapped = mapPhase(result.phase)
      return {
        item,
        processPhase: mapped.processPhase,
        processNeed: mapped.processNeed,
        phaseColor: mapped.phaseColor,
      }
    }

    // Fall back to cached process state
    const cachedPhase = getCachedPhase(item.workItemKey)
    if (cachedPhase) {
      const mapped = mapPhase(cachedPhase)
      return {
        item,
        processPhase: mapped.processPhase,
        processNeed: mapped.processNeed,
        phaseColor: mapped.phaseColor,
      }
    }

    // Jira item with no process data yet (not assessed)
    return {
      item,
      processPhase: null,
      processNeed: null,
      phaseColor: "muted",
    }
  })
}

/**
 * Build a phase-specific facilitation prompt for the LLM.
 *
 * The prompt guides the assistant to fetch issue details and take the
 * appropriate next step based on the item's process phase.
 */
export function buildFacilitationPrompt(enriched: ProcessEnrichedItem): string {
  const { item, processPhase } = enriched
  const workItemKey = item.workItemKey

  switch (processPhase) {
    case "problem":
      return [
        `This issue needs a problem statement. Fetch the full details via jira_get_issue for ${workItemKey}.`,
        `Read the current description and draft a Problem Statement section.`,
        `Use h2. Problem Statement for Epics, h3. Problem Statement for Tasks/Bugs.`,
        `The statement should describe WHAT is broken or missing, not HOW to fix it.`,
        `Show the draft and ask for approval before updating.`,
      ].join("\n")

    case "spec":
      return [
        `This epic has a problem statement but needs a Scope of Work.`,
        `Fetch the full issue via jira_get_issue, read the problem statement.`,
        `Draft a h2. Scope of Work section defining boundaries and deliverables.`,
        `Show the draft and ask for approval before updating.`,
      ].join("\n")

    case "plan":
      return [
        `This epic is ready for implementation planning.`,
        `Fetch the full issue, read the problem and scope.`,
        `Propose a breakdown into sub-issues, each independently implementable.`,
        `List them and ask for approval before creating via jira_create_issue.`,
      ].join("\n")

    default:
      // Non-process or ready items get a generic triage prompt
      return [
        `Triage this item: ${item.title}`,
        `Score: ${item.score} | Rule: ${item.rule}`,
        `URL: ${item.url}`,
        `Fetch details and tell me what action is needed.`,
      ].join("\n")
  }
}
