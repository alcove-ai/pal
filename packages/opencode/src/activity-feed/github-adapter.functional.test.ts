/**
 * Functional tests for the GitHub adapter using alcove-ai/pal-testing as fixture data.
 *
 * Requirements:
 *   - `gh` CLI installed and authenticated (`gh auth login`)
 *   - Network access to github.com
 *   - The alcove-ai/pal-testing repo must exist with these fixtures:
 *     Issues:
 *       #1 [open]   "Open issue with milestone"        milestone=v1.0
 *       #2 [open]   "Open issue without milestone"     milestone=none
 *       #3 [open]   "Second issue in milestone"         milestone=v1.0
 *       #4 [closed] "Closed issue - should not appear"
 *       #5 [open]   "Issue with needs-planning label"   labels=[needs-planning]
 *     PRs:
 *       #6 [open]   "Open PR - should appear in Needs Me"
 *       #7 [closed] "Merged PR - should NOT appear"     merged=true
 *
 * Run: bun run src/activity-feed/github-adapter.functional.test.ts
 * (NOT bun test — Bun's test runner deadlocks on subprocess calls)
 */
import { createGitHubAdapter } from "./github-adapter"
import { buildDisplayRows, filterDoneItems, type ActivityItem } from "@/needs-me/needs-me-logic"

const TEST_REPO = "alcove-ai/pal-testing"

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

async function main() {
  console.log("Functional tests: GitHub adapter + alcove-ai/pal-testing\n")

  const adapter = createGitHubAdapter({
    tier1Repos: [TEST_REPO],
    tier2Repos: [],
    tier3Repos: [],
    botIgnoreList: [],
  })

  const available = await adapter.isAvailable()
  if (!available) {
    console.error("FATAL: gh CLI not authenticated — run 'gh auth login'")
    process.exit(1)
  }

  const events = await adapter.poll()
  assert(events.length > 0, "polls events from test repo")

  // --- Adapter output ---
  console.log("\nAdapter polling:")

  const openIssue = events.find((e) => e.source_id === `${TEST_REPO}#1`)
  assert(!!openIssue, "open issue #1 exists in events")
  assert(openIssue?.event_type === "issue_opened", "open issue #1 has event_type issue_opened")

  const openPR = events.find((e) => e.source_id === `${TEST_REPO}#6` && e.event_type === "pr_opened")
  assert(!!openPR, "open PR #6 exists with event_type pr_opened")

  const closedIssue = events.find((e) => e.source_id === `${TEST_REPO}#4`)
  assert(!!closedIssue, "closed issue #4 exists in events")
  assert(closedIssue?.event_type === "issue_closed", "closed issue #4 has event_type issue_closed")

  const mergedPR = events.find((e) => e.source_id === `${TEST_REPO}#7` && e.event_type === "pr_merged")
  assert(!!mergedPR, "merged PR #7 exists with event_type pr_merged")

  const milestoneIssue = events.find((e) => e.source_id === `${TEST_REPO}#1` && e.event_type === "issue_opened")
  assert(milestoneIssue?.metadata?.milestone === "v1.0", "issue #1 has milestone v1.0 in metadata")

  const noMilestone = events.find((e) => e.source_id === `${TEST_REPO}#2` && e.event_type === "issue_opened")
  assert(noMilestone?.metadata?.milestone === null, "issue #2 has null milestone")

  const labeled = events.find((e) => e.source_id === `${TEST_REPO}#5` && e.event_type === "issue_opened")
  assert(Array.isArray(labeled?.metadata?.labels) && labeled.metadata.labels.includes("needs-planning"), "issue #5 has needs-planning label")

  // --- Filtering ---
  console.log("\nFiltering:")

  const bySourceId = new Map<string, ActivityItem>()
  for (const evt of events) {
    if (!bySourceId.has(evt.source_id)) {
      bySourceId.set(evt.source_id, {
        source_id: evt.source_id,
        source: evt.source,
        title: evt.title,
        url: evt.url,
        actor: evt.actor,
        last_event_ts: evt.timestamp,
        event_type: evt.event_type,
        summary: evt.summary,
        parent_key: (evt.metadata?.parent_key as string) ?? null,
        issue_type: (evt.metadata?.issue_type as string) ?? null,
        milestone: (evt.metadata?.milestone as string) ?? null,
      })
    }
  }

  const eventTypeMap = new Map<string, Set<string>>()
  for (const evt of events) {
    if (!eventTypeMap.has(evt.source_id)) eventTypeMap.set(evt.source_id, new Set())
    eventTypeMap.get(evt.source_id)!.add(evt.event_type)
  }

  const items = filterDoneItems(Array.from(bySourceId.values()), eventTypeMap, new Map())

  assert(!!items.find((i) => i.source_id === `${TEST_REPO}#1`), "open issue #1 passes filter")
  assert(!!items.find((i) => i.source_id === `${TEST_REPO}#2`), "open issue #2 passes filter")
  assert(!items.find((i) => i.source_id === `${TEST_REPO}#4`), "closed issue #4 filtered out")
  assert(!items.find((i) => i.source_id === `${TEST_REPO}#7`), "merged PR #7 filtered out")
  assert(!!items.find((i) => i.source_id === `${TEST_REPO}#6`), "open PR #6 passes filter")

  // --- Grouping ---
  console.log("\nGrouping:")

  const rows = buildDisplayRows(items, new Set())
  const milestoneHeader = rows.find((r) => r.kind === "header" && r.label.includes("v1.0"))
  assert(!!milestoneHeader, "milestone v1.0 header exists")
  assert(milestoneHeader?.kind === "header" && milestoneHeader.count === 2, "milestone header has count=2")

  const indented = rows.filter((r) => r.kind === "item" && r.indented)
  assert(indented.length === 2, "2 items indented under milestone")

  const ungrouped = rows.filter((r) => r.kind === "item" && !r.indented)
  assert(ungrouped.length > 0, "ungrouped items exist")

  // --- Summary ---
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("Test error:", err)
  process.exit(1)
})
