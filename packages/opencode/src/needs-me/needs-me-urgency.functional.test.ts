/**
 * Functional tests for urgency scoring, sort modes, color coding, and text truncation.
 *
 * Tests two categories:
 * 1. Pure logic: extractAnalysis parsing, urgency tiers, badges, sort, truncation
 * 2. Integration: sort modes applied to real pal-testing fixture data
 *
 * Requirements:
 *   - gh CLI authenticated (for integration tests)
 *   - Network access to github.com
 *
 * Run: bun run src/needs-me/needs-me-urgency.functional.test.ts
 */
import { createGitHubAdapter } from "@/activity-feed/github-adapter"
import { extractAnalysis } from "@/agent-pool/pool"
import {
  buildDisplayRows,
  filterDoneItems,
  urgencyTier,
  urgencyBadge,
  sortByPriority,
  truncateText,
  type ActivityItem,
  type DisplayRow,
  type UrgencyTier,
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
// extractAnalysis tests
// ---------------------------------------------------------------------------

function testExtractAnalysis() {
  console.log("extractAnalysis — STATE/ACTION/URGENCY parsing:")

  // Standard well-formed response
  {
    const text = `I've analyzed this issue.

STATE: Problem statement approved, no spec written yet
ACTION: Write the spec with scope and acceptance criteria
URGENCY: 8`
    const result = extractAnalysis(text)
    assertEq(result.summary, "Problem statement approved, no spec written yet", "parses STATE line")
    assertEq(result.recommendedAction, "Write the spec with scope and acceptance criteria", "parses ACTION line")
    assertEq(result.urgency, 8, "parses URGENCY as integer")
  }

  // Low urgency
  {
    const text = `STATE: Issue is tracked, no action needed
ACTION: Monitor for updates
URGENCY: 2`
    const result = extractAnalysis(text)
    assertEq(result.urgency, 2, "parses low urgency (2)")
  }

  // Max urgency
  {
    const text = `STATE: Production is down
ACTION: Immediately investigate and fix
URGENCY: 10`
    const result = extractAnalysis(text)
    assertEq(result.urgency, 10, "parses max urgency (10)")
  }

  // Urgency clamped above 10
  {
    const text = `STATE: Critical
ACTION: Fix now
URGENCY: 15`
    const result = extractAnalysis(text)
    assertEq(result.urgency, 10, "clamps urgency above 10 to 10")
  }

  // Urgency clamped below 1
  {
    const text = `STATE: Nothing
ACTION: None
URGENCY: 0`
    const result = extractAnalysis(text)
    assertEq(result.urgency, 1, "clamps urgency below 1 to 1")
  }

  // Negative urgency
  {
    const text = `STATE: Nothing
ACTION: None
URGENCY: -5`
    const result = extractAnalysis(text)
    assertEq(result.urgency, 1, "clamps negative urgency to 1")
  }

  // Missing URGENCY line defaults to 5
  {
    const text = `STATE: Issue is being discussed
ACTION: Wait for team decision`
    const result = extractAnalysis(text)
    assertEq(result.urgency, 5, "defaults to urgency 5 when line is missing")
  }

  // STATE only (no ACTION or URGENCY)
  {
    const text = `STATE: Awaiting review`
    const result = extractAnalysis(text)
    assertEq(result.summary, "Awaiting review", "handles STATE-only response")
    assertEq(result.recommendedAction, null, "no action when ACTION line missing")
    assertEq(result.urgency, 5, "defaults urgency when URGENCY line missing")
  }

  // Lines with extra whitespace
  {
    const text = `  STATE:   Has extra spaces
  ACTION:   Also padded
  URGENCY:   7  `
    const result = extractAnalysis(text)
    assertEq(result.summary, "Has extra spaces", "trims STATE whitespace")
    assertEq(result.recommendedAction, "Also padded", "trims ACTION whitespace")
    assertEq(result.urgency, 7, "parses URGENCY with whitespace")
  }

  // Case-insensitive line matching
  {
    const text = `state: lowercase state
action: lowercase action
urgency: 6`
    const result = extractAnalysis(text)
    assertEq(result.summary, "lowercase state", "case-insensitive STATE")
    assertEq(result.recommendedAction, "lowercase action", "case-insensitive ACTION")
    assertEq(result.urgency, 6, "case-insensitive URGENCY")
  }

  // Mixed case
  {
    const text = `State: Mixed Case
Action: Mixed Case Action
Urgency: 4`
    const result = extractAnalysis(text)
    assertEq(result.summary, "Mixed Case", "mixed-case STATE")
    assertEq(result.urgency, 4, "mixed-case URGENCY")
  }

  // Non-numeric urgency falls back to default
  {
    const text = `STATE: Some state
ACTION: Some action
URGENCY: high`
    const result = extractAnalysis(text)
    assertEq(result.urgency, 5, "non-numeric urgency defaults to 5")
  }

  // Multi-message scenario: STATE/ACTION/URGENCY in middle of long text
  {
    const text = `I've reviewed the issue details and here's my analysis.

The issue is about creating an onboarding agent. The problem statement has been approved.
I checked the team process and this follows the standard workflow.

Let me look at the milestone and priorities...

Based on my analysis:

STATE: Problem statement approved, spec needed
ACTION: Draft the specification document
URGENCY: 7

I would recommend starting with the scope definition.`
    const result = extractAnalysis(text)
    assertEq(result.summary, "Problem statement approved, spec needed", "finds STATE in long text")
    assertEq(result.recommendedAction, "Draft the specification document", "finds ACTION in long text")
    assertEq(result.urgency, 7, "finds URGENCY in long text")
  }

  // Old SUMMARY: format (backward compatibility)
  {
    const text = `SUMMARY: This is an old-format summary`
    const result = extractAnalysis(text)
    assertEq(result.summary, "This is an old-format summary", "handles legacy SUMMARY: format")
    assertEq(result.recommendedAction, null, "no action in SUMMARY format")
  }

  // Empty text
  {
    const result = extractAnalysis("")
    assert(result.summary.length >= 0, "handles empty text without crash")
    assertEq(result.urgency, 5, "empty text defaults urgency to 5")
  }

  // No recognized format — last non-empty line fallback
  {
    const text = `This is just free text.
It has multiple lines.
**The last important line.**`
    const result = extractAnalysis(text)
    assertEq(result.summary, "The last important line.", "uses last non-empty line as fallback")
    assert(!result.summary.includes("**"), "strips bold markers from fallback")
  }
}

// ---------------------------------------------------------------------------
// urgencyTier tests
// ---------------------------------------------------------------------------

function testUrgencyTier() {
  console.log("\nurgencyTier — maps urgency score to color tier:")

  assertEq(urgencyTier(10), "critical", "urgency 10 → critical")
  assertEq(urgencyTier(9), "critical", "urgency 9 → critical")
  assertEq(urgencyTier(8), "critical", "urgency 8 → critical (boundary)")
  assertEq(urgencyTier(7), "warning", "urgency 7 → warning")
  assertEq(urgencyTier(6), "warning", "urgency 6 → warning")
  assertEq(urgencyTier(5), "warning", "urgency 5 → warning (boundary)")
  assertEq(urgencyTier(4), "normal", "urgency 4 → normal")
  assertEq(urgencyTier(3), "normal", "urgency 3 → normal (boundary)")
  assertEq(urgencyTier(2), "low", "urgency 2 → low")
  assertEq(urgencyTier(1), "low", "urgency 1 → low")
}

// ---------------------------------------------------------------------------
// urgencyBadge tests
// ---------------------------------------------------------------------------

function testUrgencyBadge() {
  console.log("\nurgencyBadge — compact display format:")

  assertEq(urgencyBadge(10), "10!", "urgency 10 shows exclamation")
  assertEq(urgencyBadge(9), "9!", "urgency 9 shows exclamation")
  assertEq(urgencyBadge(8), "8!", "urgency 8 shows exclamation (boundary)")
  assertEq(urgencyBadge(7), "7·", "urgency 7 shows dot")
  assertEq(urgencyBadge(5), "5·", "urgency 5 shows dot")
  assertEq(urgencyBadge(3), "3·", "urgency 3 shows dot")
  assertEq(urgencyBadge(1), "1·", "urgency 1 shows dot")
}

// ---------------------------------------------------------------------------
// truncateText tests
// ---------------------------------------------------------------------------

function testTruncateText() {
  console.log("\ntruncateText — fits text to terminal width:")

  assertEq(truncateText("short", 80), "short", "short text unchanged")
  assertEq(truncateText("hello world", 5), "hell…", "truncated with ellipsis")
  assertEq(truncateText("exactly10!", 10), "exactly10!", "exact fit unchanged")
  assertEq(truncateText("exactly10!X", 10), "exactly10…", "one char over gets truncated")
  assertEq(truncateText("ab", 2), "ab", "2 chars fits in width 2")
  assertEq(truncateText("abc", 2), "ab", "3 chars in tiny width (< 4 fallback)")

  const longTitle = "This is a very long issue title that should be truncated to fit within the terminal width"
  const truncated = truncateText(longTitle, 40)
  assert(truncated.length <= 40, `truncated to 40 chars (got ${truncated.length})`)
  assert(truncated.endsWith("…"), "truncated text ends with ellipsis")
}

// ---------------------------------------------------------------------------
// sortByPriority tests
// ---------------------------------------------------------------------------

function testSortByPriority() {
  console.log("\nsortByPriority — flat urgency-descending sort:")

  const items: ActivityItem[] = [
    makeItem("a", "Low priority issue", 1000),
    makeItem("b", "Medium priority issue", 2000),
    makeItem("c", "High priority issue", 3000),
    makeItem("d", "Critical issue", 500),
  ]

  const urgencies: Record<string, number> = {
    a: 3,
    b: 5,
    c: 9,
    d: 2,
  }

  const sorted = sortByPriority(items, (id) => urgencies[id] ?? 5)
  assertEq(sorted[0].source_id, "c", "highest urgency (9) first")
  assertEq(sorted[1].source_id, "b", "medium urgency (5) second")
  assertEq(sorted[2].source_id, "a", "low urgency (3) third")
  assertEq(sorted[3].source_id, "d", "lowest urgency (2) last")

  // Original array unchanged
  assertEq(items[0].source_id, "a", "original array not mutated")
}

function testSortByPriorityDefaultUrgency() {
  console.log("\nsortByPriority — unknown urgency defaults to 5:")

  const items: ActivityItem[] = [
    makeItem("known-high", "Known", 1000),
    makeItem("unknown", "Unknown", 2000),
    makeItem("known-low", "Known Low", 3000),
  ]

  const urgencies: Record<string, number> = {
    "known-high": 8,
    "known-low": 2,
  }

  const sorted = sortByPriority(items, (id) => urgencies[id] ?? 5)
  assertEq(sorted[0].source_id, "known-high", "known high (8) first")
  assertEq(sorted[1].source_id, "unknown", "unknown (default 5) second")
  assertEq(sorted[2].source_id, "known-low", "known low (2) last")
}

function testSortByPriorityEqualUrgency() {
  console.log("\nsortByPriority — equal urgency preserves relative order:")

  const items: ActivityItem[] = [
    makeItem("first", "First", 1000),
    makeItem("second", "Second", 2000),
    makeItem("third", "Third", 3000),
  ]

  const sorted = sortByPriority(items, () => 5)
  assertEq(sorted[0].source_id, "first", "equal urgency preserves order (first)")
  assertEq(sorted[1].source_id, "second", "equal urgency preserves order (second)")
  assertEq(sorted[2].source_id, "third", "equal urgency preserves order (third)")
}

// ---------------------------------------------------------------------------
// Sort mode: priority vs hierarchy
// ---------------------------------------------------------------------------

function testSortModes() {
  console.log("\nSort modes — priority (flat) vs hierarchy (grouped):")

  // Create items with milestones and varying urgencies
  const items: ActivityItem[] = [
    makeItem("repo#1", "Issue in v1.0 milestone", 3000, { milestone: "v1.0" }),
    makeItem("repo#2", "Ungrouped issue", 2000),
    makeItem("repo#3", "Another v1.0 issue", 1000, { milestone: "v1.0" }),
    makeItem("repo#4", "Urgent ungrouped", 4000),
  ]

  const urgencies: Record<string, number> = {
    "repo#1": 3,
    "repo#2": 7,
    "repo#3": 9,
    "repo#4": 2,
  }

  // Priority mode: flat, sorted by urgency descending
  const prioritySorted = sortByPriority(items, (id) => urgencies[id] ?? 5)
  const priorityRows: DisplayRow[] = prioritySorted.map((item) => ({
    kind: "item" as const,
    item,
    indented: false,
  }))

  assertEq(priorityRows.length, 4, "priority mode: all items in flat list")
  assert(priorityRows.every((r) => r.kind === "item" && !r.indented), "priority mode: no indentation")
  const pItems = priorityRows.filter((r): r is Extract<DisplayRow, { kind: "item" }> => r.kind === "item")
  assertEq(pItems[0]!.item.source_id, "repo#3", "priority mode: highest urgency (9) first")
  assertEq(pItems[1]!.item.source_id, "repo#2", "priority mode: urgency 7 second")
  assertEq(pItems[2]!.item.source_id, "repo#1", "priority mode: urgency 3 third")
  assertEq(pItems[3]!.item.source_id, "repo#4", "priority mode: urgency 2 last")

  // No headers in priority mode
  const priorityHeaders = priorityRows.filter((r) => r.kind === "header")
  assertEq(priorityHeaders.length, 0, "priority mode: no headers")

  // Hierarchy mode: grouped by milestone
  const hierarchyRows = buildDisplayRows(items, new Set())
  const hierarchyHeaders = hierarchyRows.filter((r) => r.kind === "header")
  assert(hierarchyHeaders.length >= 1, "hierarchy mode: has group headers")

  const milestoneHeader = hierarchyHeaders.find(
    (r) => r.kind === "header" && r.label.includes("v1.0"),
  )
  assert(!!milestoneHeader, "hierarchy mode: v1.0 milestone header exists")

  const indentedItems = hierarchyRows.filter(
    (r) => r.kind === "item" && r.indented,
  )
  assertEq(indentedItems.length, 2, "hierarchy mode: 2 items under milestone")

  const ungroupedItems = hierarchyRows.filter(
    (r) => r.kind === "item" && !r.indented,
  )
  assertEq(ungroupedItems.length, 2, "hierarchy mode: 2 ungrouped items")
}

// ---------------------------------------------------------------------------
// Integration with pal-testing fixture data
// ---------------------------------------------------------------------------

function buildPipeline(events: any[]): { items: ActivityItem[]; rows: DisplayRow[] } {
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
        milestone_url: (evt.metadata?.milestone_url as string) ?? null,
      })
    }
  }

  const allItems = Array.from(bySourceId.values())
  const items = filterDoneItems(allItems, eventTypeMap, new Map())
  const rows = buildDisplayRows(items, new Set())
  return { items, rows }
}

async function testIntegration() {
  console.log("\nIntegration — sort modes with real pal-testing data:")

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

  // Priority sort with simulated urgencies
  const urgencies = new Map<string, number>()
  items.forEach((item, i) => {
    urgencies.set(item.source_id, ((i * 3 + 7) % 10) + 1)
  })

  const prioritySorted = sortByPriority(items, (id) => urgencies.get(id) ?? 5)
  assert(prioritySorted.length === items.length, "priority sort preserves all items")

  // Verify sorted order
  let prevUrgency = 11
  let isDescending = true
  for (const item of prioritySorted) {
    const u = urgencies.get(item.source_id) ?? 5
    if (u > prevUrgency) {
      isDescending = false
      break
    }
    prevUrgency = u
  }
  assert(isDescending, "priority sort is descending by urgency")

  // Priority mode produces flat rows (no headers)
  const priorityRows: DisplayRow[] = prioritySorted.map((item) => ({
    kind: "item" as const,
    item,
    indented: false,
  }))
  assert(
    priorityRows.every((r) => r.kind === "item"),
    "priority mode has only item rows (no headers)",
  )

  // Hierarchy mode produces grouped rows
  const hierarchyRows = buildDisplayRows(items, new Set())
  const hasHeaders = hierarchyRows.some((r) => r.kind === "header")
  const hasIndented = hierarchyRows.some((r) => r.kind === "item" && r.indented)

  // If there are milestoned items, there should be headers and indented items
  const hasMilestoned = items.some((i) => i.milestone !== null)
  if (hasMilestoned) {
    assert(hasHeaders, "hierarchy mode: has headers when milestoned items exist")
    assert(hasIndented, "hierarchy mode: has indented items under milestone headers")
  }

  // Both modes should have the same total item count
  const hierarchyItemCount = hierarchyRows.filter(
    (r) => r.kind === "item",
  ).length
  assertEq(hierarchyItemCount, items.length, "hierarchy mode: same total items as priority mode")

  // Urgency tier mapping for all scores used
  for (const [sourceId, urgency] of urgencies) {
    const tier = urgencyTier(urgency)
    assert(
      ["critical", "warning", "normal", "low"].includes(tier),
      `urgency ${urgency} maps to valid tier: ${tier}`,
    )
  }

  // Urgency badges for all scores used
  for (const [sourceId, urgency] of urgencies) {
    const badge = urgencyBadge(urgency)
    assert(badge.length >= 2, `urgency ${urgency} badge is non-empty: "${badge}"`)
    if (urgency >= 8) {
      assert(badge.endsWith("!"), `urgency ${urgency} badge has exclamation`)
    } else {
      assert(badge.endsWith("·"), `urgency ${urgency} badge has dot`)
    }
  }

  // Text truncation with real titles
  for (const item of items.slice(0, 5)) {
    const truncated = truncateText(item.title, 40)
    assert(truncated.length <= 40, `title truncated to ≤40: "${truncated}"`)
    if (item.title.length > 40) {
      assert(truncated.endsWith("…"), `long title "${item.title.slice(0, 20)}..." truncated with ellipsis`)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(
  sourceId: string,
  title: string,
  ts: number,
  extra: Partial<ActivityItem> = {},
): ActivityItem {
  return {
    source_id: sourceId,
    source: "github",
    title,
    url: `https://github.com/test/${sourceId}`,
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Needs Me urgency/sort/color functional tests\n")

  // Pure logic tests (no network)
  testExtractAnalysis()
  testUrgencyTier()
  testUrgencyBadge()
  testTruncateText()
  testSortByPriority()
  testSortByPriorityDefaultUrgency()
  testSortByPriorityEqualUrgency()
  testSortModes()

  // Integration tests (network)
  await testIntegration()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("Test error:", err)
  process.exit(1)
})
