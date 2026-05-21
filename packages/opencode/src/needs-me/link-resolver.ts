/**
 * Pure link-resolution logic for deduplicating PRs linked to issues.
 *
 * Given a flat list of ActivityItems, this module detects cross-source links
 * (e.g. a GitHub PR whose title contains a Jira key, or a Jira issue whose
 * description references a GitHub PR URL) and returns grouped/standalone items.
 *
 * The link resolver is a pure function — no DB access, no side effects.
 */

import type { ActivityItem } from "./needs-me-logic"

// --- Types ---

export interface LinkedGroup {
  /** The primary item (always an issue — Jira or GitHub) */
  primary: ActivityItem
  /** PRs/MRs linked to this issue */
  linked: ActivityItem[]
}

export interface ResolveLinksResult {
  /** Items that have links (issue + its PRs) */
  groups: LinkedGroup[]
  /** Items with no links (stay as top-level) */
  standalone: ActivityItem[]
}

// --- Helpers ---

/** Event types that represent PRs (not issues) */
const PR_EVENT_TYPES = new Set([
  "pr_opened",
  "pr_merged",
  "pr_closed",
  "review_requested",
  "review_submitted",
  "pr_commented",
  "mr_opened",
  "mr_merged",
  "mr_commented",
])

/** Event types that represent issues (not PRs) */
const ISSUE_EVENT_TYPES = new Set([
  "issue_created",
  "issue_opened",
  "issue_closed",
  "issue_commented",
  "status_changed",
  "assigned",
  "commented",
  "priority_changed",
  "blocked",
  "field_updated",
])

/**
 * Regex to extract "Fixes #N", "Closes #N", "Related to #N" from PR titles.
 * Case-insensitive, captures the issue number.
 */
const GITHUB_ISSUE_REF_REGEX = /(?:fix(?:es)?|close[sd]?|related?\s+to)\s+#(\d+)/gi

function isPr(item: ActivityItem): boolean {
  if (PR_EVENT_TYPES.has(item.event_type)) return true
  // GitHub PRs have source_id like "owner/repo#123" and event_type in PR set
  // For items that come from notifications, check the source
  if (item.source === "github" && item.event_type === "ci_failed") return true
  if (item.source === "github" && item.event_type === "mentioned") {
    // Ambiguous — could be PR or issue mention. Check title for PR indicators.
    // Conservative: treat as non-PR so it doesn't get hidden
    return false
  }
  return false
}

function isIssue(item: ActivityItem): boolean {
  if (item.source === "jira") return true
  if (ISSUE_EVENT_TYPES.has(item.event_type)) return true
  return false
}

/**
 * Extract the repo from a GitHub source_id like "owner/repo#123"
 */
function extractRepo(sourceId: string): string | null {
  const match = sourceId.match(/^(.+)#\d+$/)
  return match ? match[1] : null
}

/**
 * Extract the number from a GitHub source_id like "owner/repo#123"
 */
function extractNumber(sourceId: string): number | null {
  const match = sourceId.match(/#(\d+)$/)
  return match ? parseInt(match[1], 10) : null
}

/**
 * Normalize a GitHub PR URL to a comparable form.
 * Input:  "https://github.com/owner/repo/pull/42"
 * Output: "owner/repo#42"
 */
function normalizePrUrl(url: string): string | null {
  const match = url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)
  if (match) return `${match[1]}#${match[2]}`
  return null
}

// --- Main resolver ---

/**
 * Resolve links between issues and PRs to deduplicate the Needs Me display.
 *
 * Link detection rules (priority order):
 * 1. GitHub PR has metadata.jira_keys containing PROJ-123 AND a Jira issue with source_id=PROJ-123 exists
 * 2. Jira issue has metadata.github_pr_urls containing a URL matching a GitHub PR's url
 * 3. GitHub PR title contains "Fixes #N" / "Closes #N" / "Related to #N" AND a GitHub issue repo#N exists
 * 4. Issues are always primary. Jira issues win over GitHub issues if both link to the same PR.
 * 5. Standalone PRs (no linked issue) remain as standalone items.
 */
export function resolveLinks(items: ActivityItem[]): ResolveLinksResult {
  // Build indexes for fast lookup
  const jiraIssuesByKey = new Map<string, ActivityItem>()     // "PROJ-123" -> item
  const githubIssuesByRepoNum = new Map<string, ActivityItem>() // "owner/repo#42" -> item
  const prs: ActivityItem[] = []

  for (const item of items) {
    if (item.source === "jira") {
      jiraIssuesByKey.set(item.source_id, item)
    } else if (item.source === "github" || item.source === "gitlab") {
      if (isPr(item)) {
        prs.push(item)
      } else if (isIssue(item)) {
        githubIssuesByRepoNum.set(item.source_id, item)
      }
    }
  }

  // Track which PRs have been linked (PR source_id -> primary issue source_id)
  // If a PR links to multiple issues, Jira wins over GitHub
  const prToIssue = new Map<string, { issue: ActivityItem; source: "jira" | "github" }>()

  for (const pr of prs) {
    const meta = pr.metadata as Record<string, unknown> | null

    // Rule 1: PR has metadata.jira_keys -> link to Jira issue
    if (meta) {
      const jiraKeys = Array.isArray(meta.jira_keys) ? (meta.jira_keys as string[]) : []
      for (const key of jiraKeys) {
        const jiraIssue = jiraIssuesByKey.get(key)
        if (jiraIssue) {
          const existing = prToIssue.get(pr.source_id)
          // Jira always wins (Rule 4)
          if (!existing || existing.source !== "jira") {
            prToIssue.set(pr.source_id, { issue: jiraIssue, source: "jira" })
          }
          break // Take the first matching Jira key
        }
      }
    }

    // Rule 3: PR title contains "Fixes #N" etc. -> link to GitHub issue
    if (pr.source === "github") {
      const repo = extractRepo(pr.source_id)
      if (repo) {
        // Strip the "repo#N: " prefix from title if present
        const titleForParsing = pr.title.replace(/^.+#\d+:\s*/, "")
        GITHUB_ISSUE_REF_REGEX.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = GITHUB_ISSUE_REF_REGEX.exec(titleForParsing)) !== null) {
          const issueNum = parseInt(match[1], 10)
          const issueSourceId = `${repo}#${issueNum}`
          const ghIssue = githubIssuesByRepoNum.get(issueSourceId)
          if (ghIssue) {
            const existing = prToIssue.get(pr.source_id)
            // Only use GitHub link if no Jira link exists (Rule 4)
            if (!existing) {
              prToIssue.set(pr.source_id, { issue: ghIssue, source: "github" })
            }
            break
          }
        }
      }
    }
  }

  // Rule 2: Jira issue has metadata.github_pr_urls -> link matching PR to this issue
  for (const [, jiraIssue] of jiraIssuesByKey) {
    const meta = jiraIssue.metadata as Record<string, unknown> | null
    if (!meta) continue
    const prUrls = Array.isArray(meta.github_pr_urls) ? (meta.github_pr_urls as string[]) : []
    for (const url of prUrls) {
      const normalized = normalizePrUrl(url)
      if (!normalized) continue
      // Find a PR with this source_id
      const matchingPr = prs.find((p) => p.source_id === normalized)
      if (matchingPr) {
        const existing = prToIssue.get(matchingPr.source_id)
        // Jira always wins (Rule 4)
        if (!existing || existing.source !== "jira") {
          prToIssue.set(matchingPr.source_id, { issue: jiraIssue, source: "jira" })
        }
      }
    }
  }

  // Build groups from the prToIssue map
  const issueToLinkedPrs = new Map<string, ActivityItem[]>()
  for (const [prSourceId, { issue }] of prToIssue) {
    const pr = prs.find((p) => p.source_id === prSourceId)
    if (!pr) continue
    let linked = issueToLinkedPrs.get(issue.source_id)
    if (!linked) {
      linked = []
      issueToLinkedPrs.set(issue.source_id, linked)
    }
    linked.push(pr)
  }

  const linkedPrSourceIds = new Set(prToIssue.keys())
  const primaryIssueSourceIds = new Set(issueToLinkedPrs.keys())

  const groups: LinkedGroup[] = []
  for (const [issueSourceId, linkedPrs] of issueToLinkedPrs) {
    const issue = jiraIssuesByKey.get(issueSourceId) ?? githubIssuesByRepoNum.get(issueSourceId)
    if (issue) {
      groups.push({ primary: issue, linked: linkedPrs })
    }
  }

  // Standalone = everything that isn't a linked PR and isn't already a primary issue in a group
  const standalone = items.filter((item) => {
    if (linkedPrSourceIds.has(item.source_id)) return false
    // Primary issues are NOT filtered out — they remain in standalone
    // because the caller will use the groups to annotate them with linkedPrCount
    // and the groups info is separate
    return true
  })

  return { groups, standalone }
}

/**
 * Apply link resolution to a list of ActivityItems for display.
 *
 * Returns a new list where:
 * - Linked PRs are removed
 * - Primary issues get a linkedPrCount annotation
 */
export function applyLinkResolution(items: ActivityItem[]): ActivityItem[] {
  const { groups, standalone } = resolveLinks(items)

  // Build a map of primary issue source_id -> linked PR count
  const linkedCounts = new Map<string, number>()
  for (const group of groups) {
    linkedCounts.set(group.primary.source_id, group.linked.length)
  }

  // Annotate standalone items with linkedPrCount
  return standalone.map((item) => {
    const count = linkedCounts.get(item.source_id)
    if (count && count > 0) {
      return { ...item, linkedPrCount: count }
    }
    return item
  })
}
