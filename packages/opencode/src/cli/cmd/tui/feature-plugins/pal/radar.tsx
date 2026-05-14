import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, onMount, onCleanup, For, Show } from "solid-js"
import { Database } from "@/storage/db"
import { ActivityEventTable } from "@/activity-feed/activity-feed.sql"
import { desc, isNotNull } from "drizzle-orm"
import type { ActivityEvent, ActivitySource } from "@/activity-feed/types"
import type { RelevanceLevel } from "@/upstream-relevance/types"
import { TextAttributes } from "@opentui/core"
import { registerTab } from "@tui/pal/tab-registry"

const id = "internal:pal-radar"
const REFRESH_INTERVAL_MS = 30_000
const MAX_EVENTS = 500

/** Priority order for relevance levels (lower = higher priority) */
const RELEVANCE_PRIORITY: Record<RelevanceLevel, number> = {
  "must-act": 0,
  review: 1,
  watch: 2,
  noise: 3,
}

function relevanceBadge(level: RelevanceLevel): string {
  switch (level) {
    case "must-act": return "!!!"
    case "review": return " ! "
    case "watch": return " ~ "
    case "noise": return " . "
  }
}

function relevanceColor(level: RelevanceLevel, theme: any): string {
  switch (level) {
    case "must-act": return theme.error ?? "#ff0000"
    case "review": return theme.warning ?? "#ffaa00"
    case "watch": return theme.info ?? theme.primary
    case "noise": return theme.textMuted
  }
}

function relevanceAttributes(level: RelevanceLevel): number {
  switch (level) {
    case "must-act": return TextAttributes.BOLD
    case "review": return 0
    case "watch": return TextAttributes.DIM
    case "noise": return TextAttributes.DIM
  }
}

function feedLabel(source: ActivitySource | string): string {
  switch (source) {
    case "github":
    case "gitlab":
      return "Upstream"
    case "jira":
      return "Jira"
    default:
      return source
  }
}

function sourceIcon(source: ActivitySource | string): string {
  switch (source) {
    case "jira": return "J"
    case "github": return "G"
    case "gitlab": return "L"
    default: return "?"
  }
}

function formatTimestamp(ts: number): string {
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  const date = new Date(ts)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function formatLastChecked(ts: number | null): string {
  return ts === null ? "never" : formatTimestamp(ts)
}

interface RadarItem {
  event: ActivityEvent
  relevance: RelevanceLevel
}

function loadWatchedEvents(): RadarItem[] {
  try {
    const events = Database.use((db) =>
      db
        .select()
        .from(ActivityEventTable)
        .where(isNotNull(ActivityEventTable.relevance))
        .orderBy(desc(ActivityEventTable.timestamp))
        .limit(MAX_EVENTS)
        .all() as ActivityEvent[],
    )

    const items: RadarItem[] = events
      .filter((e) => e.relevance !== null)
      .map((e) => ({
        event: e,
        relevance: e.relevance as RelevanceLevel,
      }))

    // Sort by relevance priority first, then by timestamp (newest first)
    items.sort((a, b) => {
      const pa = RELEVANCE_PRIORITY[a.relevance] ?? 99
      const pb = RELEVANCE_PRIORITY[b.relevance] ?? 99
      if (pa !== pb) return pa - pb
      return b.event.timestamp - a.event.timestamp
    })

    return items
  } catch {
    return []
  }
}

function RadarView() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [items, setItems] = createSignal<RadarItem[]>([])
  const [lastChecked, setLastChecked] = createSignal<number | null>(null)
  const [showNoise, setShowNoise] = createSignal(false)

  function refresh() {
    setItems(loadWatchedEvents())
    setLastChecked(Date.now())
  }

  onMount(() => refresh())
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  onMount(() => { refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS) })
  onCleanup(() => { if (refreshTimer) clearInterval(refreshTimer) })

  const nonNoiseItems = () => items().filter((i) => i.relevance !== "noise")
  const noiseItems = () => items().filter((i) => i.relevance === "noise")
  const noiseCount = () => noiseItems().length
  const displayItems = () => showNoise() ? items() : nonNoiseItems()

  const visibleHeight = () => Math.max(dimensions().height - 5, 1)
  const visibleItems = () => {
    const all = displayItems()
    return all.slice(0, visibleHeight())
  }

  return (
    <box width={dimensions().width} flexGrow={1} flexDirection="column">
      {/* Header */}
      <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>Radar</text>
        <text fg={theme.textMuted}>{" ("}{items().length}{" items)"}</text>
        <box flexGrow={1} />
        <text fg={theme.textMuted}>{"Last checked: "}{formatLastChecked(lastChecked())}</text>
        <box width={1} />
      </box>

      {/* Column headers */}
      <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
        <box width={5} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Rel</text></box>
        <box width={10} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Feed</text></box>
        <box width={10} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Time</text></box>
        <box width={4} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Src</text></box>
        <box flexGrow={1}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Title / Summary</text></box>
        <box width={14} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Actor</text></box>
      </box>

      {/* Content */}
      <Show when={items().length > 0} fallback={
        <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
          <text fg={theme.textMuted}>No watched items on the radar</text>
          <box height={1} />
          <text fg={theme.textMuted}>{"Last checked: "}{formatLastChecked(lastChecked())}</text>
        </box>
      }>
        <box flexGrow={1} flexDirection="column" overflow="hidden">
          <For each={visibleItems()}>
            {(item) => {
              const rel = () => item.relevance
              const relColor = () => relevanceColor(rel(), theme)
              const relAttrs = () => relevanceAttributes(rel())
              const fg = () => rel() === "noise" ? theme.textMuted : theme.text
              const maxTitleWidth = () => Math.max(dimensions().width - 46, 10)
              return (
                <box height={1} flexDirection="row" paddingLeft={1}>
                  <box width={5} flexShrink={0}>
                    <text fg={relColor()} attributes={relAttrs()}>{relevanceBadge(rel())}</text>
                  </box>
                  <box width={10} flexShrink={0}>
                    <text fg={rel() === "noise" ? theme.textMuted : theme.text} attributes={rel() === "noise" ? TextAttributes.DIM : 0}>
                      {feedLabel(item.event.source)}
                    </text>
                  </box>
                  <box width={10} flexShrink={0}>
                    <text fg={theme.textMuted}>{formatTimestamp(item.event.timestamp)}</text>
                  </box>
                  <box width={4} flexShrink={0}>
                    <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                      {sourceIcon(item.event.source)}
                    </text>
                  </box>
                  <box flexGrow={1}>
                    <text fg={fg()} attributes={rel() === "must-act" ? TextAttributes.BOLD : (rel() === "noise" ? TextAttributes.DIM : 0)}>
                      {item.event.title.length > maxTitleWidth()
                        ? item.event.title.slice(0, maxTitleWidth() - 1) + "…"
                        : item.event.title}
                    </text>
                  </box>
                  <box width={14} flexShrink={0}>
                    <text fg={theme.textMuted}>
                      {(item.event.actor ?? "").length > 12
                        ? (item.event.actor ?? "").slice(0, 11) + "…"
                        : (item.event.actor ?? "")}
                    </text>
                  </box>
                </box>
              )
            }}
          </For>

          {/* Collapsed noise items */}
          <Show when={!showNoise() && noiseCount() > 0}>
            <box height={1} paddingLeft={1}>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
                {"... and "}{noiseCount()}{" noise items"}
              </text>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async () => {
  registerTab({ key: 5, label: "Radar", order: 500, render: () => <RadarView /> })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
