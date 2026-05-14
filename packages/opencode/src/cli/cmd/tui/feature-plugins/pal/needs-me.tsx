import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, onMount, onCleanup, For, Show } from "solid-js"
import { Database } from "@/storage/db"
import { ActivityEventTable } from "@/activity-feed/activity-feed.sql"
import { DismissedEventTable, SuppressionPatternTable } from "@/needs-me/needs-me.sql"
import { desc, eq, and, gt, sql } from "drizzle-orm"
import type { ActivityEvent } from "@/activity-feed/types"
import { classify, type NeedsMeItem, type NeedsMeConfig } from "@/needs-me/classifier"
import { SNOOZE_DURATIONS, type SnoozeDuration } from "@/needs-me"
import { Identifier } from "@/id/id"
import { TextAttributes } from "@opentui/core"
import { registerTab } from "@tui/pal/tab-registry"
import { recordTriageDecision } from "@/needs-me/decisions"

const id = "internal:pal-needs-me"
const REFRESH_INTERVAL_MS = 30_000
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
function tierBadge(tier: 1 | 2): string { return tier === 1 ? "T1" : "T2" }
function sourceBadges(sources: string[]): string {
  return sources.map((s) => { switch (s) { case "jira": return "J"; case "github": return "G"; case "gitlab": return "L"; default: return "?" } }).join("")
}
function scoreColor(score: number, theme: any): string {
  if (score >= 60) return theme.error ?? theme.primary; if (score >= 35) return theme.warning ?? theme.primary; return theme.info ?? theme.primary
}

function loadRecentEvents(): ActivityEvent[] {
  try { return Database.use((db) => db.select().from(ActivityEventTable).orderBy(desc(ActivityEventTable.timestamp)).limit(500).all() as ActivityEvent[]) } catch { return [] }
}
function getDismissedKeys(): Set<string> {
  try { return Database.use((db) => { const rows = db.select({ work_item_key: DismissedEventTable.work_item_key }).from(DismissedEventTable).where(eq(DismissedEventTable.action, "dismiss")).all(); return new Set(rows.map((r) => r.work_item_key)) }) } catch { return new Set() }
}
function getSnoozedKeys(): Map<string, number> {
  try { const now = Date.now(); return Database.use((db) => { const rows = db.select({ work_item_key: DismissedEventTable.work_item_key, snooze_until: DismissedEventTable.snooze_until }).from(DismissedEventTable).where(and(eq(DismissedEventTable.action, "snooze"), gt(DismissedEventTable.snooze_until, now))).all(); const map = new Map<string, number>(); for (const r of rows) { if (r.snooze_until) map.set(r.work_item_key, r.snooze_until) }; return map }) } catch { return new Map() }
}
function getSuppressedRuleSources(): Set<string> {
  try { const cutoff = Date.now() - SUPPRESSION_DECAY_MS; return Database.use((db) => { const rows = db.select({ rule_source: SuppressionPatternTable.rule_source }).from(SuppressionPatternTable).where(gt(SuppressionPatternTable.last_matched_at, cutoff)).all(); return new Set(rows.map((r) => r.rule_source)) }) } catch { return new Set() }
}
function insertDismissal(workItemKey: string, ruleSource: string, action: "dismiss" | "snooze", snoozeUntil: number | null): void {
  try { Database.use((db) => { db.insert(DismissedEventTable).values({ id: Identifier.create("nmd", "ascending"), work_item_key: workItemKey, action, snooze_until: snoozeUntil, rule_source: ruleSource, dismissed_at: Date.now() }).run() }) } catch {}
}
function countDismissalsForRuleSource(ruleSource: string): number {
  try { return Database.use((db) => { const result = db.select({ count: sql<number>`count(*)` }).from(DismissedEventTable).where(and(eq(DismissedEventTable.rule_source, ruleSource), eq(DismissedEventTable.action, "dismiss"))).get(); return result?.count ?? 0 }) } catch { return 0 }
}
function upsertSuppression(ruleSource: string, dismissCount: number): void {
  const now = Date.now()
  try { Database.use((db) => { db.insert(SuppressionPatternTable).values({ id: Identifier.create("nms", "ascending"), rule_source: ruleSource, dismiss_count: dismissCount, created_at: now, last_matched_at: now }).onConflictDoUpdate({ target: SuppressionPatternTable.rule_source, set: { dismiss_count: dismissCount, last_matched_at: now } }).run() }) } catch {}
}
function detectProcessGaps(events: ActivityEvent[]): NeedsMeItem[] {
  const seen = new Set<string>()
  const gaps: NeedsMeItem[] = []
  for (const event of events) {
    if (event.source !== "jira") continue
    if (event.mode === "watch") continue
    if (seen.has(event.source_id)) continue
    seen.add(event.source_id)

    const meta = event.metadata as Record<string, unknown> | undefined
    if (!meta) continue
    const issueType = meta.issue_type as string | undefined
    const description = meta.description as string | undefined
    if (!issueType) continue

    const hasProblem = description && /h[23]\.\s*Problem\s+Statement/i.test(description)
    const hasScope = description && /h2\.\s*Scope\s+of\s+Work/i.test(description)
    const isEpic = issueType === "Epic"

    let rule = ""
    let need = ""
    let score = 0
    if (!hasProblem) {
      rule = "process_needs_problem"
      need = "Write statement"
      score = 30
    } else if (isEpic && !hasScope) {
      rule = "process_needs_scope"
      need = "Write scope"
      score = 25
    } else {
      continue
    }

    gaps.push({
      id: `process_${event.source_id}`,
      workItemKey: event.source_id,
      tier: 2 as 1 | 2,
      rule,
      ruleSource: `${rule}:jira`,
      score,
      scoreBreakdown: `process:${need}`,
      title: event.title,
      url: event.url,
      actor: event.actor,
      timestamp: event.timestamp,
      sources: ["jira"],
      eventIds: [event.id],
      isBlocking: false,
      domains: [],
      isExemptFromSuppression: false,
      metadata: meta ?? null,
    })
  }
  return gaps
}

function computeFilteredQueue(config: NeedsMeConfig): NeedsMeItem[] {
  const events = loadRecentEvents()
  const { items } = classify(events, config)
  const processGaps = detectProcessGaps(events)
  const allItems = [...items, ...processGaps].sort((a, b) => b.score - a.score)
  const dismissed = getDismissedKeys(); const snoozed = getSnoozedKeys(); const suppressed = getSuppressedRuleSources()
  return allItems.filter((item) => { if (dismissed.has(item.workItemKey)) return false; if (snoozed.has(item.workItemKey)) return false; if (suppressed.has(item.ruleSource) && !item.isExemptFromSuppression) return false; return true })
}

function NeedsMeView(props: { api: TuiPluginApi }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [queue, setQueue] = createSignal<NeedsMeItem[]>([])
  const [lastChecked, setLastChecked] = createSignal<number | null>(null)
  const [overflowAlert, setOverflowAlert] = createSignal(false)
  const [overflowSince, setOverflowSince] = createSignal<number | null>(null)
  const [scrollOffset, setScrollOffset] = createSignal(0)
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const config: NeedsMeConfig = {}

  // Track triage sessions: workItemKey -> sessionID
  const triageSessionMap = new Map<string, string>()

  function refresh() {
    const items = computeFilteredQueue(config); setQueue(items); setLastChecked(Date.now())
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

  function handleDismiss(item: NeedsMeItem) {
    insertDismissal(item.workItemKey, item.ruleSource, "dismiss", null)
    recordTriageDecision(item, "dismiss")
    const count = countDismissalsForRuleSource(item.ruleSource)
    if (count >= AUTO_SUPPRESS_THRESHOLD) upsertSuppression(item.ruleSource, count)
    refresh()
  }
  function handleSnooze(item: NeedsMeItem, duration: SnoozeDuration) {
    const snoozeUntil = Date.now() + SNOOZE_DURATIONS[duration]
    insertDismissal(item.workItemKey, item.ruleSource, "snooze", snoozeUntil); refresh()
  }
  void handleSnooze

  async function launchTriageSession(item: NeedsMeItem) {
    // Resume existing triage session if one exists for this item
    const existingSessionID = triageSessionMap.get(item.workItemKey)
    if (existingSessionID) {
      props.api.route.navigate("session", { sessionID: existingSessionID })
      return
    }

    // Create new session
    const result = await props.api.client.session.create({
      title: `Triage: ${item.title.slice(0, 50)}`,
    })
    if (!result.data?.id) return

    const sessionID = result.data.id
    triageSessionMap.set(item.workItemKey, sessionID)

    // Build decision history context
    let history = ""
    try {
      const rows = Database.use((db) => {
        return (db as any).all(
          `SELECT action, action_detail, decided_at FROM needs_me_triage_decision WHERE rule_source = ? ORDER BY decided_at DESC LIMIT 5`,
          item.ruleSource,
        )
      })
      if (rows && rows.length > 0) {
        const lines = rows.map((r: any) => `- ${r.action}${r.action_detail ? ` (${r.action_detail})` : ""}`)
        history = `\n\nPast decisions for similar items (${item.ruleSource}):\n${lines.join("\n")}`
      }
    } catch {}

    recordTriageDecision(item, "triage_started", undefined, sessionID)

    // Send initial context
    await props.api.client.session.prompt({
      sessionID,
      parts: [{
        type: "text" as const,
        text: `Triage this item from my Needs Me queue:

Title: ${item.title}
Source: ${item.sources.join(", ")}
Score: ${item.score} (${item.scoreBreakdown})
Tier: ${item.tier} | Rule: ${item.rule}
Blocking: ${item.isBlocking}
URL: ${item.url ?? "none"}
Actor: ${item.actor ?? "unknown"}${history}

Please fetch the full details and tell me what action is needed.`,
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
      // Each item takes 2 rows (title + breakdown)
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

  const visibleHeight = () => Math.max(dimensions().height - 6, 1)
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
        <box width={5} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Score</text></box>
        <box width={4} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Tier</text></box>
        <box width={4} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Src</text></box>
        <box width={8} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Time</text></box>
        <box flexGrow={1}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Title / Score Breakdown</text></box>
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
              const sc = () => scoreColor(item.score, theme)
              const maxTitleWidth = () => Math.max(dimensions().width - 40, 10)
              const isSelected = () => {
                const offset = scrollOffset()
                return index() + offset === selectedIndex()
              }
              const hasTriage = () => triageSessionMap.has(item.workItemKey)
              return (
                <box flexDirection="column" backgroundColor={isSelected() ? theme.backgroundElement : undefined}>
                  <box height={1} flexDirection="row" paddingLeft={1}>
                    <box width={2} flexShrink={0}><text fg={isSelected() ? theme.primary : theme.textMuted}>{isSelected() ? "> " : "  "}</text></box>
                    <box width={5} flexShrink={0}><text fg={sc()} attributes={TextAttributes.BOLD}>{String(item.score).padStart(3)}</text></box>
                    <box width={4} flexShrink={0}><text fg={item.tier === 1 ? (theme.warning ?? theme.primary) : theme.textMuted}>{tierBadge(item.tier)}</text></box>
                    <box width={4} flexShrink={0}><text fg={theme.primary} attributes={TextAttributes.BOLD}>{sourceBadges(item.sources)}</text></box>
                    <box width={8} flexShrink={0}><text fg={theme.textMuted}>{formatTimestamp(item.timestamp)}</text></box>
                    <box flexGrow={1}><text fg={item.isBlocking ? (theme.error ?? theme.text) : theme.text}>{hasTriage() ? "● " : ""}{item.title.length > maxTitleWidth() ? item.title.slice(0, maxTitleWidth() - 1) + "…" : item.title}</text></box>
                    <box width={14} flexShrink={0}><text fg={theme.textMuted}>{(item.actor ?? "").length > 12 ? (item.actor ?? "").slice(0, 11) + "…" : (item.actor ?? "")}</text></box>
                  </box>
                  <box height={1} flexDirection="row" paddingLeft={8}>
                    <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{item.scoreBreakdown}</text>
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
