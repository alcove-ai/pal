import { test, expect, describe } from "bun:test"
import { resolveLinks, applyLinkResolution } from "./link-resolver"
import type { ActivityItem } from "./needs-me-logic"

function makeItem(overrides: Partial<ActivityItem> & { source_id: string; source: string; event_type: string }): ActivityItem {
  return {
    title: overrides.source_id,
    url: null,
    actor: null,
    last_event_ts: Date.now(),
    summary: null,
    parent_key: null,
    issue_type: null,
    milestone: null,
    milestone_url: null,
    ...overrides,
  }
}

describe("resolveLinks", () => {
  test("should return empty results for empty input", () => {
    const result = resolveLinks([])
    expect(result.groups).toEqual([])
    expect(result.standalone).toEqual([])
  })

  test("should keep standalone items when no links exist", () => {
    const items = [
      makeItem({ source_id: "PROJ-1", source: "jira", event_type: "issue_created" }),
      makeItem({ source_id: "owner/repo#10", source: "github", event_type: "issue_opened" }),
    ]
    const result = resolveLinks(items)
    expect(result.groups).toEqual([])
    expect(result.standalone.length).toBe(2)
  })

  test("Rule 1: link GitHub PR to Jira issue via metadata.jira_keys", () => {
    const jiraIssue = makeItem({ source_id: "PROJ-123", source: "jira", event_type: "issue_created" })
    const githubPr = makeItem({
      source_id: "owner/repo#42",
      source: "github",
      event_type: "pr_opened",
      title: "PROJ-123: Fix bug",
      metadata: { jira_keys: ["PROJ-123"] },
    })
    const result = resolveLinks([jiraIssue, githubPr])
    expect(result.groups.length).toBe(1)
    expect(result.groups[0].primary.source_id).toBe("PROJ-123")
    expect(result.groups[0].linked.length).toBe(1)
    expect(result.groups[0].linked[0].source_id).toBe("owner/repo#42")
    // PR should not be in standalone
    expect(result.standalone.find((i) => i.source_id === "owner/repo#42")).toBeUndefined()
    // Issue should still be in standalone (for display)
    expect(result.standalone.find((i) => i.source_id === "PROJ-123")).toBeDefined()
  })

  test("Rule 2: link GitHub PR to Jira issue via metadata.github_pr_urls", () => {
    const jiraIssue = makeItem({
      source_id: "PROJ-456",
      source: "jira",
      event_type: "issue_created",
      metadata: { github_pr_urls: ["https://github.com/owner/repo/pull/99"] },
    })
    const githubPr = makeItem({
      source_id: "owner/repo#99",
      source: "github",
      event_type: "pr_opened",
      title: "Some PR",
    })
    const result = resolveLinks([jiraIssue, githubPr])
    expect(result.groups.length).toBe(1)
    expect(result.groups[0].primary.source_id).toBe("PROJ-456")
    expect(result.groups[0].linked[0].source_id).toBe("owner/repo#99")
  })

  test("Rule 3: link GitHub PR to GitHub issue via Fixes #N in title", () => {
    const ghIssue = makeItem({
      source_id: "owner/repo#10",
      source: "github",
      event_type: "issue_opened",
      title: "owner/repo#10: Bug report",
    })
    const ghPr = makeItem({
      source_id: "owner/repo#20",
      source: "github",
      event_type: "pr_opened",
      title: "owner/repo#20: Fixes #10",
    })
    const result = resolveLinks([ghIssue, ghPr])
    expect(result.groups.length).toBe(1)
    expect(result.groups[0].primary.source_id).toBe("owner/repo#10")
    expect(result.groups[0].linked[0].source_id).toBe("owner/repo#20")
  })

  test("Rule 3: link GitHub PR to GitHub issue via Closes #N in title", () => {
    const ghIssue = makeItem({
      source_id: "owner/repo#5",
      source: "github",
      event_type: "issue_opened",
    })
    const ghPr = makeItem({
      source_id: "owner/repo#15",
      source: "github",
      event_type: "pr_opened",
      title: "owner/repo#15: Closes #5",
    })
    const result = resolveLinks([ghIssue, ghPr])
    expect(result.groups.length).toBe(1)
    expect(result.groups[0].primary.source_id).toBe("owner/repo#5")
  })

  test("Rule 3: link GitHub PR to GitHub issue via Related to #N in title", () => {
    const ghIssue = makeItem({
      source_id: "owner/repo#7",
      source: "github",
      event_type: "issue_opened",
    })
    const ghPr = makeItem({
      source_id: "owner/repo#17",
      source: "github",
      event_type: "pr_opened",
      title: "owner/repo#17: Related to #7",
    })
    const result = resolveLinks([ghIssue, ghPr])
    expect(result.groups.length).toBe(1)
    expect(result.groups[0].primary.source_id).toBe("owner/repo#7")
  })

  test("Rule 4: Jira issue wins over GitHub issue when both link to same PR", () => {
    const jiraIssue = makeItem({ source_id: "PROJ-100", source: "jira", event_type: "issue_created" })
    const ghIssue = makeItem({
      source_id: "owner/repo#50",
      source: "github",
      event_type: "issue_opened",
    })
    const ghPr = makeItem({
      source_id: "owner/repo#60",
      source: "github",
      event_type: "pr_opened",
      title: "owner/repo#60: Fixes #50",
      metadata: { jira_keys: ["PROJ-100"] },
    })
    const result = resolveLinks([jiraIssue, ghIssue, ghPr])
    expect(result.groups.length).toBe(1)
    expect(result.groups[0].primary.source_id).toBe("PROJ-100")
    expect(result.groups[0].linked[0].source_id).toBe("owner/repo#60")
  })

  test("Rule 5: standalone PR with no linked issue stays standalone", () => {
    const pr = makeItem({
      source_id: "owner/repo#99",
      source: "github",
      event_type: "pr_opened",
      title: "Refactoring cleanup",
    })
    const result = resolveLinks([pr])
    expect(result.groups.length).toBe(0)
    expect(result.standalone.length).toBe(1)
    expect(result.standalone[0].source_id).toBe("owner/repo#99")
  })

  test("multiple PRs linked to same Jira issue", () => {
    const jiraIssue = makeItem({ source_id: "PROJ-200", source: "jira", event_type: "issue_created" })
    const pr1 = makeItem({
      source_id: "owner/repo#30",
      source: "github",
      event_type: "pr_opened",
      metadata: { jira_keys: ["PROJ-200"] },
    })
    const pr2 = makeItem({
      source_id: "owner/repo#31",
      source: "github",
      event_type: "pr_opened",
      metadata: { jira_keys: ["PROJ-200"] },
    })
    const result = resolveLinks([jiraIssue, pr1, pr2])
    expect(result.groups.length).toBe(1)
    expect(result.groups[0].primary.source_id).toBe("PROJ-200")
    expect(result.groups[0].linked.length).toBe(2)
    // Both PRs should be removed from standalone
    const standaloneIds = result.standalone.map((i) => i.source_id)
    expect(standaloneIds).not.toContain("owner/repo#30")
    expect(standaloneIds).not.toContain("owner/repo#31")
  })

  test("PR with jira_keys but no matching Jira issue stays standalone", () => {
    const pr = makeItem({
      source_id: "owner/repo#50",
      source: "github",
      event_type: "pr_opened",
      metadata: { jira_keys: ["NONEXIST-999"] },
    })
    const result = resolveLinks([pr])
    expect(result.groups.length).toBe(0)
    expect(result.standalone.length).toBe(1)
  })

  test("Jira issue with github_pr_urls but no matching PR stays standalone", () => {
    const issue = makeItem({
      source_id: "PROJ-300",
      source: "jira",
      event_type: "issue_created",
      metadata: { github_pr_urls: ["https://github.com/owner/repo/pull/9999"] },
    })
    const result = resolveLinks([issue])
    expect(result.groups.length).toBe(0)
    expect(result.standalone.length).toBe(1)
  })

  test("review_requested events are treated as PRs", () => {
    const jiraIssue = makeItem({ source_id: "PROJ-400", source: "jira", event_type: "issue_created" })
    const reviewReq = makeItem({
      source_id: "owner/repo#70",
      source: "github",
      event_type: "review_requested",
      metadata: { jira_keys: ["PROJ-400"] },
    })
    const result = resolveLinks([jiraIssue, reviewReq])
    expect(result.groups.length).toBe(1)
    expect(result.groups[0].linked[0].source_id).toBe("owner/repo#70")
  })

  test("ci_failed events are treated as PRs and can be linked", () => {
    const jiraIssue = makeItem({ source_id: "PROJ-500", source: "jira", event_type: "issue_created" })
    const ciFailed = makeItem({
      source_id: "owner/repo#80",
      source: "github",
      event_type: "ci_failed",
      metadata: { jira_keys: ["PROJ-500"] },
    })
    const result = resolveLinks([jiraIssue, ciFailed])
    expect(result.groups.length).toBe(1)
    expect(result.groups[0].linked[0].source_id).toBe("owner/repo#80")
  })

  test("mixed: some linked, some standalone", () => {
    const jiraIssue = makeItem({ source_id: "PROJ-600", source: "jira", event_type: "issue_created" })
    const linkedPr = makeItem({
      source_id: "owner/repo#90",
      source: "github",
      event_type: "pr_opened",
      metadata: { jira_keys: ["PROJ-600"] },
    })
    const standalonePr = makeItem({
      source_id: "owner/repo#91",
      source: "github",
      event_type: "pr_opened",
      title: "Unrelated work",
    })
    const standaloneIssue = makeItem({
      source_id: "owner/repo#92",
      source: "github",
      event_type: "issue_opened",
    })
    const result = resolveLinks([jiraIssue, linkedPr, standalonePr, standaloneIssue])
    expect(result.groups.length).toBe(1)
    expect(result.groups[0].primary.source_id).toBe("PROJ-600")
    expect(result.groups[0].linked.length).toBe(1)
    // standalone should have the jira issue + standalone PR + standalone issue (3 items)
    expect(result.standalone.length).toBe(3)
    const standaloneIds = result.standalone.map((i) => i.source_id)
    expect(standaloneIds).toContain("PROJ-600")
    expect(standaloneIds).toContain("owner/repo#91")
    expect(standaloneIds).toContain("owner/repo#92")
  })
})

describe("applyLinkResolution", () => {
  test("should return items unchanged when no links exist", () => {
    const items = [
      makeItem({ source_id: "PROJ-1", source: "jira", event_type: "issue_created" }),
      makeItem({ source_id: "owner/repo#10", source: "github", event_type: "issue_opened" }),
    ]
    const result = applyLinkResolution(items)
    expect(result.length).toBe(2)
    expect(result.every((i) => !i.linkedPrCount)).toBe(true)
  })

  test("should remove linked PRs and annotate primary with linkedPrCount", () => {
    const jiraIssue = makeItem({ source_id: "PROJ-123", source: "jira", event_type: "issue_created" })
    const pr1 = makeItem({
      source_id: "owner/repo#42",
      source: "github",
      event_type: "pr_opened",
      metadata: { jira_keys: ["PROJ-123"] },
    })
    const pr2 = makeItem({
      source_id: "owner/repo#43",
      source: "github",
      event_type: "pr_opened",
      metadata: { jira_keys: ["PROJ-123"] },
    })
    const result = applyLinkResolution([jiraIssue, pr1, pr2])
    expect(result.length).toBe(1)
    expect(result[0].source_id).toBe("PROJ-123")
    expect(result[0].linkedPrCount).toBe(2)
  })

  test("should annotate with linkedPrCount=1 for single linked PR", () => {
    const jiraIssue = makeItem({ source_id: "PROJ-456", source: "jira", event_type: "issue_created" })
    const pr = makeItem({
      source_id: "owner/repo#99",
      source: "github",
      event_type: "pr_opened",
      metadata: { jira_keys: ["PROJ-456"] },
    })
    const result = applyLinkResolution([jiraIssue, pr])
    expect(result.length).toBe(1)
    expect(result[0].source_id).toBe("PROJ-456")
    expect(result[0].linkedPrCount).toBe(1)
  })

  test("should not mutate original items", () => {
    const jiraIssue = makeItem({ source_id: "PROJ-789", source: "jira", event_type: "issue_created" })
    const pr = makeItem({
      source_id: "owner/repo#55",
      source: "github",
      event_type: "pr_opened",
      metadata: { jira_keys: ["PROJ-789"] },
    })
    const origItems = [jiraIssue, pr]
    applyLinkResolution(origItems)
    expect(origItems.length).toBe(2)
    expect(jiraIssue.linkedPrCount).toBeUndefined()
  })

  test("should preserve standalone PRs and issues", () => {
    const standalonePr = makeItem({
      source_id: "owner/repo#100",
      source: "github",
      event_type: "pr_opened",
      title: "No linked issue",
    })
    const standaloneIssue = makeItem({
      source_id: "owner/repo#101",
      source: "github",
      event_type: "issue_opened",
    })
    const result = applyLinkResolution([standalonePr, standaloneIssue])
    expect(result.length).toBe(2)
    expect(result.every((i) => !i.linkedPrCount)).toBe(true)
  })
})
