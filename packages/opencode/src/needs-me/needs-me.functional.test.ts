/**
 * End-to-end functional test for the Needs Me tab data pipeline.
 *
 * Tests the FULL flow: poll GitHub → build ActivityItems → filter done → group by milestone → display rows
 * Uses alcove-ai/pal-testing as fixture data.
 *
 * Fixtures (do not change these):
 *   #1 [open]   "Open issue with milestone"        milestone=v1.0
 *   #2 [open]   "Open issue without milestone"     milestone=none
 *   #3 [open]   "Second issue in milestone"         milestone=v1.0
 *   #4 [closed] "Closed issue - should not appear"
 *   #5 [open]   "Issue with needs-planning label"   labels=[needs-planning]
 *   #6 [open]   "Open PR - should appear"
 *   #7 [closed] "Merged PR - should NOT appear"     merged=true
 *
 * Requirements:
 *   - gh CLI authenticated
 *   - Network access to github.com
 *
 * Run: bun run src/needs-me/needs-me.functional.test.ts
 */
import { createGitHubAdapter } from "@/activity-feed/github-adapter"
import {
  buildDisplayRows,
  filterDoneItems,
  DONE_EVENT_TYPES,
  type ActivityItem,
  type DisplayRow,
} from "./needs-me-logic"

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

function buildPipeline(events: any[]): { items: ActivityItem[]; rows: DisplayRow[] } {
  // Step 1: Build ActivityItems (same logic as computeFilteredQueue in needs-me.tsx)
  const bySourceId = new Map<string, ActivityItem>()
  const eventTypeMap = new Map<string, Set<string>>()

  for (const evt of events) {
    if (!eventTypeMap.has(evt.source_id)) eventTypeMap.set(evt.source_id, new Set())
    eventTypeMap.get(evt.source_id)!.add(evt.event_type)

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

  // Step 2: Filter done items
  const allItems = Array.from(bySourceId.values())
  const items = filterDoneItems(allItems, eventTypeMap, new Map())

  // Step 3: Build display rows
  const rows = buildDisplayRows(items, new Set())

  return { items, rows }
}

async function main() {
  console.log("Needs Me end-to-end functional test\n")
  console.log("Fixture repo: alcove-ai/pal-testing\n")

  // Poll the real repo
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
  if (events.length === 0) {
    console.error("FATAL: no events from pal-testing — check fixture repo")
    process.exit(1)
  }

  const { items, rows } = buildPipeline(events)

  // === FILTERING ===
  console.log("Filtering:")

  const itemIds = items.map((i) => i.source_id)
  assert(itemIds.includes(`${TEST_REPO}#1`), "open issue #1 survives filter")
  assert(itemIds.includes(`${TEST_REPO}#2`), "open issue #2 survives filter")
  assert(itemIds.includes(`${TEST_REPO}#3`), "open issue #3 survives filter")
  assert(!itemIds.includes(`${TEST_REPO}#4`), "closed issue #4 is filtered OUT")
  assert(itemIds.includes(`${TEST_REPO}#5`), "open issue #5 survives filter")
  assert(itemIds.includes(`${TEST_REPO}#6`), "open PR #6 survives filter")
  assert(!itemIds.includes(`${TEST_REPO}#7`), "merged PR #7 is filtered OUT")

  // === MILESTONE DATA ===
  console.log("\nMilestone metadata:")

  const item1 = items.find((i) => i.source_id === `${TEST_REPO}#1`)!
  assert(item1.milestone === "v1.0", "#1 has milestone=v1.0")

  const item3 = items.find((i) => i.source_id === `${TEST_REPO}#3`)!
  assert(item3.milestone === "v1.0", "#3 has milestone=v1.0")

  const item2 = items.find((i) => i.source_id === `${TEST_REPO}#2`)!
  assert(item2.milestone === null, "#2 has milestone=null")

  const item5 = items.find((i) => i.source_id === `${TEST_REPO}#5`)!
  assert(item5.milestone === null, "#5 has milestone=null")

  // === GROUPING ===
  console.log("\nGrouping (display rows):")

  const headers = rows.filter((r) => r.kind === "header")
  const itemRows = rows.filter((r) => r.kind === "item") as Array<{ kind: "item"; item: ActivityItem; indented: boolean }>

  assert(headers.length >= 1, "at least 1 group header exists")

  const milestoneHeader = headers.find((h) => h.kind === "header" && h.label.includes("v1.0"))
  assert(!!milestoneHeader, "milestone v1.0 header exists")
  assert(milestoneHeader?.kind === "header" && milestoneHeader.count === 2, "milestone header shows count=2")

  // Check indented items are the milestone items
  const indented = itemRows.filter((r) => r.indented)
  assert(indented.length === 2, "exactly 2 items indented under milestone")

  const indentedIds = indented.map((r) => r.item.source_id)
  assert(indentedIds.includes(`${TEST_REPO}#1`), "#1 is indented under milestone")
  assert(indentedIds.includes(`${TEST_REPO}#3`), "#3 is indented under milestone")

  // Check ungrouped items
  const ungrouped = itemRows.filter((r) => !r.indented)
  assert(ungrouped.length >= 3, "at least 3 ungrouped items (#2, #5, #6)")

  const ungroupedIds = ungrouped.map((r) => r.item.source_id)
  assert(ungroupedIds.includes(`${TEST_REPO}#2`), "#2 is ungrouped")
  assert(ungroupedIds.includes(`${TEST_REPO}#5`), "#5 is ungrouped")
  assert(ungroupedIds.includes(`${TEST_REPO}#6`), "#6 is ungrouped")

  // Closed/merged items should NOT be in any display row
  const allDisplayIds = itemRows.map((r) => r.item.source_id)
  assert(!allDisplayIds.includes(`${TEST_REPO}#4`), "closed #4 NOT in display rows")
  assert(!allDisplayIds.includes(`${TEST_REPO}#7`), "merged #7 NOT in display rows")

  // === COLLAPSE ===
  console.log("\nCollapse behavior:")

  const collapsedRows = buildDisplayRows(items, new Set(["v1.0"]))
  const collapsedHeader = collapsedRows.find((r) => r.kind === "header" && r.label.includes("v1.0"))
  assert(collapsedHeader?.kind === "header" && collapsedHeader.collapsed === true, "v1.0 header shows collapsed=true")

  const collapsedItems = collapsedRows.filter((r) => r.kind === "item" && r.indented)
  assert(collapsedItems.length === 0, "collapsed group has 0 visible items")

  const collapsedUngrouped = collapsedRows.filter((r) => r.kind === "item" && !r.indented)
  assert(collapsedUngrouped.length >= 3, "ungrouped items still visible when group collapsed")

  // === ROW ORDER ===
  console.log("\nRow order:")

  // Headers should come before ungrouped items
  const firstHeaderIdx = rows.findIndex((r) => r.kind === "header")
  const firstUngroupedIdx = rows.findIndex((r) => r.kind === "item" && !r.indented)
  if (firstHeaderIdx >= 0 && firstUngroupedIdx >= 0) {
    assert(firstHeaderIdx < firstUngroupedIdx, "group headers appear before ungrouped items")
  } else {
    assert(true, "group headers appear before ungrouped items (trivially)")
  }

  // === SUMMARY ===
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("Test error:", err)
  process.exit(1)
})
