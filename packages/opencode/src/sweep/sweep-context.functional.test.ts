/**
 * Functional tests for sweep prompt engineering — verifies the RIGHT context
 * is assembled from all sources before being sent to the LLM.
 *
 * Requirements:
 *   - Run from ~/devel/alcove so it picks up the real role.md and CONTRIBUTING.md
 *   - Does NOT call the Vertex API — only tests context assembly
 *
 * Run: cd ~/devel/alcove && bun run /home/bmbouter/devel/pal/packages/opencode/src/sweep/sweep-context.functional.test.ts
 */
import { load as loadProcessDoc, reload as reloadProcessDoc } from "@/process/process-doc"
import { get as getRole, clear as clearRole } from "@/config/role"
import { buildIssueContext, buildSystemPrompt, type IssueSnapshot } from "./sweep"

let passed = 0
let failed = 0

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++
    console.log(`  OK ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}`)
  }
}

function makeMockIssue(overrides?: Partial<IssueSnapshot>): IssueSnapshot {
  return {
    source_id: "TEST-123",
    source: "jira",
    title: "Implement widget API for dashboard",
    url: "https://issues.example.com/TEST-123",
    actor: "alice",
    last_event_ts: Date.now(),
    feed: "tier1",
    mode: "needs-me",
    events: [
      {
        event_type: "issue_updated",
        summary: "Status changed to In Progress",
        actor: "bob",
        timestamp: Date.now() - 3600_000,
        metadata: {
          status: "In Progress",
          priority: "High",
          assignee: "alice",
          description: "Build the widget API endpoint",
          issue_type: "Story",
          labels: ["backend", "api"],
        },
      },
      {
        event_type: "comment_added",
        summary: "Let's target this for next sprint",
        actor: "carol",
        timestamp: Date.now() - 1800_000,
        metadata: null,
      },
    ],
    ...overrides,
  }
}

async function main() {
  // Guard: must be run from alcove directory
  const cwd = process.cwd()
  if (!cwd.endsWith("/alcove")) {
    console.error(
      "FATAL: This test must be run from ~/devel/alcove to pick up role.md and CONTRIBUTING.md.\n" +
      "Run: cd ~/devel/alcove && bun run /home/bmbouter/devel/pal/packages/opencode/src/sweep/sweep-context.functional.test.ts"
    )
    process.exit(1)
  }

  console.log("Functional tests: sweep context assembly\n")

  // Clear caches so we get fresh reads from the alcove directory
  clearRole()
  reloadProcessDoc()

  // -------------------------------------------------------
  // 1. Role loads
  // -------------------------------------------------------
  console.log("Role loading:")

  const role = getRole()
  assert(role !== null, "getRole() returns non-null")
  assert(typeof role === "string" && role.length > 0, "role is a non-empty string")
  assert(
    typeof role === "string" && role.toLowerCase().includes("product owner"),
    "role contains 'Product Owner'"
  )

  // -------------------------------------------------------
  // 2-3. Process doc loads
  // -------------------------------------------------------
  console.log("\nProcess doc loading:")

  const processDoc = loadProcessDoc()
  assert(processDoc !== null, "loadProcessDoc() returns non-null")
  assert(typeof processDoc === "string" && processDoc.length > 0, "process doc is a non-empty string")
  assert(
    typeof processDoc === "string" && processDoc.includes("Problem statement"),
    "process doc contains 'Problem statement'"
  )
  assert(
    typeof processDoc === "string" && processDoc.includes("Specification"),
    "process doc contains 'Specification'"
  )

  // -------------------------------------------------------
  // 4. buildIssueContext produces correct output
  // -------------------------------------------------------
  console.log("\nbuildIssueContext:")

  const issue = makeMockIssue()
  const contextNoMemory = buildIssueContext(issue)
  assert(contextNoMemory.includes("Title:"), "contains 'Title:'")
  assert(contextNoMemory.includes("Source:"), "contains 'Source:'")
  assert(contextNoMemory.includes("Recent events:"), "contains 'Recent events:'")
  assert(contextNoMemory.includes("TEST-123"), "contains issue source_id")
  assert(contextNoMemory.includes("Implement widget API"), "contains issue title")
  assert(contextNoMemory.includes("issue_updated"), "contains event type")
  assert(contextNoMemory.includes("Status: In Progress"), "contains metadata status")
  assert(contextNoMemory.includes("Priority: High"), "contains metadata priority")
  assert(contextNoMemory.includes("Labels: backend, api"), "contains metadata labels")
  assert(!contextNoMemory.includes("RELATED CONTEXT FROM MEMORY"), "without memory, no memory section")

  const contextWithMemory = buildIssueContext(issue, "Previous sprint retrospective noted API delays")
  assert(
    contextWithMemory.includes("RELATED CONTEXT FROM MEMORY"),
    "with memory, contains 'RELATED CONTEXT FROM MEMORY'"
  )
  assert(
    contextWithMemory.includes("Previous sprint retrospective"),
    "with memory, contains the memory text"
  )

  // Empty/whitespace memory should not produce memory section
  const contextEmptyMemory = buildIssueContext(issue, "   ")
  assert(
    !contextEmptyMemory.includes("RELATED CONTEXT FROM MEMORY"),
    "whitespace-only memory omits memory section"
  )

  // -------------------------------------------------------
  // 5-6. System prompt includes process doc and role
  // -------------------------------------------------------
  console.log("\nbuildSystemPrompt:")

  assert(role !== null && processDoc !== null, "precondition: role and processDoc loaded")

  const system = buildSystemPrompt(processDoc!, role!)
  assert(system.includes("TEAM PROCESS"), "system prompt contains 'TEAM PROCESS'")
  assert(system.includes(processDoc!.slice(0, 100)), "system prompt contains process doc content")
  assert(system.includes("USER'S ROLE"), "system prompt contains 'USER\\'S ROLE'")
  assert(system.includes(role!), "system prompt contains role content")
  assert(
    system.includes("process facilitator"),
    "system prompt contains facilitator instructions"
  )
  assert(
    system.includes("JSON object"),
    "system prompt contains JSON response format instruction"
  )

  // -------------------------------------------------------
  // 7. Full sweep prompt assembly
  // -------------------------------------------------------
  console.log("\nFull prompt assembly:")

  const fullSystem = buildSystemPrompt(processDoc!, role!)
  const fullUser = buildIssueContext(issue, "Memory: widget API was discussed in planning")

  // Verify system prompt
  assert(fullSystem.includes("Problem statement"), "full system contains process doc text")
  assert(fullSystem.toLowerCase().includes("product owner"), "full system contains role text")
  assert(
    fullSystem.includes('"summary"') && fullSystem.includes('"action"') && fullSystem.includes('"priority"'),
    "full system contains JSON response format fields"
  )

  // Verify user message
  assert(fullUser.includes("Implement widget API"), "full user message contains issue title")
  assert(fullUser.includes("issue_updated"), "full user message contains event details")
  assert(fullUser.includes("RELATED CONTEXT FROM MEMORY"), "full user message contains memory context")

  // Verify no overlap / correct separation
  assert(!fullSystem.includes("Title:"), "system prompt does not contain issue details")
  assert(!fullUser.includes("TEAM PROCESS"), "user message does not contain system prompt content")

  // -------------------------------------------------------
  // Summary
  // -------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("Test error:", err)
  process.exit(1)
})
