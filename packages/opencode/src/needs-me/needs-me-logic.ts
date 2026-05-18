/**
 * Pure data logic for the Needs Me tab.
 * These functions are extracted from needs-me.tsx for testability.
 */

export const DONE_EVENT_TYPES = new Set(["pr_merged", "pr_closed", "issue_closed"])
export const DONE_JIRA_STATUSES = new Set(["Closed", "Done", "Resolved"])

export type ActivityItem = {
  source_id: string
  source: string
  title: string
  url: string | null
  actor: string | null
  last_event_ts: number
  event_type: string
  summary: string | null
  parent_key: string | null
  issue_type: string | null
  milestone: string | null
}

export type DisplayRow =
  | { kind: "header"; groupKey: string; label: string; count: number; collapsed: boolean; item: ActivityItem | null }
  | { kind: "item"; item: ActivityItem; indented: boolean }

/**
 * Check if an event type indicates completion/closure.
 */
export function isDoneEvent(eventType: string): boolean {
  return DONE_EVENT_TYPES.has(eventType)
}

/**
 * Check if a Jira status indicates completion/closure.
 */
export function isDoneJiraStatus(status: string): boolean {
  return DONE_JIRA_STATUSES.has(status)
}

/**
 * Build display rows from activity items, applying grouping and collapse state.
 * Items are grouped by parent_key (for Jira subtasks) or milestone (for GitHub issues).
 * Ungrouped items appear at the bottom.
 */
export function buildDisplayRows(items: ActivityItem[], collapsedGroups: Set<string>): DisplayRow[] {
  const groups = new Map<string, { label: string; items: ActivityItem[] }>()
  const ungrouped: ActivityItem[] = []

  for (const item of items) {
    const groupKey = item.parent_key ?? item.milestone
    if (groupKey) {
      if (!groups.has(groupKey)) {
        const label = item.parent_key ? `${item.parent_key}` : `Milestone: ${item.milestone}`
        groups.set(groupKey, { label, items: [] })
      }
      groups.get(groupKey)!.items.push(item)
    } else {
      ungrouped.push(item)
    }
  }

  const rows: DisplayRow[] = []
  for (const [groupKey, group] of groups) {
    // Find the parent item (milestone/epic itself) — it may be in the items list
    const parentItem = items.find((i) => i.source_id === groupKey || i.source_id.endsWith("#" + groupKey))
    // If no parent item exists (e.g. milestones aren't issues), create a synthetic one from child data
    const headerItem: ActivityItem = parentItem ?? {
      source_id: `_group_${groupKey}`,
      source: group.items[0]?.source ?? "github",
      title: group.label,
      url: null,
      actor: null,
      last_event_ts: Math.max(...group.items.map((i) => i.last_event_ts)),
      event_type: "group",
      summary: `${group.items.length} sub-issue${group.items.length !== 1 ? "s" : ""}`,
      parent_key: null,
      issue_type: null,
      milestone: groupKey,
    }
    const label = parentItem ? `${parentItem.title}` : group.label
    const collapsed = collapsedGroups.has(groupKey)
    rows.push({ kind: "header", groupKey, label, count: group.items.length, collapsed, item: headerItem })
    if (!collapsed) {
      for (const item of group.items) {
        rows.push({ kind: "item", item, indented: true })
      }
    }
  }
  for (const item of ungrouped) {
    rows.push({ kind: "item", item, indented: false })
  }
  return rows
}

/**
 * Filter out "done" items based on their event history and status.
 * An item is considered done if:
 * - Any event in its history has a DONE_EVENT_TYPE (pr_merged, pr_closed, issue_closed)
 * - For Jira items, the current status is in DONE_JIRA_STATUSES (Closed, Done, Resolved)
 *
 * @param items - The activity items to filter
 * @param allEventTypes - Map of source_id -> Set of all event_type values in that item's history
 * @param allJiraStatuses - Map of source_id -> current Jira status (if applicable)
 * @returns Items that are NOT done
 */
export function filterDoneItems(
  items: ActivityItem[],
  allEventTypes: Map<string, Set<string>>,
  allJiraStatuses: Map<string, string>,
): ActivityItem[] {
  const doneSourceIds = new Set<string>()

  // Build set of done source_ids based on event history and Jira status
  for (const [sourceId, eventTypes] of allEventTypes.entries()) {
    for (const eventType of eventTypes) {
      if (isDoneEvent(eventType)) {
        doneSourceIds.add(sourceId)
        break
      }
    }
  }

  for (const [sourceId, status] of allJiraStatuses.entries()) {
    if (isDoneJiraStatus(status)) {
      doneSourceIds.add(sourceId)
    }
  }

  return items.filter((item) => !doneSourceIds.has(item.source_id))
}
