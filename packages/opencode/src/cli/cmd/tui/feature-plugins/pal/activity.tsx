/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, onMount, onCleanup, For, Show } from "solid-js"
import { Database } from "@/storage/db"
import { ActivityEventTable } from "@/activity-feed/activity-feed.sql"
import { desc, eq } from "drizzle-orm"
import type { ActivityEvent, ActivitySource, ActorType, ActivityEventType } from "@/activity-feed/types"
import { TextAttributes } from "@opentui/core"
import type { RelevanceLevel } from "@/upstream-relevance/types"
import { registerTab } from "@tui/pal/tab-registry"
import { ActivityFeed } from "@/activity-feed"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"

const id = "internal:pal-activity"
const PAGE_SIZE = 50

function sourceIcon(source: ActivitySource): string {
  switch (source) {
    case "jira": return "J"
    case "github": return "G"
    case "gitlab": return "L"
    default: return "?"
  }
}

function eventTypeBadge(eventType: ActivityEventType): string {
  switch (eventType) {
    case "issue_created": return "NEW"
    case "status_changed": return "STS"
    case "assigned": return "ASG"
    case "commented": return "CMT"
    case "priority_changed": return "PRI"
    case "blocked": return "BLK"
    case "field_updated": return "UPD"
    default: return "???"
  }
}

function eventTypeColor(eventType: ActivityEventType, theme: any): string {
  switch (eventType) {
    case "issue_created": return theme.success ?? theme.primary
    case "status_changed": return theme.info ?? theme.primary
    case "assigned": return theme.warning ?? theme.primary
    case "commented": return theme.textMuted
    case "priority_changed": return theme.warning ?? theme.primary
    case "blocked": return theme.error ?? theme.primary
    case "field_updated": return theme.textMuted
    default: return theme.textMuted
  }
}

function relevanceBadge(level: RelevanceLevel | null | undefined): string {
  switch (level) {
    case "must-act": return "!!!"
    case "review": return " ! "
    case "watch": return " ~ "
    case "noise": return " . "
    default: return "   "
  }
}

function relevanceColor(level: RelevanceLevel | null | undefined, theme: any): string {
  switch (level) {
    case "must-act": return theme.error ?? "#ff0000"
    case "review": return theme.warning ?? "#ffaa00"
    case "watch": return theme.info ?? theme.primary
    case "noise": return theme.textMuted
    default: return theme.textMuted
  }
}

function isUpstreamSource(source: string): boolean {
  return source === "github" || source === "gitlab"
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

function loadEvents(actorTypeFilter?: ActorType): ActivityEvent[] {
  try {
    return Database.use((db) => {
      const query = db.select().from(ActivityEventTable)
      if (actorTypeFilter) {
        return query.where(eq(ActivityEventTable.actor_type, actorTypeFilter)).orderBy(desc(ActivityEventTable.timestamp)).limit(PAGE_SIZE).all() as ActivityEvent[]
      }
      return query.orderBy(desc(ActivityEventTable.timestamp)).limit(PAGE_SIZE).all() as ActivityEvent[]
    })
  } catch {
    return []
  }
}

type ActorTypeFilter = "all" | ActorType
const ACTOR_TYPE_FILTERS: ActorTypeFilter[] = ["all", "human", "agent"]

function actorTypeBadge(actorType: ActorType | string): string {
  switch (actorType) {
    case "agent": return "BOT"
    case "system": return "SYS"
    case "human": return "   "
    default: return "   "
  }
}

function ActivityView() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [events, setEvents] = createSignal<ActivityEvent[]>([])
  const [scrollOffset, setScrollOffset] = createSignal(0)
  const [actorFilter, setActorFilter] = createSignal<ActorTypeFilter>("all")

  function cycleActorFilter() {
    const current = actorFilter()
    const idx = ACTOR_TYPE_FILTERS.indexOf(current)
    setActorFilter(ACTOR_TYPE_FILTERS[(idx + 1) % ACTOR_TYPE_FILTERS.length])
    refresh()
  }

  function refresh() {
    const filter = actorFilter()
    setEvents(loadEvents(filter === "all" ? undefined : filter))
  }

  onMount(() => refresh())

  let refreshTimer: ReturnType<typeof setInterval> | undefined
  onMount(() => { refreshTimer = setInterval(refresh, 30_000) })
  onCleanup(() => { if (refreshTimer) clearInterval(refreshTimer) })

  const visibleHeight = () => Math.max(dimensions().height - 4, 1)
  const visibleEvents = () => {
    const all = events()
    const offset = scrollOffset()
    return all.slice(offset, offset + visibleHeight())
  }

  return (
    <box width={dimensions().width} flexGrow={1} flexDirection="column">
      <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>Activity Feed</text>
        <text fg={theme.textMuted}> ({events().length} events)</text>
        <text fg={theme.textMuted}>{"  |  "}</text>
        <text fg={theme.textMuted}>Actor: </text>
        <For each={ACTOR_TYPE_FILTERS}>
          {(filter) => (
            <text fg={actorFilter() === filter ? theme.primary : theme.textMuted} attributes={actorFilter() === filter ? TextAttributes.BOLD : 0}>
              {` ${filter === "all" ? "All" : filter === "human" ? "Human" : "Agent"} `}
            </text>
          )}
        </For>
      </box>
      <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
        <box width={8} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Time</text></box>
        <box width={3} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Src</text></box>
        <box width={5} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Type</text></box>
        <box width={5} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Who</text></box>
        <box width={5} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Rel</text></box>
        <box flexGrow={1}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Title / Summary</text></box>
        <box width={16} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Actor</text></box>
      </box>
      <Show when={events().length > 0} fallback={
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>No activity events yet. Events will appear after the first poll cycle.</text>
        </box>
      }>
        <box flexGrow={1} flexDirection="column" overflow="hidden">
          <For each={visibleEvents()}>
            {(event) => {
              const isUnread = () => event.is_read === 0
              const fg = () => (isUnread() ? theme.text : theme.textMuted)
              const badgeColor = () => eventTypeColor(event.event_type as ActivityEventType, theme)
              const relLevel = () => event.relevance as RelevanceLevel | null
              const relColor = () => relevanceColor(relLevel(), theme)
              const showRelevance = () => isUpstreamSource(event.source)
              const maxTitleWidth = () => Math.max(dimensions().width - 40, 10)

              return (
                <box height={1} flexDirection="row" paddingLeft={1}>
                  <box width={8} flexShrink={0}><text fg={theme.textMuted}>{formatTimestamp(event.timestamp)}</text></box>
                  <box width={3} flexShrink={0}><text fg={theme.primary} attributes={TextAttributes.BOLD}>{sourceIcon(event.source as ActivitySource)}</text></box>
                  <box width={5} flexShrink={0}><text fg={badgeColor()}>{eventTypeBadge(event.event_type as ActivityEventType)}</text></box>
                  <box width={5} flexShrink={0}>
                    <text fg={event.actor_type === "agent" ? (theme.warning ?? theme.primary) : theme.textMuted} attributes={event.actor_type === "agent" ? TextAttributes.BOLD : 0}>
                      {actorTypeBadge(event.actor_type ?? "human")}
                    </text>
                  </box>
                  <box width={5} flexShrink={0}>
                    <Show when={showRelevance()}>
                      <text fg={relColor()} attributes={relLevel() === "must-act" ? TextAttributes.BOLD : 0}>{relevanceBadge(relLevel())}</text>
                    </Show>
                  </box>
                  <box flexGrow={1}>
                    <text fg={fg()}>{event.title.length > maxTitleWidth() ? event.title.slice(0, maxTitleWidth() - 1) + "…" : event.title}</text>
                  </box>
                  <box width={16} flexShrink={0}>
                    <text fg={theme.textMuted}>{(event.actor ?? "").length > 14 ? (event.actor ?? "").slice(0, 13) + "…" : (event.actor ?? "")}</text>
                  </box>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async () => {
  registerTab({ key: 4, label: "Activity", order: 400, render: () => <ActivityView /> })

  AppRuntime.runPromise(
    Effect.gen(function* () {
      const feed = yield* ActivityFeed.Service
      yield* feed.start()
    }),
  ).catch(() => {})
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
