import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, onMount, onCleanup, For, Show } from "solid-js"
import { Database } from "@/storage/db"
import { DismissedEventTable, SuppressionPatternTable } from "@/needs-me/needs-me.sql"
import { ActivityEventTable } from "@/activity-feed/activity-feed.sql"
import { eq, and, gt, sql, desc } from "drizzle-orm"
import { SNOOZE_DURATIONS, type SnoozeDuration } from "@/needs-me"
import { Identifier } from "@/id/id"
import { TextAttributes } from "@opentui/core"
import { registerTab } from "@tui/pal/tab-registry"
import { recordTriageDecision } from "@/needs-me/decisions"
import { sweepSingle } from "@/sweep/sweep"
import { get as getRole } from "@/config/role"
import { load as loadProcessDoc } from "@/process/process-doc"
import {
  buildDisplayRows,
  DONE_EVENT_TYPES,
  DONE_JIRA_STATUSES,
  type ActivityItem,
  type DisplayRow,
} from "@/needs-me/needs-me-logic"

const id = "internal:pal-needs-me"
const REFRESH_INTERVAL_MS = 5_000
const OVERFLOW_THRESHOLD = 20
const OVERFLOW_SUSTAIN_MS = 2 * 60 * 60 * 1000
const AUTO_SUPPRESS_THRESHOLD = 3
const SUPPRESSION_DECAY_MS = 30 * 24 * 60 * 60 * 1000

function formatTimestamp(ts: number): string {
  const now = Date.now(); const diff = now - ts
  if (diff < 60_000) return "just now"; if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`; if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  const date = new Date(ts); return `${date.getMonth() + 1}/${date.getDate()}`
}
function formatLastChecked(ts: number | null): string { return ts === null ? "never" : formatTimestamp(ts) }

function sourceChar(source: string): string {
  if (source.toLowerCase().startsWith("jira")) return "J"
  if (source.toLowerCase().startsWith("github")) return "G"
  if (source.toLowerCase().startsWith("gitlab")) return "L"
  return source.charAt(0).toUpperCase()
}

function getDismissedKeys(): Set<string> {
  try { return Database.use((db) => { const rows = db.select({ work_item_key: DismissedEventTable.work_item_key }).from(DismissedEventTable).where(eq(DismissedEventTable.action, "dismiss")).all(); return new Set(rows.map((r) => r.work_item_key)) }) } catch { return new Set() }
}
function getSnoozedKeys(): Map<string, number> {
  try { const now = Date.now(); return Database.use((db) => { const rows = db.select({ work_item_key: DismissedEventTable.work_item_key, snooze_until: DismissedEventTable.snooze_until }).from(DismissedEventTable).where(and(eq(DismissedEventTable.action, "snooze"), gt(DismissedEventTable.snooze_until, now))).all(); const map = new Map<string, number>(); for (const r of rows) { if (r.snooze_until) map.set(r.work_item_key, r.snooze_until) }; return map }) } catch { return new Map() }
}

function computeFilteredQueue(): ActivityItem[] {
  try {
    return Database.use((db) => {
      // Get the latest event for each source_id
      const rows = db
        .select()
        .from(ActivityEventTable)
        .orderBy(desc(ActivityEventTable.timestamp))
        .limit(1000)
        .all()

      const doneSourceIds = new Set<string>()

      // Group by source_id and take the latest event, also track done items
      const bySourceId = new Map<string, ActivityItem>()
      for (const row of rows) {
        // GitHub: check event type
        if (DONE_EVENT_TYPES.has(row.event_type)) {
          doneSourceIds.add(row.source_id)
        }
        // Jira: check metadata.status
        if (row.source === "jira") {
          const meta = row.metadata as Record<string, unknown> | null
          const status = (meta?.status as string) ?? ""
          if (DONE_JIRA_STATUSES.has(status)) {
            doneSourceIds.add(row.source_id)
          }
        }
        if (!bySourceId.has(row.source_id)) {
          const meta = row.metadata as Record<string, unknown> | null
          bySourceId.set(row.source_id, {
            source_id: row.source_id,
            source: row.source,
            title: row.title,
            url: row.url,
            actor: row.actor,
            last_event_ts: row.timestamp,
            event_type: row.event_type,
            summary: row.summary,
            parent_key: (meta?.parent_key as string) ?? null,
            issue_type: (meta?.issue_type as string) ?? null,
            milestone: (meta?.milestone as string) ?? null,
          })
        }
      }

      // Filter out dismissed, snoozed, and done items
      const dismissed = getDismissedKeys()
      const snoozed = getSnoozedKeys()
      const items = Array.from(bySourceId.values()).filter((item) => {
        if (dismissed.has(item.source_id)) return false
        if (snoozed.has(item.source_id)) return false
        if (doneSourceIds.has(item.source_id)) return false
        return true
      })

      // Sort by timestamp descending
      items.sort((a, b) => b.last_event_ts - a.last_event_ts)
      return items
    })
  } catch {
    return []
  }
}

function NeedsMeView(props: { api: TuiPluginApi }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [queue, setQueue] = createSignal<ActivityItem[]>([])
  const [lastChecked, setLastChecked] = createSignal<number | null>(null)
  const [hasEverLoaded, setHasEverLoaded] = createSignal(false)
  const [overflowAlert, setOverflowAlert] = createSignal(false)
  const [overflowSince, setOverflowSince] = createSignal<number | null>(null)
  const [scrollOffset, setScrollOffset] = createSignal(0)
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [sweeping, setSweeping] = createSignal(false)
  const [sweepingSourceId, setSweepingSourceId] = createSignal<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(new Set())
  const displayRows = () => buildDisplayRows(queue(), collapsedGroups())
  // All selectable items in display order — headers with items are selectable too
  const displayItems = (): ActivityItem[] => {
    const result: ActivityItem[] = []
    for (const r of displayRows()) {
      if (r.kind === "header" && r.item) result.push(r.item)
      else if (r.kind === "item") result.push(r.item)
    }
    return result
  }

  // Animated spinner
  const spinnerFrames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  const [spinnerFrame, setSpinnerFrame] = createSignal(0)
  let spinnerTimer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    spinnerTimer = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % spinnerFrames.length)
    }, 100)
  })
  onCleanup(() => { if (spinnerTimer) clearInterval(spinnerTimer) })

  // Track triage sessions: source_id -> sessionID
  const triageSessionMap = new Map<string, string>()

  function refresh() {
    const items = computeFilteredQueue(); setQueue(items); setLastChecked(Date.now())
    if (items.length > 0) setHasEverLoaded(true)
    const now = Date.now()
    if (items.length > OVERFLOW_THRESHOLD) {
      const since = overflowSince()
      if (since === null) { setOverflowSince(now); setOverflowAlert(false) }
      else if (now - since >= OVERFLOW_SUSTAIN_MS) { setOverflowAlert(true) }
    } else { setOverflowSince(null); setOverflowAlert(false) }
    // Clamp selectedIndex to new display bounds
    const dispItems = displayItems()
    if (dispItems.length > 0 && selectedIndex() >= dispItems.length) {
      setSelectedIndex(dispItems.length - 1)
    }
  }

  function handleDismiss(item: ActivityItem) {
    const ruleSource = `activity:${item.source}`
    try {
      Database.use((db) => {
        db.insert(DismissedEventTable).values({
          id: Identifier.create("nmd", "ascending"),
          work_item_key: item.source_id,
          action: "dismiss",
          snooze_until: null,
          rule_source: ruleSource,
          dismissed_at: Date.now(),
        }).run()
      })
    } catch {}
    refresh()
  }
  function handleSnooze(item: ActivityItem, duration: SnoozeDuration) {
    const ruleSource = `activity:${item.source}`
    const snoozeUntil = Date.now() + SNOOZE_DURATIONS[duration]
    try {
      Database.use((db) => {
        db.insert(DismissedEventTable).values({
          id: Identifier.create("nmd", "ascending"),
          work_item_key: item.source_id,
          action: "snooze",
          snooze_until: snoozeUntil,
          rule_source: ruleSource,
          dismissed_at: Date.now(),
        }).run()
      })
    } catch {}
    refresh()
  }
  void handleSnooze

  async function launchTriageSession(item: ActivityItem) {
    // Resume existing triage session if one exists for this item
    const existingSessionID = triageSessionMap.get(item.source_id)
    if (existingSessionID) {
      props.api.route.navigate("session", { sessionID: existingSessionID })
      return
    }

    // Show sweeping indicator
    setSweeping(true)
    setSweepingSourceId(item.source_id)

    // Sweep the single issue
    let sweepResult: Awaited<ReturnType<typeof sweepSingle>> = null
    try {
      sweepResult = await sweepSingle(item.source_id)
    } catch (err) {
      // Continue anyway, will launch triage without sweep result
    }

    setSweeping(false)
    setSweepingSourceId(null)

    // Create new session
    const phaseSuffix = sweepResult?.phase ? ` [${sweepResult.phase}]` : ""
    const result = await props.api.client.session.create({
      title: `Triage${phaseSuffix}: ${item.title.slice(0, 50)}`,
    })
    if (!result.data?.id) return

    const sessionID = result.data.id
    triageSessionMap.set(item.source_id, sessionID)

    // Load process doc and role for context
    const processDoc = loadProcessDoc() ?? "No process document configured."
    const role = getRole() ?? "No role configured."

    // Build context message
    let contextText = `Process context from your team's process document:
${processDoc}

Your role: ${role}

Issue: ${item.title}
URL: ${item.url ?? "none"}
`

    if (sweepResult) {
      contextText += `
Sweep analysis:
Summary: ${sweepResult.summary}
Recommended action: ${sweepResult.action}
Priority: ${sweepResult.priority}
${sweepResult.phase ? `Phase: ${sweepResult.phase}\n` : ""}
`
    }

    contextText += "\nHelp me take this action. Fetch the full issue details first."

    // Send initial context
    await props.api.client.session.prompt({
      sessionID,
      parts: [{
        type: "text" as const,
        text: contextText,
      }],
    })

    // Navigate to session
    props.api.route.navigate("session", { sessionID })
  }

  // Keyboard handling
  useKeyboard((evt) => {
    // Don't handle keys when a dialog is open
    if (props.api.ui.dialog.open) return
    if (evt.defaultPrevented) return
    if (evt.ctrl || evt.meta || evt.shift) return

    const items = displayItems()
    if (items.length === 0) return

    const name = evt.name ?? ""

    // Up / k: move selection up
    if (name === "up" || name === "k") {
      evt.preventDefault()
      setSelectedIndex((idx) => Math.max(0, idx - 1))
      const idx = selectedIndex()
      if (idx < scrollOffset()) setScrollOffset(idx)
      return
    }

    // Down / j: move selection down
    if (name === "down" || name === "j") {
      evt.preventDefault()
      setSelectedIndex((idx) => Math.min(items.length - 1, idx + 1))
      const idx = selectedIndex()
      const visItems = visibleDisplayRows().filter((r) => r.kind === "item")
      const visIds = visItems.map((r) => r.kind === "item" ? r.item.source_id : "")
      const selectedId = items[idx]?.source_id
      if (selectedId && !visIds.includes(selectedId)) {
        setScrollOffset((prev) => prev + 1)
      }
      return
    }

    // Enter: launch triage session
    if (name === "return") {
      evt.preventDefault()
      const item = items[selectedIndex()]
      if (item) void launchTriageSession(item)
      return
    }

    // d: dismiss selected item
    if (name === "d") {
      evt.preventDefault()
      const item = items[selectedIndex()]
      if (item) handleDismiss(item)
      return
    }

    // e: expand/collapse group
    if (name === "e") {
      evt.preventDefault()
      const item = items[selectedIndex()]
      if (item) {
        const groupKey = item.parent_key ?? item.milestone
        if (groupKey) {
          setCollapsedGroups((prev) => {
            const next = new Set(prev)
            if (next.has(groupKey)) next.delete(groupKey)
            else next.add(groupKey)
            return next
          })
        }
      }
      return
    }
  })

  onMount(() => refresh())
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  onMount(() => { refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS) })
  onCleanup(() => { if (refreshTimer) clearInterval(refreshTimer) })

  const visibleHeight = () => {
    // Header takes 3 rows (or 4 with overflow), footer takes 1 row, sweeping message takes 1 row (optional)
    const headerRows = overflowAlert() ? 4 : 3
    const footerRows = 1
    const sweepingRows = sweeping() ? 1 : 0
    const availableRows = Math.max(dimensions().height - headerRows - footerRows - sweepingRows, 2)
    return availableRows
  }
  const visibleDisplayRows = (): DisplayRow[] => {
    const rows = displayRows()
    const offset = scrollOffset()
    const maxRows = visibleHeight()

    // Find the display row that contains the item at scrollOffset
    let itemCount = 0
    let startIdx = 0
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].kind === "item") {
        if (itemCount === offset) { startIdx = i; break }
        itemCount++
      } else if (itemCount <= offset) {
        // Include headers that appear before or at the scroll position
        startIdx = i
      }
    }
    // Walk backwards to include the group header if the first visible item is indented
    if (startIdx > 0 && rows[startIdx].kind === "item" && rows[startIdx - 1]?.kind === "header") {
      startIdx--
    }

    // Collect rows that fit in available height
    const result: DisplayRow[] = []
    let usedRows = 0
    for (let i = startIdx; i < rows.length; i++) {
      const rowHeight = rows[i].kind === "header" ? 1 : 2
      if (usedRows + rowHeight > maxRows) break
      result.push(rows[i])
      usedRows += rowHeight
    }
    return result
  }

  return (
    <box width={dimensions().width} flexGrow={1} flexDirection="column">
      <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>Needs Me</text>
        <text fg={theme.textMuted}>{" ("}{queue().length}{" items)"}</text>
        <box flexGrow={1} />
        <text fg={theme.textMuted}>{"Last checked: "}{formatLastChecked(lastChecked())}</text>
        <box width={1} />
      </box>
      <Show when={overflowAlert()}>
        <box height={1} flexShrink={0} paddingLeft={1}>
          <text fg={theme.error} attributes={TextAttributes.BOLD}>{"Your queue has had >"}{OVERFLOW_THRESHOLD}{" items for 2h+ -- consider bulk-triaging or delegating."}</text>
        </box>
      </Show>
      <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
        <box width={2} flexShrink={0} />
        <box width={2} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Src</text></box>
        <box width={8} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Time</text></box>
        <box flexGrow={1}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Title</text></box>
        <box width={14} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Actor</text></box>
      </box>
      <Show when={sweeping()}>
        <box height={1} flexShrink={0} paddingLeft={1} backgroundColor={theme.backgroundPanel}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>{"⟳ Analyzing: "}</text>
          <text fg={theme.text}>{queue().find(item => item.source_id === sweepingSourceId())?.title ?? "..."}</text>
        </box>
      </Show>
      <Show when={queue().length > 0} fallback={
        <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
          <Show when={hasEverLoaded()} fallback={
            <>
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>{spinnerFrames[spinnerFrame()]}{" Loading activity feed..."}</text>
              <box height={1} />
              <text fg={theme.textMuted}>Waiting for first poll to complete</text>
            </>
          }>
            <text fg={theme.textMuted}>Nothing needs you right now</text>
            <box height={1} />
            <text fg={theme.textMuted}>{"Last checked: "}{formatLastChecked(lastChecked())}</text>
          </Show>
        </box>
      }>
        <box flexGrow={1} flexDirection="column" overflow="hidden">
          <For each={visibleDisplayRows()}>
            {(row) => {
              if (row.kind === "header") {
                const headerItem = row.item
                const headerSelected = () => {
                  if (!headerItem) return false
                  const idx = selectedIndex()
                  const items = displayItems()
                  return idx < items.length && items[idx]?.source_id === headerItem.source_id
                }
                return (
                  <box height={1} flexDirection="row" paddingLeft={1} backgroundColor={headerSelected() ? theme.backgroundElement : undefined}>
                    <box width={2} flexShrink={0}><text fg={headerSelected() ? theme.primary : theme.textMuted} attributes={TextAttributes.BOLD}>{headerSelected() ? "▸" : row.collapsed ? "▶" : "▼"} </text></box>
                    <text fg={headerSelected() ? theme.primary : theme.textMuted} attributes={TextAttributes.BOLD}>
                      {row.label}{" ("}{row.count}{")"}</text>
                    <Show when={headerItem}>
                      <text fg={headerSelected() ? theme.primary : theme.textMuted}>{" · "}{formatTimestamp(headerItem!.last_event_ts)}</text>
                    </Show>
                  </box>
                )
              }
              const item = row.item
              const indent = row.indented ? 2 : 0
              const maxTitleWidth = () => Math.max(dimensions().width - 26 - indent, 10)
              const isSelected = () => {
                const idx = selectedIndex()
                const items = displayItems()
                return idx < items.length && items[idx]?.source_id === item.source_id
              }
              const hasTriage = () => triageSessionMap.has(item.source_id)
              const isSweeping = () => sweeping() && sweepingSourceId() === item.source_id
              return (
                <box flexDirection="column" backgroundColor={isSelected() ? theme.backgroundElement : undefined}>
                  <box height={1} flexDirection="row" paddingLeft={1 + indent}>
                    <box width={2} flexShrink={0}><text fg={isSelected() ? theme.primary : theme.textMuted} attributes={isSelected() ? TextAttributes.BOLD : undefined}>{isSelected() ? "▸" : " "} </text></box>
                    <box width={2} flexShrink={0}><text fg={isSelected() ? theme.primary : theme.textMuted}>{sourceChar(item.source)} </text></box>
                    <box width={8} flexShrink={0}><text fg={isSelected() ? theme.primary : theme.textMuted}>{formatTimestamp(item.last_event_ts)}</text></box>
                    <box flexGrow={1}><text fg={isSelected() ? theme.primary : theme.text} attributes={isSelected() ? TextAttributes.BOLD : undefined}>{hasTriage() ? "● " : ""}{isSweeping() ? "⟳ " : ""}{item.title.length > maxTitleWidth() ? item.title.slice(0, maxTitleWidth() - 1) + "…" : item.title}</text></box>
                    <box width={14} flexShrink={0}><text fg={isSelected() ? theme.primary : theme.textMuted}>{(item.actor ?? "").length > 12 ? (item.actor ?? "").slice(0, 11) + "…" : (item.actor ?? "")}</text></box>
                  </box>
                  <box height={1} flexDirection="row" paddingLeft={12 + indent}>
                    <text fg={isSelected() ? theme.primary : theme.textMuted} attributes={isSelected() ? undefined : TextAttributes.DIM}>{item.event_type}{item.summary ? `: ${item.summary}` : ""}</text>
                  </box>
                </box>
              )
            }}
          </For>
        </box>
        <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"j/k select  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"enter triage  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"d dismiss  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"e expand/collapse"}</text>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  registerTab({ key: 2, label: "Needs Me", order: 200, render: () => <NeedsMeView api={api} /> })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
