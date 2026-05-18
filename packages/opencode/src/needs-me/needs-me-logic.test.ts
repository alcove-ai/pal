import { test, expect, describe } from "bun:test"
import {
  isDoneEvent,
  isDoneJiraStatus,
  buildDisplayRows,
  filterDoneItems,
  type ActivityItem,
} from "./needs-me-logic"

describe("isDoneEvent", () => {
  test("should return true for pr_merged", () => {
    expect(isDoneEvent("pr_merged")).toBe(true)
  })

  test("should return true for pr_closed", () => {
    expect(isDoneEvent("pr_closed")).toBe(true)
  })

  test("should return true for issue_closed", () => {
    expect(isDoneEvent("issue_closed")).toBe(true)
  })

  test("should return false for pr_opened", () => {
    expect(isDoneEvent("pr_opened")).toBe(false)
  })

  test("should return false for issue_opened", () => {
    expect(isDoneEvent("issue_opened")).toBe(false)
  })

  test("should return false for pr_comment", () => {
    expect(isDoneEvent("pr_comment")).toBe(false)
  })
})

describe("isDoneJiraStatus", () => {
  test("should return true for Closed", () => {
    expect(isDoneJiraStatus("Closed")).toBe(true)
  })

  test("should return true for Done", () => {
    expect(isDoneJiraStatus("Done")).toBe(true)
  })

  test("should return true for Resolved", () => {
    expect(isDoneJiraStatus("Resolved")).toBe(true)
  })

  test("should return false for In Progress", () => {
    expect(isDoneJiraStatus("In Progress")).toBe(false)
  })

  test("should return false for Open", () => {
    expect(isDoneJiraStatus("Open")).toBe(false)
  })

  test("should return false for To Do", () => {
    expect(isDoneJiraStatus("To Do")).toBe(false)
  })
})

describe("buildDisplayRows", () => {
  test("should return empty array for empty input", () => {
    const rows = buildDisplayRows([], new Set())
    expect(rows).toEqual([])
  })

  test("should create ungrouped rows for items without parent_key or milestone", () => {
    const items: ActivityItem[] = [
      {
        source_id: "item1",
        source: "github",
        title: "Fix bug",
        url: "https://github.com/test/1",
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: null,
        milestone_url: null,
      },
      {
        source_id: "item2",
        source: "github",
        title: "Add feature",
        url: "https://github.com/test/2",
        actor: "user2",
        last_event_ts: 2000,
        event_type: "pr_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: null,
        milestone_url: null,
      },
    ]

    const rows = buildDisplayRows(items, new Set())
    expect(rows).toEqual([
      { kind: "item", item: items[0], indented: false },
      { kind: "item", item: items[1], indented: false },
    ])
  })

  test("should group items by parent_key", () => {
    const items: ActivityItem[] = [
      {
        source_id: "SUB-1",
        source: "jira",
        title: "Subtask 1",
        url: null,
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: "PROJ-123",
        issue_type: "Sub-task",
        milestone: null,
        milestone_url: null,
      },
      {
        source_id: "SUB-2",
        source: "jira",
        title: "Subtask 2",
        url: null,
        actor: "user2",
        last_event_ts: 2000,
        event_type: "issue_opened",
        summary: null,
        parent_key: "PROJ-123",
        issue_type: "Sub-task",
        milestone: null,
        milestone_url: null,
      },
    ]

    const rows = buildDisplayRows(items, new Set())
    expect(rows.length).toBe(3) // 1 header + 2 items
    expect(rows[0]).toEqual({
      kind: "header",
      groupKey: "PROJ-123",
      label: "PROJ-123",
      count: 2,
      collapsed: false,
      item: expect.anything(),
    })
    expect(rows[1]).toEqual({ kind: "item", item: items[0], indented: true })
    expect(rows[2]).toEqual({ kind: "item", item: items[1], indented: true })
  })

  test("should group items by milestone", () => {
    const items: ActivityItem[] = [
      {
        source_id: "issue1",
        source: "github",
        title: "Issue 1",
        url: "https://github.com/test/1",
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: "v1.0",
        milestone_url: "https://github.com/org/repo/milestone/1",
      },
      {
        source_id: "issue2",
        source: "github",
        title: "Issue 2",
        url: "https://github.com/test/2",
        actor: "user2",
        last_event_ts: 2000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: "v1.0",
        milestone_url: "https://github.com/org/repo/milestone/1",
      },
    ]

    const rows = buildDisplayRows(items, new Set())
    expect(rows.length).toBe(3)
    expect(rows[0]).toEqual({
      kind: "header",
      groupKey: "v1.0",
      label: "Milestone: v1.0",
      count: 2,
      collapsed: false,
      item: expect.anything(),
    })
    expect(rows[1]).toEqual({ kind: "item", item: items[0], indented: true })
    expect(rows[2]).toEqual({ kind: "item", item: items[1], indented: true })
  })

  test("should hide items when group is collapsed", () => {
    const items: ActivityItem[] = [
      {
        source_id: "SUB-1",
        source: "jira",
        title: "Subtask 1",
        url: null,
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: "PROJ-123",
        issue_type: "Sub-task",
        milestone: null,
        milestone_url: null,
      },
    ]

    const rows = buildDisplayRows(items, new Set(["PROJ-123"]))
    expect(rows.length).toBe(1) // Only header, no items
    expect(rows[0]).toEqual({
      kind: "header",
      groupKey: "PROJ-123",
      label: "PROJ-123",
      count: 1,
      collapsed: true,
      item: expect.anything(),
    })
  })

  test("should handle mixed grouped and ungrouped items", () => {
    const items: ActivityItem[] = [
      {
        source_id: "SUB-1",
        source: "jira",
        title: "Subtask 1",
        url: null,
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: "PROJ-123",
        issue_type: "Sub-task",
        milestone: null,
        milestone_url: null,
      },
      {
        source_id: "issue1",
        source: "github",
        title: "Standalone issue",
        url: "https://github.com/test/1",
        actor: "user2",
        last_event_ts: 2000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: null,
        milestone_url: null,
      },
    ]

    const rows = buildDisplayRows(items, new Set())
    expect(rows.length).toBe(3) // 1 header + 1 grouped item + 1 ungrouped item
    expect(rows[0].kind).toBe("header")
    expect(rows[1].kind).toBe("item")
    if (rows[1].kind === "item") {
      expect(rows[1].indented).toBe(true)
    }
    expect(rows[2].kind).toBe("item")
    if (rows[2].kind === "item") {
      expect(rows[2].indented).toBe(false)
    }
  })

  test("should enhance header label with parent item title if available", () => {
    const items: ActivityItem[] = [
      {
        source_id: "PROJ-123",
        source: "jira",
        title: "PROJ-123: Main task",
        url: null,
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: "Task",
        milestone: null,
        milestone_url: null,
      },
      {
        source_id: "SUB-1",
        source: "jira",
        title: "Subtask 1",
        url: null,
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: "PROJ-123",
        issue_type: "Sub-task",
        milestone: null,
        milestone_url: null,
      },
    ]

    const rows = buildDisplayRows(items, new Set())
    if (rows[0].kind === "header") {
      expect(rows[0].label).toBe("PROJ-123: Main task")
      expect(rows[0].groupKey).toBe("PROJ-123")
      expect(rows[0].count).toBe(1)
      expect(rows[0].collapsed).toBe(false)
    }
  })

  test("should handle parent item source_id with hash notation", () => {
    const items: ActivityItem[] = [
      {
        source_id: "repo#PROJ-123",
        source: "jira",
        title: "PROJ-123: Main task",
        url: null,
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: "Task",
        milestone: null,
        milestone_url: null,
      },
      {
        source_id: "SUB-1",
        source: "jira",
        title: "Subtask 1",
        url: null,
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: "PROJ-123",
        issue_type: "Sub-task",
        milestone: null,
        milestone_url: null,
      },
    ]

    const rows = buildDisplayRows(items, new Set())
    expect(rows[0].kind).toBe("header")
    if (rows[0].kind === "header") {
      expect(rows[0].label).toBe("PROJ-123: Main task")
    }
  })
})

describe("filterDoneItems", () => {
  test("should filter out items with pr_merged in event history", () => {
    const items: ActivityItem[] = [
      {
        source_id: "pr1",
        source: "github",
        title: "PR 1",
        url: "https://github.com/test/1",
        actor: "user1",
        last_event_ts: 1000,
        event_type: "pr_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: null,
        milestone_url: null,
      },
      {
        source_id: "pr2",
        source: "github",
        title: "PR 2",
        url: "https://github.com/test/2",
        actor: "user2",
        last_event_ts: 2000,
        event_type: "pr_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: null,
        milestone_url: null,
      },
    ]

    const allEventTypes = new Map([
      ["pr1", new Set(["pr_opened", "pr_comment"])],
      ["pr2", new Set(["pr_opened", "pr_merged"])],
    ])
    const allJiraStatuses = new Map()

    const filtered = filterDoneItems(items, allEventTypes, allJiraStatuses)
    expect(filtered.length).toBe(1)
    expect(filtered[0].source_id).toBe("pr1")
  })

  test("should filter out items with issue_closed in event history", () => {
    const items: ActivityItem[] = [
      {
        source_id: "issue1",
        source: "github",
        title: "Issue 1",
        url: "https://github.com/test/1",
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: null,
        milestone_url: null,
      },
      {
        source_id: "issue2",
        source: "github",
        title: "Issue 2",
        url: "https://github.com/test/2",
        actor: "user2",
        last_event_ts: 2000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: null,
        milestone_url: null,
      },
    ]

    const allEventTypes = new Map([
      ["issue1", new Set(["issue_opened"])],
      ["issue2", new Set(["issue_opened", "issue_closed"])],
    ])
    const allJiraStatuses = new Map()

    const filtered = filterDoneItems(items, allEventTypes, allJiraStatuses)
    expect(filtered.length).toBe(1)
    expect(filtered[0].source_id).toBe("issue1")
  })

  test("should filter out Jira items with Closed status", () => {
    const items: ActivityItem[] = [
      {
        source_id: "PROJ-1",
        source: "jira",
        title: "Task 1",
        url: null,
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: "Task",
        milestone: null,
        milestone_url: null,
      },
      {
        source_id: "PROJ-2",
        source: "jira",
        title: "Task 2",
        url: null,
        actor: "user2",
        last_event_ts: 2000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: "Task",
        milestone: null,
        milestone_url: null,
      },
    ]

    const allEventTypes = new Map([
      ["PROJ-1", new Set(["issue_opened"])],
      ["PROJ-2", new Set(["issue_opened"])],
    ])
    const allJiraStatuses = new Map([
      ["PROJ-1", "In Progress"],
      ["PROJ-2", "Closed"],
    ])

    const filtered = filterDoneItems(items, allEventTypes, allJiraStatuses)
    expect(filtered.length).toBe(1)
    expect(filtered[0].source_id).toBe("PROJ-1")
  })

  test("should filter out Jira items with Done status", () => {
    const items: ActivityItem[] = [
      {
        source_id: "PROJ-1",
        source: "jira",
        title: "Task 1",
        url: null,
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: "Task",
        milestone: null,
        milestone_url: null,
      },
    ]

    const allEventTypes = new Map([["PROJ-1", new Set(["issue_opened"])]])
    const allJiraStatuses = new Map([["PROJ-1", "Done"]])

    const filtered = filterDoneItems(items, allEventTypes, allJiraStatuses)
    expect(filtered.length).toBe(0)
  })

  test("should filter out Jira items with Resolved status", () => {
    const items: ActivityItem[] = [
      {
        source_id: "PROJ-1",
        source: "jira",
        title: "Task 1",
        url: null,
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: "Task",
        milestone: null,
        milestone_url: null,
      },
    ]

    const allEventTypes = new Map([["PROJ-1", new Set(["issue_opened"])]])
    const allJiraStatuses = new Map([["PROJ-1", "Resolved"]])

    const filtered = filterDoneItems(items, allEventTypes, allJiraStatuses)
    expect(filtered.length).toBe(0)
  })

  test("should keep items with only open events", () => {
    const items: ActivityItem[] = [
      {
        source_id: "pr1",
        source: "github",
        title: "PR 1",
        url: "https://github.com/test/1",
        actor: "user1",
        last_event_ts: 1000,
        event_type: "pr_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: null,
        milestone_url: null,
      },
      {
        source_id: "issue1",
        source: "github",
        title: "Issue 1",
        url: "https://github.com/test/2",
        actor: "user2",
        last_event_ts: 2000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: null,
        milestone_url: null,
      },
    ]

    const allEventTypes = new Map([
      ["pr1", new Set(["pr_opened", "pr_comment"])],
      ["issue1", new Set(["issue_opened", "issue_comment"])],
    ])
    const allJiraStatuses = new Map()

    const filtered = filterDoneItems(items, allEventTypes, allJiraStatuses)
    expect(filtered.length).toBe(2)
  })

  test("should handle items with no event history", () => {
    const items: ActivityItem[] = [
      {
        source_id: "item1",
        source: "github",
        title: "Item 1",
        url: "https://github.com/test/1",
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: null,
        milestone_url: null,
      },
    ]

    const allEventTypes = new Map()
    const allJiraStatuses = new Map()

    const filtered = filterDoneItems(items, allEventTypes, allJiraStatuses)
    expect(filtered.length).toBe(1)
  })

  test("should handle empty input", () => {
    const filtered = filterDoneItems([], new Map(), new Map())
    expect(filtered.length).toBe(0)
  })
})

describe("Regression tests", () => {
  test("GitHub issues with milestone should produce grouped display rows", () => {
    const items: ActivityItem[] = [
      {
        source_id: "issue1",
        source: "github",
        title: "Fix login bug",
        url: "https://github.com/test/1",
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: "v2.0",
        milestone_url: "https://github.com/test/milestone/2",
      },
      {
        source_id: "issue2",
        source: "github",
        title: "Add auth",
        url: "https://github.com/test/2",
        actor: "user2",
        last_event_ts: 2000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: "v2.0",
        milestone_url: "https://github.com/test/milestone/2",
      },
    ]

    const rows = buildDisplayRows(items, new Set())
    expect(rows.length).toBe(3)
    expect(rows[0].kind).toBe("header")
    if (rows[0].kind === "header") {
      expect(rows[0].groupKey).toBe("v2.0")
      expect(rows[0].count).toBe(2)
    }
  })

  test("Jira issues with parent_key should produce grouped display rows", () => {
    const items: ActivityItem[] = [
      {
        source_id: "SUB-1",
        source: "jira",
        title: "Implement backend",
        url: null,
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: "EPIC-1",
        issue_type: "Sub-task",
        milestone: null,
        milestone_url: null,
      },
      {
        source_id: "SUB-2",
        source: "jira",
        title: "Implement frontend",
        url: null,
        actor: "user2",
        last_event_ts: 2000,
        event_type: "issue_opened",
        summary: null,
        parent_key: "EPIC-1",
        issue_type: "Sub-task",
        milestone: null,
        milestone_url: null,
      },
    ]

    const rows = buildDisplayRows(items, new Set())
    expect(rows.length).toBe(3)
    expect(rows[0].kind).toBe("header")
    if (rows[0].kind === "header") {
      expect(rows[0].groupKey).toBe("EPIC-1")
      expect(rows[0].count).toBe(2)
    }
  })

  test("issue_opened events should not be filtered", () => {
    const items: ActivityItem[] = [
      {
        source_id: "issue1",
        source: "github",
        title: "New issue",
        url: "https://github.com/test/1",
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: null,
        milestone_url: null,
      },
    ]

    const allEventTypes = new Map([["issue1", new Set(["issue_opened"])]])
    const allJiraStatuses = new Map()

    const filtered = filterDoneItems(items, allEventTypes, allJiraStatuses)
    expect(filtered.length).toBe(1)
    expect(filtered[0].source_id).toBe("issue1")
  })

  test("issue_closed events should be filtered out", () => {
    const items: ActivityItem[] = [
      {
        source_id: "issue1",
        source: "github",
        title: "Closed issue",
        url: "https://github.com/test/1",
        actor: "user1",
        last_event_ts: 1000,
        event_type: "issue_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: null,
        milestone_url: null,
      },
    ]

    const allEventTypes = new Map([["issue1", new Set(["issue_opened", "issue_closed"])]])
    const allJiraStatuses = new Map()

    const filtered = filterDoneItems(items, allEventTypes, allJiraStatuses)
    expect(filtered.length).toBe(0)
  })

  test("pr_merged events should be filtered but pr_opened should not", () => {
    const items: ActivityItem[] = [
      {
        source_id: "pr1",
        source: "github",
        title: "Open PR",
        url: "https://github.com/test/1",
        actor: "user1",
        last_event_ts: 1000,
        event_type: "pr_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: null,
        milestone_url: null,
      },
      {
        source_id: "pr2",
        source: "github",
        title: "Merged PR",
        url: "https://github.com/test/2",
        actor: "user2",
        last_event_ts: 2000,
        event_type: "pr_opened",
        summary: null,
        parent_key: null,
        issue_type: null,
        milestone: null,
        milestone_url: null,
      },
    ]

    const allEventTypes = new Map([
      ["pr1", new Set(["pr_opened"])],
      ["pr2", new Set(["pr_opened", "pr_merged"])],
    ])
    const allJiraStatuses = new Map()

    const filtered = filterDoneItems(items, allEventTypes, allJiraStatuses)
    expect(filtered.length).toBe(1)
    expect(filtered[0].source_id).toBe("pr1")
  })
})
