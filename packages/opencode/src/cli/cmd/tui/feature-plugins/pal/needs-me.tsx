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
import { get as getRole } from "@/config/role"
import { load as loadProcessDoc } from "@/process/process-doc"
import {
  buildDisplayRows,
  DONE_EVENT_TYPES,
  DONE_JIRA_STATUSES,
  urgencyTier,
  urgencyBadge,
  truncateText,
  type ActivityItem,
  type DisplayRow,
} from "@/needs-me/needs-me-logic"
import { init as initPool, queueAnalysis, forceRequeue, getResult, getRunningCount, getQueueCount, getAnalyzedCount, isRunning, isQueued, getElapsedMs, getMaxConcurrent, setMaxConcurrent, type AgentResult } from "@/agent-pool/pool"

const id = "internal:pal-needs-me"
const REFRESH_INTERVAL_MS = 5_000
const OVERFLOW_THRESHOLD = 100
const OVERFLOW_SUSTAIN_MS = 2 * 60 * 60 * 1000
const AUTO_SUPPRESS_THRESHOLD = 3
const SUPPRESSION_DECAY_MS = 30 * 24 * 60 * 60 * 1000
const RECENT_THRESHOLD_MS = 4 * 60 * 60 * 1000

function isRecent(item: ActivityItem): boolean {
  return Date.now() - item.last_event_ts < RECENT_THRESHOLD_MS
}

function formatTimestamp(ts: number): string {
  const now = Date.now(); const diff = now - ts
  if (diff < 60_000) return "just now"; if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`; if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  const date = new Date(ts); return `${date.getMonth() + 1}/${date.getDate()}`
}
function formatLastChecked(ts: number | null): string { return ts === null ? "never" : formatTimestamp(ts) }

function formatElapsed(ms: number | null): string {
  if (ms === null) return "..."
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m${secs % 60}s`
}

function sourceChar(source: string): string {
  if (source.toLowerCase().startsWith("jira")) return "J"
  if (source.toLowerCase().startsWith("github")) return "G"
  if (source.toLowerCase().startsWith("gitlab")) return "L"
  return source.charAt(0).toUpperCase()
}

function urgencyColor(urgency: number, theme: any): string {
  const tier = urgencyTier(urgency)
  if (tier === "critical") return theme.error
  if (tier === "warning") return theme.warning
  if (tier === "normal") return theme.info
  return theme.textMuted
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
            milestone_url: (meta?.milestone_url as string) ?? null,
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
  const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(new Set())
  const [sortMode, setSortMode] = createSignal<"priority" | "hierarchy">("hierarchy")
  const [searchMode, setSearchMode] = createSignal(false)
  const [searchText, setSearchText] = createSignal("")

  const filteredQueue = (): ActivityItem[] => {
    const text = searchText().toLowerCase()
    if (!text) return queue()
    return queue().filter((item) => {
      if (item.source_id.toLowerCase().includes(text)) return true
      if (item.title.toLowerCase().includes(text)) return true
      if (item.actor?.toLowerCase().includes(text)) return true
      const result = getResult(item.source_id)
      if (result?.summary?.toLowerCase().includes(text)) return true
      if (result?.recommendedAction?.toLowerCase().includes(text)) return true
      return false
    })
  }

  const displayRows = (): DisplayRow[] => {
    if (sortMode() === "priority") {
      const items = filteredQueue()
      const sorted = [...items].sort((a, b) => {
        const ua = getResult(a.source_id)?.urgency ?? 5
        const ub = getResult(b.source_id)?.urgency ?? 5
        return ub - ua
      })
      return sorted.map((item) => ({ kind: "item" as const, item, indented: false }))
    }
    return buildDisplayRows(filteredQueue(), collapsedGroups())
  }
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

    // Queue all selectable items for background analysis (includes milestone headers)
    for (const item of displayItems()) {
      queueAnalysis(item)
    }

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
    // Check pool for existing session
    const poolResult = getResult(item.source_id)
    if (poolResult?.sessionId) {
      // Navigate to existing background session
      triageSessionMap.set(item.source_id, poolResult.sessionId)
      props.api.route.navigate("session", { sessionID: poolResult.sessionId })
      return
    }

    // Check triage session map (for sessions user already opened)
    const existingSessionID = triageSessionMap.get(item.source_id)
    if (existingSessionID) {
      props.api.route.navigate("session", { sessionID: existingSessionID })
      return
    }

    // No existing session — create new one (fallback, should be rare)
    const result = await props.api.client.session.create({
      title: `Triage: ${item.title.slice(0, 50)}`,
    })
    if (!result.data?.id) return

    const sessionID = result.data.id
    triageSessionMap.set(item.source_id, sessionID)

    // Navigate immediately — user sees the session right away
    props.api.route.navigate("session", { sessionID })

    // Load process doc and role for context
    const processDoc = loadProcessDoc() ?? "No process document configured."
    const role = getRole() ?? "No role configured."

    // Build context message
    const contextText = `Process context from your team's process document:
${processDoc}

Your role: ${role}

Issue: ${item.title}
URL: ${item.url ?? "none"}

Help me take this action. Fetch the full issue details first.`

    // Fire prompt in background (don't await)
    void props.api.client.session.prompt({
      sessionID,
      parts: [{
        type: "text" as const,
        text: contextText,
      }],
    })
  }

  // Keyboard handling
  useKeyboard((evt) => {
    // Don't handle keys when a dialog is open
    if (props.api.ui.dialog.open) return
    if (evt.defaultPrevented) return

    // Search mode: capture all keystrokes as filter text
    if (searchMode()) {
      evt.preventDefault()
      const name = evt.name ?? ""
      if (name === "escape" || name === "return") {
        setSearchMode(false)
        if (name === "escape") { setSearchText(""); setSelectedIndex(0); setScrollOffset(0) }
        return
      }
      if (name === "backspace") {
        setSearchText((t) => t.slice(0, -1))
        setSelectedIndex(0); setScrollOffset(0)
        return
      }
      if (name && name.length === 1 && !evt.ctrl && !evt.meta) {
        setSearchText((t) => t + name)
        setSelectedIndex(0); setScrollOffset(0)
      }
      return
    }

    if (evt.ctrl || evt.meta) return

    // Shift+= (+) / Shift+- (_): scale worker pool
    if (evt.shift) {
      const name = evt.name ?? ""
      if (name === "=" || name === "+") {
        evt.preventDefault()
        setMaxConcurrent(getMaxConcurrent() + 1)
        return
      }
      if (name === "-" || name === "_") {
        evt.preventDefault()
        setMaxConcurrent(getMaxConcurrent() - 1)
        return
      }
      return
    }

    const items = displayItems()
    if (items.length === 0 && !searchText()) return

    const name = evt.name ?? ""

    // /: open search
    if (name === "/") {
      evt.preventDefault()
      setSearchMode(true)
      return
    }

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

    // r: re-evaluate selected item
    if (name === "r") {
      evt.preventDefault()
      const item = items[selectedIndex()]
      if (item) forceRequeue(item)
      return
    }

    // s: toggle sort mode
    if (name === "s") {
      evt.preventDefault()
      setSortMode((m) => (m === "priority" ? "hierarchy" : "priority"))
      setSelectedIndex(0)
      setScrollOffset(0)
      return
    }

    // c: toggle collapse/expand all groups
    if (name === "c") {
      evt.preventDefault()
      const rows = displayRows()
      const allGroupKeys = rows.filter((r) => r.kind === "header").map((r) => r.kind === "header" ? r.groupKey : "")
      const allCollapsed = allGroupKeys.length > 0 && allGroupKeys.every((k) => collapsedGroups().has(k))
      if (allCollapsed) {
        setCollapsedGroups(new Set<string>())
      } else {
        setCollapsedGroups(new Set<string>(allGroupKeys))
      }
      setSelectedIndex(0)
      setScrollOffset(0)
      return
    }

    // Left: collapse group, Right: expand group
    if (name === "left" || name === "right") {
      evt.preventDefault()
      const item = items[selectedIndex()]
      if (item) {
        const groupKey = item.parent_key ?? item.milestone
        if (groupKey) {
          if (name === "left") {
            setCollapsedGroups((prev) => { const next = new Set(prev); next.add(groupKey); return next })
            // Move selection to the group header after collapse
            const newItems = displayItems()
            const headerIdx = newItems.findIndex((i) => i.source_id === item.source_id || (i.parent_key === null && i.milestone === groupKey) || i.source_id.endsWith("#" + groupKey))
            // Find the header item — it's the one whose source_id matches the groupKey
            const rows = displayRows()
            const headerRow = rows.find((r) => r.kind === "header" && r.groupKey === groupKey)
            if (headerRow?.kind === "header" && headerRow.item) {
              const hdrIdx = displayItems().findIndex((i) => i.source_id === headerRow.item!.source_id)
              if (hdrIdx >= 0) {
                setSelectedIndex(hdrIdx)
                if (hdrIdx < scrollOffset()) setScrollOffset(hdrIdx)
              }
            }
          } else {
            setCollapsedGroups((prev) => { const next = new Set(prev); next.delete(groupKey); return next })
          }
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
    // Header takes 3 rows (or 4 with overflow), footer takes 1 row
    const headerRows = overflowAlert() ? 4 : 3
    const footerRows = 1
    const availableRows = Math.max(dimensions().height - headerRows - footerRows, 2)
    return availableRows
  }
  const visibleDisplayRows = (): DisplayRow[] => {
    const rows = displayRows()
    const offset = scrollOffset()
    const maxRows = visibleHeight()

    // scrollOffset indexes into displayItems (selectable items).
    // Map that to a position in the full displayRows array.
    let selectableCount = 0
    let startIdx = 0
    for (let i = 0; i < rows.length; i++) {
      const isSelectable = rows[i].kind === "item" || (rows[i].kind === "header" && rows[i].item !== null)
      if (isSelectable) {
        if (selectableCount === offset) { startIdx = i; break }
        selectableCount++
      }
    }

    // Collect rows that fit in available height
    // Row height: 2-3 content lines + 1 blank separator
    const result: DisplayRow[] = []
    let usedRows = 0
    for (let i = startIdx; i < rows.length; i++) {
      const r = rows[i]
      const itemForRow = r.kind === "header" ? r.item : r.kind === "item" ? r.item : null
      const res = itemForRow ? getResult(itemForRow.source_id) : null
      const contentHeight = res?.status === "done" && res.recommendedAction ? 3 : 2
      const rowHeight = contentHeight + 1 // +1 for blank separator
      if (usedRows + rowHeight > maxRows) break
      result.push(r)
      usedRows += rowHeight
    }
    return result
  }

  const recentCount = () => queue().filter(isRecent).length

  return (
    <box width={dimensions().width} flexGrow={1} flexDirection="column">
      <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>Needs Me</text>
        <text fg={theme.textMuted}>{" ("}{filteredQueue().length}{searchText() ? `/${queue().length}` : ""}{" items)"}</text>
        <text fg={theme.info}>{sortMode() === "priority" ? " [Priority ↓]" : " [Grouped]"}</text>
        {(searchMode() || searchText()) && (
          <text fg={searchMode() ? theme.warning : theme.info}>{" /"}{searchText()}{searchMode() ? "▌" : ""}</text>
        )}
        {getRunningCount() > 0 && (
          <text fg={theme.info}>{" "}{spinnerFrames[spinnerFrame()]}{" "}{getRunningCount()}/{getMaxConcurrent()}</text>
        )}
        {getQueueCount() > 0 && (
          <text fg={theme.textMuted}>{" · "}{getQueueCount()}{" queued"}</text>
        )}
        {getAnalyzedCount() > 0 && (
          <text fg={theme.textMuted}>{" · "}{getAnalyzedCount()}{" analyzed"}</text>
        )}
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
        <box width={2} flexShrink={0} />
        <box width={2} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Src</text></box>
        <box width={8} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Time</text></box>
        <box flexGrow={1}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Title</text></box>
        <box width={14} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Actor</text></box>
      </box>
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
              const paddingLeft = 14
              const truncate = (s: string, extra = 0) => {
                const maxW = Math.max(dimensions().width - paddingLeft - 2 - extra, 10)
                return s.length > maxW ? s.slice(0, maxW - 1) + "…" : s
              }
              if (row.kind === "header") {
                const headerItem = row.item
                const headerSelected = () => {
                  if (!headerItem) return false
                  const idx = selectedIndex()
                  const items = displayItems()
                  return idx < items.length && items[idx]?.source_id === headerItem.source_id
                }
                const hsel = headerSelected
                const hrecent = () => headerItem ? isRecent(headerItem) : false
                const hfg = () => hsel() ? theme.primary : hrecent() ? theme.text : theme.textMuted
                const hmuted = () => hsel() ? theme.primary : theme.textMuted
                const maxW = () => Math.max(dimensions().width - 30, 10)
                const hResult = () => headerItem ? getResult(headerItem.source_id) : null
                const hAnalyzed = () => hResult()?.status === "done"
                const hUrgency = () => hResult()?.urgency ?? 5
                return (
                  <box flexDirection="column" backgroundColor={hsel() ? theme.backgroundElement : undefined}>
                    <box height={1} flexDirection="row" paddingLeft={1}>
                      <box width={2} flexShrink={0}><text fg={hsel() ? theme.primary : theme.textMuted} attributes={TextAttributes.BOLD}>{row.collapsed ? "▶" : "▼"}</text></box>
                      <box width={2} flexShrink={0}>
                        {(() => {
                          if (hsel()) return <text fg={theme.primary} attributes={TextAttributes.BOLD}>{hAnalyzed() ? urgencyBadge(hUrgency()) : headerItem && isRunning(headerItem.source_id) ? spinnerFrames[spinnerFrame()] : "· "}</text>
                          if (headerItem && isRunning(headerItem.source_id)) return <text fg={theme.info}>{spinnerFrames[spinnerFrame()]}</text>
                          if (hAnalyzed()) return <text fg={urgencyColor(hUrgency(), theme)} attributes={hUrgency() >= 8 ? TextAttributes.BOLD : undefined}>{urgencyBadge(hUrgency())}</text>
                          if (headerItem && hResult()?.status === "error") return <text fg={theme.error}>{"! "}</text>
                          if (headerItem && isQueued(headerItem.source_id)) return <text fg={theme.textMuted}>{"· "}</text>
                          return <text fg={theme.textMuted}>{"  "}</text>
                        })()}
                      </box>
                      <box width={2} flexShrink={0}><text fg={hmuted()}>{headerItem ? sourceChar(headerItem.source) : "?"} </text></box>
                      <box width={8} flexShrink={0}><text fg={hmuted()}>{headerItem ? formatTimestamp(headerItem.last_event_ts) : ""}</text></box>
                      <box flexGrow={1}><text fg={hfg()} attributes={hsel() ? TextAttributes.BOLD : hrecent() ? TextAttributes.BOLD : undefined}>{hrecent() && !hsel() ? "● " : ""}{row.label.length > maxW() ? row.label.slice(0, maxW() - 1) + "…" : row.label}</text></box>
                      <box width={6} flexShrink={0}><text fg={hmuted()}>{"("}{row.count}{")"}</text></box>
                    </box>
                    <box height={1} flexDirection="row" paddingLeft={paddingLeft}>
                      {(() => {
                        if (headerItem) {
                          const result = hResult()
                          if (result?.status === "done" && result.summary) {
                            const stateText = truncate(`State: ${result.summary}`)
                            return <text fg={hsel() ? theme.primary : urgencyColor(hUrgency(), theme)}>{stateText}</text>
                          }
                          if (result?.status === "running") {
                            return <text fg={hsel() ? theme.primary : theme.textMuted}>{spinnerFrames[spinnerFrame()]}{" Analyzing ("}{formatElapsed(getElapsedMs(headerItem.source_id))}{")..."}</text>
                          }
                          if (result?.status === "error") {
                            return <text fg={hsel() ? theme.primary : theme.error}>{truncate(`✗ ${result.summary}`)}</text>
                          }
                          if (isQueued(headerItem.source_id)) {
                            return <text fg={hsel() ? theme.primary : theme.textMuted}>{"Queued for analysis"}</text>
                          }
                        }
                        return <text fg={hmuted()} attributes={hsel() ? undefined : hrecent() ? undefined : TextAttributes.DIM}>{row.collapsed ? "▶ collapsed" : `▼ ${row.count} sub-issue${row.count !== 1 ? "s" : ""}`}{headerItem?.summary ? ` · ${headerItem.summary}` : ""}</text>
                      })()}
                    </box>
                    <Show when={hAnalyzed() && hResult()?.recommendedAction}>
                      <box height={1} flexDirection="row" paddingLeft={paddingLeft}>
                        <text fg={hsel() ? theme.primary : theme.textMuted} attributes={TextAttributes.DIM}>{truncate(`→ ${hResult()!.recommendedAction!}`)}</text>
                      </box>
                    </Show>
                    <box height={1} />
                  </box>
                )
              }
              const item = row.item
              const indent = row.indented ? 2 : 0
              const maxTitleWidth = () => Math.max(dimensions().width - 28 - indent, 10)
              const isSelected = () => {
                const idx = selectedIndex()
                const items = displayItems()
                return idx < items.length && items[idx]?.source_id === item.source_id
              }
              const hasTriage = () => triageSessionMap.has(item.source_id)
              const itemIsRecent = () => isRecent(item)
              const itemResult = () => getResult(item.source_id)
              const itemAnalyzed = () => itemResult()?.status === "done"
              const itemUrgency = () => itemResult()?.urgency ?? 5
              return (
                <box flexDirection="column" backgroundColor={isSelected() ? theme.backgroundElement : undefined}>
                  <box height={1} flexDirection="row" paddingLeft={1 + indent}>
                    <box width={2} flexShrink={0}><text fg={isSelected() ? theme.primary : theme.textMuted} attributes={isSelected() ? TextAttributes.BOLD : undefined}>{" "}</text></box>
                    <box width={2} flexShrink={0}>
                      {(() => {
                        if (isSelected()) return <text fg={theme.primary} attributes={TextAttributes.BOLD}>{itemAnalyzed() ? urgencyBadge(itemUrgency()) : isRunning(item.source_id) ? spinnerFrames[spinnerFrame()] : "· "}</text>
                        if (isRunning(item.source_id)) return <text fg={theme.info}>{spinnerFrames[spinnerFrame()]}</text>
                        if (itemAnalyzed()) return <text fg={urgencyColor(itemUrgency(), theme)} attributes={itemUrgency() >= 8 ? TextAttributes.BOLD : undefined}>{urgencyBadge(itemUrgency())}</text>
                        if (itemResult()?.status === "error") return <text fg={theme.error}>{"! "}</text>
                        if (isQueued(item.source_id)) return <text fg={theme.textMuted}>{"· "}</text>
                        return <text fg={theme.textMuted}>{"  "}</text>
                      })()}
                    </box>
                    <box width={2} flexShrink={0}><text fg={isSelected() ? theme.primary : itemIsRecent() ? theme.text : theme.textMuted}>{sourceChar(item.source)} </text></box>
                    <box width={8} flexShrink={0}><text fg={isSelected() ? theme.primary : itemIsRecent() ? theme.text : theme.textMuted}>{formatTimestamp(item.last_event_ts)}</text></box>
                    <box flexGrow={1}><text fg={isSelected() ? theme.primary : itemIsRecent() ? theme.text : theme.textMuted} attributes={isSelected() ? TextAttributes.BOLD : itemIsRecent() ? TextAttributes.BOLD : TextAttributes.DIM}>{itemIsRecent() ? "● " : ""}{hasTriage() ? "◆ " : ""}{item.title.length > maxTitleWidth() ? item.title.slice(0, maxTitleWidth() - 1) + "…" : item.title}</text></box>
                    <box width={14} flexShrink={0}><text fg={isSelected() ? theme.primary : itemIsRecent() ? theme.text : theme.textMuted}>{(item.actor ?? "").length > 12 ? (item.actor ?? "").slice(0, 11) + "…" : (item.actor ?? "")}</text></box>
                  </box>
                  <box height={1} flexDirection="row" paddingLeft={paddingLeft + indent}>
                    {(() => {
                      const result = itemResult()
                      if (result?.status === "done" && result.summary) {
                        const stateText = truncate(`State: ${result.summary}`, indent)
                        return <text fg={isSelected() ? theme.primary : urgencyColor(itemUrgency(), theme)}>{stateText}</text>
                      }
                      if (result?.status === "running") {
                        return <text fg={isSelected() ? theme.primary : theme.textMuted}>{spinnerFrames[spinnerFrame()]}{" Analyzing ("}{formatElapsed(getElapsedMs(item.source_id))}{")..."}</text>
                      }
                      if (result?.status === "error") {
                        return <text fg={isSelected() ? theme.primary : theme.error}>{truncate(`✗ ${result.summary}`, indent)}</text>
                      }
                      if (isQueued(item.source_id)) {
                        return <text fg={isSelected() ? theme.primary : theme.textMuted}>{"Queued for analysis"}</text>
                      }
                      return <text fg={isSelected() ? theme.primary : theme.textMuted} attributes={isSelected() ? undefined : itemIsRecent() ? undefined : TextAttributes.DIM}>{truncate(`${item.event_type}${item.summary ? `: ${item.summary}` : ""}`, indent)}</text>
                    })()}
                  </box>
                  <Show when={itemAnalyzed() && itemResult()?.recommendedAction}>
                    <box height={1} flexDirection="row" paddingLeft={paddingLeft + indent}>
                      <text fg={isSelected() ? theme.primary : theme.textMuted} attributes={TextAttributes.DIM}>{truncate(`→ ${itemResult()!.recommendedAction!}`, indent)}</text>
                    </box>
                  </Show>
                  <box height={1} />
                </box>
              )
            }}
          </For>
        </box>
        <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"j/k select  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"enter triage  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"d dismiss  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"r re-eval  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"/ search  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"s sort  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"c collapse  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"+/- workers"}</text>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  registerTab({ key: 2, label: "Needs Me", order: 200, render: () => <NeedsMeView api={api} /> })
  initPool(api)
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
