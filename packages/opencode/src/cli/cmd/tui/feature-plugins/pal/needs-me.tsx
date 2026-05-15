import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, onMount, onCleanup, For, Show } from "solid-js"
import { Database } from "@/storage/db"
import { DismissedEventTable, SuppressionPatternTable } from "@/needs-me/needs-me.sql"
import { eq, and, gt, sql } from "drizzle-orm"
import { SNOOZE_DURATIONS, type SnoozeDuration } from "@/needs-me"
import { Identifier } from "@/id/id"
import { TextAttributes } from "@opentui/core"
import { registerTab } from "@tui/pal/tab-registry"
import { recordTriageDecision } from "@/needs-me/decisions"
import { getSweepResults } from "@/sweep/sweep"
import { get as getRole } from "@/config/role"
import { load as loadProcessDoc } from "@/process/process-doc"

const id = "internal:pal-needs-me"
const REFRESH_INTERVAL_MS = 30_000
const OVERFLOW_THRESHOLD = 20
const OVERFLOW_SUSTAIN_MS = 2 * 60 * 60 * 1000
const AUTO_SUPPRESS_THRESHOLD = 3
const SUPPRESSION_DECAY_MS = 30 * 24 * 60 * 60 * 1000

type SweepResult = {
  source_id: string
  source: string
  title: string
  summary: string
  action: string
  priority: string
  phase: string | null
  url: string | null
  actor: string | null
  last_event_ts: number
  swept_at: number
  feed: string | null
  mode: string | null
}

function formatTimestamp(ts: number): string {
  const now = Date.now(); const diff = now - ts
  if (diff < 60_000) return "just now"; if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`; if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  const date = new Date(ts); return `${date.getMonth() + 1}/${date.getDate()}`
}
function formatLastChecked(ts: number | null): string { return ts === null ? "never" : formatTimestamp(ts) }

function priorityColor(priority: string, theme: any): string {
  switch (priority) {
    case "urgent": return theme.error ?? theme.primary
    case "soon": return theme.warning ?? theme.primary
    case "normal": return theme.info ?? theme.primary
    case "low": return theme.textMuted
    default: return theme.textMuted
  }
}

function getDismissedKeys(): Set<string> {
  try { return Database.use((db) => { const rows = db.select({ work_item_key: DismissedEventTable.work_item_key }).from(DismissedEventTable).where(eq(DismissedEventTable.action, "dismiss")).all(); return new Set(rows.map((r) => r.work_item_key)) }) } catch { return new Set() }
}
function getSnoozedKeys(): Map<string, number> {
  try { const now = Date.now(); return Database.use((db) => { const rows = db.select({ work_item_key: DismissedEventTable.work_item_key, snooze_until: DismissedEventTable.snooze_until }).from(DismissedEventTable).where(and(eq(DismissedEventTable.action, "snooze"), gt(DismissedEventTable.snooze_until, now))).all(); const map = new Map<string, number>(); for (const r of rows) { if (r.snooze_until) map.set(r.work_item_key, r.snooze_until) }; return map }) } catch { return new Map() }
}

function computeFilteredQueue(): SweepResult[] {
  const results = getSweepResults()
  const dismissed = getDismissedKeys()
  const snoozed = getSnoozedKeys()
  return results.filter((item) => {
    if (dismissed.has(item.source_id)) return false
    if (snoozed.has(item.source_id)) return false
    return true
  })
}

function NeedsMeView(props: { api: TuiPluginApi }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [queue, setQueue] = createSignal<SweepResult[]>([])
  const [lastChecked, setLastChecked] = createSignal<number | null>(null)
  const [overflowAlert, setOverflowAlert] = createSignal(false)
  const [overflowSince, setOverflowSince] = createSignal<number | null>(null)
  const [scrollOffset, setScrollOffset] = createSignal(0)
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  // Track triage sessions: source_id -> sessionID
  const triageSessionMap = new Map<string, string>()

  function refresh() {
    const items = computeFilteredQueue(); setQueue(items); setLastChecked(Date.now())
    const now = Date.now()
    if (items.length > OVERFLOW_THRESHOLD) {
      const since = overflowSince()
      if (since === null) { setOverflowSince(now); setOverflowAlert(false) }
      else if (now - since >= OVERFLOW_SUSTAIN_MS) { setOverflowAlert(true) }
    } else { setOverflowSince(null); setOverflowAlert(false) }
    // Clamp selectedIndex to new queue bounds
    if (items.length > 0 && selectedIndex() >= items.length) {
      setSelectedIndex(items.length - 1)
    }
  }

  function handleDismiss(item: SweepResult) {
    const ruleSource = `sweep:${item.source}:${item.priority}`
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
  function handleSnooze(item: SweepResult, duration: SnoozeDuration) {
    const ruleSource = `sweep:${item.source}:${item.priority}`
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

  async function launchTriageSession(item: SweepResult) {
    // Resume existing triage session if one exists for this item
    const existingSessionID = triageSessionMap.get(item.source_id)
    if (existingSessionID) {
      props.api.route.navigate("session", { sessionID: existingSessionID })
      return
    }

    // Create new session
    const phaseSuffix = item.phase ? ` [${item.phase}]` : ""
    const result = await props.api.client.session.create({
      title: `Triage${phaseSuffix}: ${item.title.slice(0, 50)}`,
    })
    if (!result.data?.id) return

    const sessionID = result.data.id
    triageSessionMap.set(item.source_id, sessionID)

    // Load process doc and role for context
    const processDoc = loadProcessDoc() ?? "No process document configured."
    const role = getRole() ?? "No role configured."

    // Send initial context
    await props.api.client.session.prompt({
      sessionID,
      parts: [{
        type: "text" as const,
        text: `Process context from your team's process document:
${processDoc}

Your role: ${role}

Issue: ${item.title}
URL: ${item.url ?? "none"}
Current state: ${item.summary}
Recommended action: ${item.action}

Help me take this action. Fetch the full issue details first.`,
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

    const items = queue()
    if (items.length === 0) return

    const name = evt.name ?? ""

    // Up / k: move selection up
    if (name === "up" || name === "k") {
      evt.preventDefault()
      setSelectedIndex((idx) => Math.max(0, idx - 1))
      // Adjust scroll to keep selection visible
      const idx = selectedIndex()
      const offset = scrollOffset()
      if (idx < offset) setScrollOffset(idx)
      return
    }

    // Down / j: move selection down
    if (name === "down" || name === "j") {
      evt.preventDefault()
      setSelectedIndex((idx) => Math.min(items.length - 1, idx + 1))
      // Adjust scroll to keep selection visible
      const idx = selectedIndex()
      const offset = scrollOffset()
      const vh = visibleHeight()
      // Each item takes 3 rows (title + summary + action)
      if (idx >= offset + vh) setScrollOffset(idx - vh + 1)
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
  })

  onMount(() => refresh())
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  onMount(() => { refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS) })
  onCleanup(() => { if (refreshTimer) clearInterval(refreshTimer) })

  const visibleHeight = () => {
    // Each item takes 3 rows, header takes 3 rows, footer takes 1 row, overflow alert takes 1 row (optional)
    const headerRows = overflowAlert() ? 4 : 3
    const footerRows = 1
    const availableRows = Math.max(dimensions().height - headerRows - footerRows, 3)
    return Math.floor(availableRows / 3)
  }
  const visibleItems = () => {
    const all = queue(); const offset = scrollOffset()
    if (overflowAlert() && all.length > OVERFLOW_THRESHOLD) { const pinned = all.slice(0, 10); const rest = all.slice(10); return { pinned, collapsed: rest, collapsedCount: rest.length } }
    return { pinned: all.slice(offset, offset + visibleHeight()), collapsed: [], collapsedCount: 0 }
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
        <box width={6} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Prty</text></box>
        <box width={8} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Phase</text></box>
        <box width={8} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Time</text></box>
        <box flexGrow={1}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Title</text></box>
        <box width={14} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Actor</text></box>
      </box>
      <Show when={queue().length > 0} fallback={
        <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
          <text fg={theme.textMuted}>Nothing needs you right now</text>
          <box height={1} />
          <text fg={theme.textMuted}>{"Last checked: "}{formatLastChecked(lastChecked())}</text>
        </box>
      }>
        <box flexGrow={1} flexDirection="column" overflow="hidden">
          <For each={visibleItems().pinned}>
            {(item, index) => {
              const pc = () => priorityColor(item.priority, theme)
              const maxTitleWidth = () => Math.max(dimensions().width - 40, 10)
              const isSelected = () => {
                const offset = scrollOffset()
                return index() + offset === selectedIndex()
              }
              const hasTriage = () => triageSessionMap.has(item.source_id)
              return (
                <box flexDirection="column" backgroundColor={isSelected() ? theme.backgroundElement : undefined}>
                  <box height={1} flexDirection="row" paddingLeft={1}>
                    <box width={2} flexShrink={0}><text fg={isSelected() ? theme.primary : theme.textMuted}>{isSelected() ? "> " : "  "}</text></box>
                    <box width={6} flexShrink={0}><text fg={pc()} attributes={TextAttributes.BOLD}>{item.priority.padEnd(6)}</text></box>
                    <box width={8} flexShrink={0}><text fg={theme.textMuted}>{(item.phase ?? "—").padEnd(8).slice(0, 8)}</text></box>
                    <box width={8} flexShrink={0}><text fg={theme.textMuted}>{formatTimestamp(item.last_event_ts)}</text></box>
                    <box flexGrow={1}><text fg={theme.text}>{hasTriage() ? "● " : ""}{item.title.length > maxTitleWidth() ? item.title.slice(0, maxTitleWidth() - 1) + "…" : item.title}</text></box>
                    <box width={14} flexShrink={0}><text fg={theme.textMuted}>{(item.actor ?? "").length > 12 ? (item.actor ?? "").slice(0, 11) + "…" : (item.actor ?? "")}</text></box>
                  </box>
                  <box height={1} flexDirection="row" paddingLeft={10}>
                    <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{item.summary}</text>
                  </box>
                  <box height={1} flexDirection="row" paddingLeft={10}>
                    <text fg={pc()}>{item.action}</text>
                  </box>
                </box>
              )
            }}
          </For>
          <Show when={visibleItems().collapsedCount > 0}>
            <box height={1} paddingLeft={1}>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"... and "}{visibleItems().collapsedCount}{" more items (collapsed)"}</text>
            </box>
          </Show>
        </box>
        <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"j/k ↑/↓ select  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"enter triage  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"d dismiss"}</text>
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
