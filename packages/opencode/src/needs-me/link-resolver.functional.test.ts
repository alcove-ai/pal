/**
 * Functional tests for PR-to-issue link resolution (issue #2).
 *
 * Tests the resolveLinks() function which groups ActivityItems into:
 *   - LinkedGroup: a primary issue + one or more linked PRs
 *   - standalone items: items with no cross-references
 *
 * The resolver connects PRs to issues using three strategies:
 *   1. jira_keys — GitHub PR metadata contains Jira key(s) extracted from title/branch
 *   2. github_pr_urls — Jira issue metadata contains GitHub PR URL(s) from description/comments
 *   3. "Fixes #N" — GitHub PR title references a GitHub issue in the same repo
 *
 * Because ActivityItem (needs-me-logic.ts) does not carry jira_keys or github_pr_urls,
 * the resolver accepts LinkableItem — an ActivityItem extended with optional link metadata.
 *
 * Tests two categories:
 *   1. Pure logic: synthetic items, no network
 *   2. Integration: real pal-testing fixture data
 *
 * Requirements:
 *   - gh CLI authenticated (for integration tests)
 *   - Network access to github.com
 *
 * Run: bun run src/needs-me/link-resolver.functional.test.ts
 */

import { createGitHubAdapter } from "@/activity-feed/github-adapter"
import {
  filterDoneItems,
  type ActivityItem,
} from "./needs-me-logic"

// ---------------------------------------------------------------------------
// Types the resolver will use (defined here until the implementation lands)
// ---------------------------------------------------------------------------

/**
 * ActivityItem extended with link-relevant metadata that the adapters already
 * produce but the base ActivityItem type does not expose.
 */
export type LinkableItem = ActivityItem & {
  /** Jira keys found in a GitHub PR title/branch (from github-adapter metadata.jira_keys) */
  jira_keys?: string[]
  /** GitHub/GitLab PR URLs found in a Jira issue description/comments (from jira-adapter metadata.github_pr_urls) */
  github_pr_urls?: string[]
}

/**
 * A group consisting of a primary issue and one or more linked PRs.
 */
export type LinkedGroup = {
  primary: LinkableItem
  linkedPRs: LinkableItem[]
  linkedCount: number
}

/**
 * Result of resolveLinks(): grouped items + standalone items.
 */
export type LinkResult = {
  groups: LinkedGroup[]
  standalone: LinkableItem[]
}

// ---------------------------------------------------------------------------
// Stub implementation of resolveLinks — the real one will live in link-resolver.ts
// This stub implements the expected behavior so the tests validate the contract.
// The implementation agent will replace this with the real module import.
// ---------------------------------------------------------------------------

function resolveLinks(items: LinkableItem[]): LinkResult {
  // Index issues by their identifiers for fast lookup
  const issuesByJiraKey = new Map<string, LinkableItem>()
  const issuesByGitHubId = new Map<string, LinkableItem>() // "org/repo#N"
  const issuesByUrl = new Map<string, LinkableItem>()

  // Separate issues from PRs
  const prEventTypes = new Set(["pr_opened", "pr_merged", "pr_closed", "review_requested", "review_submitted", "pr_commented", "ci_failed"])
  const issues: LinkableItem[] = []
  const prs: LinkableItem[] = []

  for (const item of items) {
    if (prEventTypes.has(item.event_type)) {
      prs.push(item)
    } else {
      issues.push(item)
    }
  }

  // Index issues
  for (const issue of issues) {
    // Jira issues: key is source_id (e.g. "PULP-1234")
    if (issue.source === "jira") {
      issuesByJiraKey.set(issue.source_id, issue)
    }
    // GitHub issues: source_id is "org/repo#N"
    if (issue.source === "github") {
      issuesByGitHubId.set(issue.source_id, issue)
    }
    // Index by URL for github_pr_urls reverse lookup
    if (issue.url) {
      issuesByUrl.set(issue.url, issue)
    }
  }

  // Build links: PR -> issue
  const prToIssue = new Map<string, LinkableItem>() // PR source_id -> issue
  const usedPRs = new Set<string>()
  const usedIssues = new Set<string>()

  for (const pr of prs) {
    let linkedIssue: LinkableItem | undefined

    // Strategy 1: PR has jira_keys -> find matching Jira issue
    if (pr.jira_keys && pr.jira_keys.length > 0) {
      for (const jiraKey of pr.jira_keys) {
        const issue = issuesByJiraKey.get(jiraKey)
        if (issue) {
          // Prefer Jira issue over any previously linked GitHub issue
          if (!linkedIssue || linkedIssue.source !== "jira") {
            linkedIssue = issue
          }
          break
        }
      }
    }

    // Strategy 2: "Fixes #N" in PR title -> find matching GitHub issue in same repo
    if (!linkedIssue || linkedIssue.source !== "jira") {
      const fixesMatch = pr.title.match(/\bFixes\s+#(\d+)\b/i)
      if (fixesMatch) {
        const issueNum = fixesMatch[1]
        // Extract repo from PR source_id (e.g. "org/repo#15" -> "org/repo")
        const repoMatch = pr.source_id.match(/^(.+)#\d+$/)
        if (repoMatch) {
          const repo = repoMatch[1]
          const ghIssueId = `${repo}#${issueNum}`
          const ghIssue = issuesByGitHubId.get(ghIssueId)
          if (ghIssue && (!linkedIssue || linkedIssue.source !== "jira")) {
            linkedIssue = ghIssue
          }
        }
      }
    }

    if (linkedIssue) {
      prToIssue.set(pr.source_id, linkedIssue)
      usedPRs.add(pr.source_id)
      usedIssues.add(linkedIssue.source_id)
    }
  }

  // Strategy 3: Jira issue has github_pr_urls -> find matching GitHub PRs
  for (const issue of issues) {
    if (issue.github_pr_urls && issue.github_pr_urls.length > 0) {
      for (const prUrl of issue.github_pr_urls) {
        // Find PR by URL match
        for (const pr of prs) {
          if (pr.url === prUrl && !usedPRs.has(pr.source_id)) {
            prToIssue.set(pr.source_id, issue)
            usedPRs.add(pr.source_id)
            usedIssues.add(issue.source_id)
          }
        }
      }
    }
  }

  // Build groups from prToIssue mapping
  const groupsByIssue = new Map<string, LinkedGroup>()

  for (const [prSourceId, issue] of prToIssue) {
    const pr = prs.find((p) => p.source_id === prSourceId)
    if (!pr) continue

    if (!groupsByIssue.has(issue.source_id)) {
      groupsByIssue.set(issue.source_id, {
        primary: issue,
        linkedPRs: [],
        linkedCount: 0,
      })
    }
    const group = groupsByIssue.get(issue.source_id)!
    group.linkedPRs.push(pr)
    group.linkedCount = group.linkedPRs.length
  }

  // Standalone: items not in any group
  const standalone: LinkableItem[] = []
  for (const item of items) {
    if (!usedPRs.has(item.source_id) && !usedIssues.has(item.source_id)) {
      standalone.push(item)
    }
  }

  return {
    groups: Array.from(groupsByIssue.values()),
    standalone,
  }
}

// ---------------------------------------------------------------------------
// Test harness (matches pattern from needs-me-urgency.functional.test.ts)
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`)
  }
}

function assertEq<T>(actual: T, expected: T, name: string) {
  if (actual === expected) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeItem(
  sourceId: string,
  title: string,
  ts: number,
  extra: Partial<LinkableItem> = {},
): LinkableItem {
  return {
    source_id: sourceId,
    source: "github",
    title,
    url: `https://github.com/test/${sourceId.replace("#", "/issues/")}`,
    actor: "testuser",
    last_event_ts: ts,
    event_type: "issue_opened",
    summary: null,
    parent_key: null,
    issue_type: null,
    milestone: null,
    milestone_url: null,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Test 1: Jira <-> GitHub PR linking via jira_keys
// ---------------------------------------------------------------------------

function testJiraKeysLinking() {
  console.log("Link via jira_keys — GitHub PR references Jira issue:")

  const jiraIssue = makeItem("PULP-1234", "PULP-1234: Fix the widget", 1000, {
    source: "jira",
    event_type: "issue_created",
    url: "https://issues.redhat.com/browse/PULP-1234",
  })

  const githubPR = makeItem("org/repo#42", "org/repo#42: PULP-1234 fix widget", 2000, {
    source: "github",
    event_type: "pr_opened",
    url: "https://github.com/org/repo/pull/42",
    jira_keys: ["PULP-1234"],
  })

  const result = resolveLinks([jiraIssue, githubPR])

  assertEq(result.groups.length, 1, "one linked group")
  assertEq(result.groups[0].primary.source_id, "PULP-1234", "Jira issue is primary")
  assertEq(result.groups[0].linkedPRs.length, 1, "one linked PR")
  assertEq(result.groups[0].linkedPRs[0].source_id, "org/repo#42", "correct PR linked")
  assertEq(result.groups[0].linkedCount, 1, "linkedCount = 1")
  assertEq(result.standalone.length, 0, "no standalone items")
}

// ---------------------------------------------------------------------------
// Test 2: Jira <-> GitHub PR linking via github_pr_urls
// ---------------------------------------------------------------------------

function testGitHubPrUrlsLinking() {
  console.log("\nLink via github_pr_urls — Jira issue contains PR URL:")

  const jiraIssue = makeItem("PULP-5678", "PULP-5678: Implement feature X", 1000, {
    source: "jira",
    event_type: "issue_created",
    url: "https://issues.redhat.com/browse/PULP-5678",
    github_pr_urls: ["https://github.com/org/repo/pull/42"],
  })

  const githubPR = makeItem("org/repo#42", "org/repo#42: Implement feature X", 2000, {
    source: "github",
    event_type: "pr_opened",
    url: "https://github.com/org/repo/pull/42",
  })

  const result = resolveLinks([jiraIssue, githubPR])

  assertEq(result.groups.length, 1, "one linked group")
  assertEq(result.groups[0].primary.source_id, "PULP-5678", "Jira issue is primary")
  assertEq(result.groups[0].linkedPRs.length, 1, "one linked PR")
  assertEq(result.groups[0].linkedPRs[0].source_id, "org/repo#42", "correct PR linked")
  assertEq(result.standalone.length, 0, "no standalone items")
}

// ---------------------------------------------------------------------------
// Test 3: GitHub issue <-> PR linking via "Fixes #N"
// ---------------------------------------------------------------------------

function testFixesHashLinking() {
  console.log('\nLink via "Fixes #N" — GitHub PR title references GitHub issue:')

  const githubIssue = makeItem("org/repo#10", "org/repo#10: Bug in parser", 1000, {
    source: "github",
    event_type: "issue_opened",
    url: "https://github.com/org/repo/issues/10",
  })

  const githubPR = makeItem("org/repo#15", "org/repo#15: Fixes #10", 2000, {
    source: "github",
    event_type: "pr_opened",
    url: "https://github.com/org/repo/pull/15",
  })

  const result = resolveLinks([githubIssue, githubPR])

  assertEq(result.groups.length, 1, "one linked group")
  assertEq(result.groups[0].primary.source_id, "org/repo#10", "GitHub issue is primary")
  assertEq(result.groups[0].linkedPRs.length, 1, "one linked PR")
  assertEq(result.groups[0].linkedPRs[0].source_id, "org/repo#15", "correct PR linked")
  assertEq(result.standalone.length, 0, "no standalone items")
}

// ---------------------------------------------------------------------------
// Test 4: Multiple PRs linked to one issue
// ---------------------------------------------------------------------------

function testMultiplePRsToOneIssue() {
  console.log("\nMultiple PRs linked to one issue:")

  const jiraIssue = makeItem("PULP-100", "PULP-100: Large feature", 1000, {
    source: "jira",
    event_type: "issue_created",
    url: "https://issues.redhat.com/browse/PULP-100",
  })

  const pr1 = makeItem("org/repo#20", "org/repo#20: PULP-100 part 1", 2000, {
    source: "github",
    event_type: "pr_opened",
    url: "https://github.com/org/repo/pull/20",
    jira_keys: ["PULP-100"],
  })

  const pr2 = makeItem("org/repo#21", "org/repo#21: PULP-100 part 2", 3000, {
    source: "github",
    event_type: "pr_opened",
    url: "https://github.com/org/repo/pull/21",
    jira_keys: ["PULP-100"],
  })

  const result = resolveLinks([jiraIssue, pr1, pr2])

  assertEq(result.groups.length, 1, "one linked group")
  assertEq(result.groups[0].primary.source_id, "PULP-100", "Jira issue is primary")
  assertEq(result.groups[0].linkedPRs.length, 2, "two linked PRs")
  assertEq(result.groups[0].linkedCount, 2, "linkedCount = 2")
  assertEq(result.standalone.length, 0, "no standalone items")

  const linkedIds = result.groups[0].linkedPRs.map((p) => p.source_id).sort()
  assert(linkedIds.includes("org/repo#20"), "PR #20 is linked")
  assert(linkedIds.includes("org/repo#21"), "PR #21 is linked")
}

// ---------------------------------------------------------------------------
// Test 5: Standalone PR (no linked issue)
// ---------------------------------------------------------------------------

function testStandalonePR() {
  console.log("\nStandalone PR — no matching issue:")

  const pr = makeItem("org/repo#99", "org/repo#99: Random cleanup", 1000, {
    source: "github",
    event_type: "pr_opened",
    url: "https://github.com/org/repo/pull/99",
    // No jira_keys, no "Fixes #N", no matching github_pr_urls
  })

  const result = resolveLinks([pr])

  assertEq(result.groups.length, 0, "no linked groups")
  assertEq(result.standalone.length, 1, "one standalone item")
  assertEq(result.standalone[0].source_id, "org/repo#99", "standalone PR preserved")
}

// ---------------------------------------------------------------------------
// Test 6: Standalone issue (no linked PRs)
// ---------------------------------------------------------------------------

function testStandaloneIssue() {
  console.log("\nStandalone issue — no linked PRs:")

  const issue = makeItem("PULP-999", "PULP-999: Orphaned issue", 1000, {
    source: "jira",
    event_type: "issue_created",
    url: "https://issues.redhat.com/browse/PULP-999",
    // No github_pr_urls, no PRs reference this key
  })

  const result = resolveLinks([issue])

  assertEq(result.groups.length, 0, "no linked groups")
  assertEq(result.standalone.length, 1, "one standalone item")
  assertEq(result.standalone[0].source_id, "PULP-999", "standalone issue preserved")
}

// ---------------------------------------------------------------------------
// Test 7: Jira issue wins over GitHub issue as primary
// ---------------------------------------------------------------------------

function testJiraWinsOverGitHub() {
  console.log("\nPriority — Jira issue is primary over GitHub issue:")

  const jiraIssue = makeItem("PULP-100", "PULP-100: Feature spec", 1000, {
    source: "jira",
    event_type: "issue_created",
    url: "https://issues.redhat.com/browse/PULP-100",
  })

  const githubIssue = makeItem("org/repo#5", "org/repo#5: Feature tracking", 1500, {
    source: "github",
    event_type: "issue_opened",
    url: "https://github.com/org/repo/issues/5",
  })

  const pr = makeItem("org/repo#30", "org/repo#30: PULP-100 implementation", 2000, {
    source: "github",
    event_type: "pr_opened",
    url: "https://github.com/org/repo/pull/30",
    jira_keys: ["PULP-100"],
  })

  const result = resolveLinks([jiraIssue, githubIssue, pr])

  assertEq(result.groups.length, 1, "one linked group")
  assertEq(result.groups[0].primary.source, "jira", "Jira issue is primary (not GitHub)")
  assertEq(result.groups[0].primary.source_id, "PULP-100", "correct Jira issue is primary")
  assertEq(result.groups[0].linkedPRs[0].source_id, "org/repo#30", "PR linked to Jira issue")

  // GitHub issue should be standalone since the PR linked to Jira
  assert(
    result.standalone.some((i) => i.source_id === "org/repo#5"),
    "GitHub issue remains standalone",
  )
}

// ---------------------------------------------------------------------------
// Test 8: Bidirectional linking resolves to same group
// ---------------------------------------------------------------------------

function testBidirectionalLinking() {
  console.log("\nBidirectional — both sides reference each other:")

  // Jira issue points to PR via github_pr_urls
  // AND PR points to Jira issue via jira_keys
  const jiraIssue = makeItem("PULP-200", "PULP-200: Cross-linked feature", 1000, {
    source: "jira",
    event_type: "issue_created",
    url: "https://issues.redhat.com/browse/PULP-200",
    github_pr_urls: ["https://github.com/org/repo/pull/50"],
  })

  const pr = makeItem("org/repo#50", "org/repo#50: PULP-200 bidirectional", 2000, {
    source: "github",
    event_type: "pr_opened",
    url: "https://github.com/org/repo/pull/50",
    jira_keys: ["PULP-200"],
  })

  const result = resolveLinks([jiraIssue, pr])

  assertEq(result.groups.length, 1, "exactly one group (no duplicates)")
  assertEq(result.groups[0].primary.source_id, "PULP-200", "Jira issue is primary")
  assertEq(result.groups[0].linkedPRs.length, 1, "one linked PR (not duplicated)")
  assertEq(result.standalone.length, 0, "no standalone items")
}

// ---------------------------------------------------------------------------
// Test 9: Merged PR still appears in links
// ---------------------------------------------------------------------------

function testMergedPRStillLinked() {
  console.log("\nMerged PR — still linked to its issue:")

  const jiraIssue = makeItem("PULP-300", "PULP-300: Feature with merged PR", 1000, {
    source: "jira",
    event_type: "issue_created",
    url: "https://issues.redhat.com/browse/PULP-300",
  })

  const mergedPR = makeItem("org/repo#60", "org/repo#60: PULP-300 done", 2000, {
    source: "github",
    event_type: "pr_merged",
    url: "https://github.com/org/repo/pull/60",
    jira_keys: ["PULP-300"],
  })

  const result = resolveLinks([jiraIssue, mergedPR])

  assertEq(result.groups.length, 1, "merged PR still forms a group")
  assertEq(result.groups[0].primary.source_id, "PULP-300", "Jira issue is primary")
  assertEq(result.groups[0].linkedPRs[0].event_type, "pr_merged", "PR retains merged status")
  assertEq(result.standalone.length, 0, "no standalone items")
}

// ---------------------------------------------------------------------------
// Test: Mixed — some linked, some standalone
// ---------------------------------------------------------------------------

function testMixedLinkedAndStandalone() {
  console.log("\nMixed — linked groups and standalone items coexist:")

  const jiraIssue = makeItem("PULP-400", "PULP-400: Linked feature", 1000, {
    source: "jira",
    event_type: "issue_created",
    url: "https://issues.redhat.com/browse/PULP-400",
  })

  const linkedPR = makeItem("org/repo#70", "org/repo#70: PULP-400 fix", 2000, {
    source: "github",
    event_type: "pr_opened",
    url: "https://github.com/org/repo/pull/70",
    jira_keys: ["PULP-400"],
  })

  const standalonePR = makeItem("org/repo#71", "org/repo#71: Unrelated cleanup", 3000, {
    source: "github",
    event_type: "pr_opened",
    url: "https://github.com/org/repo/pull/71",
  })

  const standaloneIssue = makeItem("PULP-401", "PULP-401: No PRs yet", 4000, {
    source: "jira",
    event_type: "issue_created",
    url: "https://issues.redhat.com/browse/PULP-401",
  })

  const result = resolveLinks([jiraIssue, linkedPR, standalonePR, standaloneIssue])

  assertEq(result.groups.length, 1, "one linked group")
  assertEq(result.groups[0].primary.source_id, "PULP-400", "correct issue is primary")
  assertEq(result.standalone.length, 2, "two standalone items")

  const standaloneIds = result.standalone.map((i) => i.source_id).sort()
  assert(standaloneIds.includes("PULP-401"), "standalone Jira issue preserved")
  assert(standaloneIds.includes("org/repo#71"), "standalone PR preserved")
}

// ---------------------------------------------------------------------------
// Test: "Fixes #N" case insensitivity
// ---------------------------------------------------------------------------

function testFixesCaseInsensitive() {
  console.log('\n"Fixes #N" case insensitivity:')

  const issue = makeItem("org/repo#10", "org/repo#10: Bug report", 1000, {
    source: "github",
    event_type: "issue_opened",
    url: "https://github.com/org/repo/issues/10",
  })

  // Lowercase "fixes"
  const pr = makeItem("org/repo#11", "org/repo#11: fixes #10", 2000, {
    source: "github",
    event_type: "pr_opened",
    url: "https://github.com/org/repo/pull/11",
  })

  const result = resolveLinks([issue, pr])

  assertEq(result.groups.length, 1, 'lowercase "fixes" is recognized')
  assertEq(result.groups[0].primary.source_id, "org/repo#10", "issue is primary")
}

// ---------------------------------------------------------------------------
// Test: PR with jira_keys referencing non-existent issue
// ---------------------------------------------------------------------------

function testJiraKeyNoMatchingIssue() {
  console.log("\njira_keys with no matching Jira issue in items:")

  const pr = makeItem("org/repo#80", "org/repo#80: PULP-9999 fix", 1000, {
    source: "github",
    event_type: "pr_opened",
    url: "https://github.com/org/repo/pull/80",
    jira_keys: ["PULP-9999"], // No PULP-9999 in the items list
  })

  const result = resolveLinks([pr])

  assertEq(result.groups.length, 0, "no group formed (missing issue)")
  assertEq(result.standalone.length, 1, "PR stays standalone")
}

// ---------------------------------------------------------------------------
// Test: Multiple jira_keys, first match wins
// ---------------------------------------------------------------------------

function testMultipleJiraKeysFirstMatchWins() {
  console.log("\nMultiple jira_keys — first matching issue wins:")

  const issue1 = makeItem("PULP-500", "PULP-500: Primary issue", 1000, {
    source: "jira",
    event_type: "issue_created",
    url: "https://issues.redhat.com/browse/PULP-500",
  })

  const issue2 = makeItem("PULP-501", "PULP-501: Secondary issue", 1100, {
    source: "jira",
    event_type: "issue_created",
    url: "https://issues.redhat.com/browse/PULP-501",
  })

  const pr = makeItem("org/repo#90", "org/repo#90: PULP-500 PULP-501", 2000, {
    source: "github",
    event_type: "pr_opened",
    url: "https://github.com/org/repo/pull/90",
    jira_keys: ["PULP-500", "PULP-501"],
  })

  const result = resolveLinks([issue1, issue2, pr])

  assertEq(result.groups.length, 1, "one group (first key match)")
  assertEq(result.groups[0].primary.source_id, "PULP-500", "first matching Jira key wins")
  assertEq(result.standalone.length, 1, "second issue is standalone")
  assertEq(result.standalone[0].source_id, "PULP-501", "PULP-501 not consumed")
}

// ---------------------------------------------------------------------------
// Test: Empty input
// ---------------------------------------------------------------------------

function testEmptyInput() {
  console.log("\nEmpty input — no items:")

  const result = resolveLinks([])

  assertEq(result.groups.length, 0, "no groups")
  assertEq(result.standalone.length, 0, "no standalone items")
}

// ---------------------------------------------------------------------------
// Test: All standalone (issues and PRs, no cross-references)
// ---------------------------------------------------------------------------

function testAllStandalone() {
  console.log("\nAll standalone — no cross-references:")

  const items: LinkableItem[] = [
    makeItem("PULP-600", "PULP-600: Issue A", 1000, { source: "jira", event_type: "issue_created" }),
    makeItem("PULP-601", "PULP-601: Issue B", 1100, { source: "jira", event_type: "issue_created" }),
    makeItem("org/repo#91", "org/repo#91: PR A", 2000, { event_type: "pr_opened" }),
    makeItem("org/repo#92", "org/repo#92: PR B", 2100, { event_type: "pr_opened" }),
  ]

  const result = resolveLinks(items)

  assertEq(result.groups.length, 0, "no linked groups")
  assertEq(result.standalone.length, 4, "all four items are standalone")
}

// ---------------------------------------------------------------------------
// Integration: real pal-testing data
// ---------------------------------------------------------------------------

const TEST_REPO = "alcove-ai/pal-testing"

function buildPipeline(events: any[]): { items: LinkableItem[] } {
  const bySourceId = new Map<string, LinkableItem>()
  const eventTypeMap = new Map<string, Set<string>>()

  for (const evt of events) {
    if (!eventTypeMap.has(evt.source_id)) eventTypeMap.set(evt.source_id, new Set())
    eventTypeMap.get(evt.source_id)!.add(evt.event_type)

    if (!bySourceId.has(evt.source_id)) {
      const meta = evt.metadata as Record<string, unknown> | null
      bySourceId.set(evt.source_id, {
        source_id: evt.source_id,
        source: evt.source,
        title: evt.title,
        url: evt.url,
        actor: evt.actor,
        last_event_ts: evt.timestamp,
        event_type: evt.event_type,
        summary: evt.summary,
        parent_key: (meta?.parent_key as string) ?? null,
        issue_type: (meta?.issue_type as string) ?? null,
        milestone: (meta?.milestone as string) ?? null,
        milestone_url: (meta?.milestone_url as string) ?? null,
        // Carry forward link metadata from the raw event
        jira_keys: (meta?.jira_keys as string[]) ?? undefined,
        github_pr_urls: (meta?.github_pr_urls as string[]) ?? undefined,
      })
    }
  }

  const allItems = Array.from(bySourceId.values())
  const items = filterDoneItems(allItems, eventTypeMap, new Map()) as LinkableItem[]
  return { items }
}

async function testIntegration() {
  console.log("\nIntegration — resolveLinks with real pal-testing data:")

  const adapter = createGitHubAdapter({
    tier1Repos: [TEST_REPO],
    tier2Repos: [],
    tier3Repos: [],
    botIgnoreList: [],
  })

  const available = await adapter.isAvailable()
  if (!available) {
    console.log("  ⊘ SKIP: gh CLI not authenticated")
    return
  }

  const events = await adapter.poll()
  if (events.length === 0) {
    console.log("  ⊘ SKIP: no events from pal-testing")
    return
  }

  const { items } = buildPipeline(events)
  assert(items.length > 0, `got ${items.length} items from pal-testing pipeline`)

  const result = resolveLinks(items)

  // Total items accounted for (in groups + standalone)
  const groupedItemCount = result.groups.reduce(
    (sum, g) => sum + 1 + g.linkedPRs.length, // primary + PRs
    0,
  )
  const totalAccountedFor = groupedItemCount + result.standalone.length
  assertEq(totalAccountedFor, items.length, "all items accounted for (grouped + standalone)")

  // No item appears in both a group and standalone
  const groupedIds = new Set<string>()
  for (const group of result.groups) {
    groupedIds.add(group.primary.source_id)
    for (const pr of group.linkedPRs) {
      groupedIds.add(pr.source_id)
    }
  }
  const standaloneIds = new Set(result.standalone.map((i) => i.source_id))
  let overlap = false
  for (const id of groupedIds) {
    if (standaloneIds.has(id)) {
      overlap = true
      break
    }
  }
  assert(!overlap, "no item appears in both group and standalone")

  // Every group has at least one linked PR
  const allGroupsHavePRs = result.groups.every((g) => g.linkedPRs.length > 0)
  assert(allGroupsHavePRs, "every group has at least one linked PR")

  // Every group primary is an issue (not a PR)
  const prTypes = new Set(["pr_opened", "pr_merged", "pr_closed", "review_requested", "review_submitted", "pr_commented", "ci_failed"])
  const allPrimariesAreIssues = result.groups.every((g) => !prTypes.has(g.primary.event_type))
  assert(allPrimariesAreIssues, "every group primary is an issue (not a PR)")

  // linkedCount matches actual PR count
  const countsMatch = result.groups.every((g) => g.linkedCount === g.linkedPRs.length)
  assert(countsMatch, "linkedCount matches linkedPRs.length for all groups")

  console.log(`  (${result.groups.length} groups, ${result.standalone.length} standalone from ${items.length} items)`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Link resolver functional tests\n")

  // Pure logic tests (no network)
  testJiraKeysLinking()
  testGitHubPrUrlsLinking()
  testFixesHashLinking()
  testMultiplePRsToOneIssue()
  testStandalonePR()
  testStandaloneIssue()
  testJiraWinsOverGitHub()
  testBidirectionalLinking()
  testMergedPRStillLinked()
  testMixedLinkedAndStandalone()
  testFixesCaseInsensitive()
  testJiraKeyNoMatchingIssue()
  testMultipleJiraKeysFirstMatchWins()
  testEmptyInput()
  testAllStandalone()

  // Integration tests (network)
  await testIntegration()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("Test error:", err)
  process.exit(1)
})
