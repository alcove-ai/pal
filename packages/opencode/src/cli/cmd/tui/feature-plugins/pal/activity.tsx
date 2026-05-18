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
import { PollStateTable } from "@/activity-feed/activity-feed.sql"

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
    case "issue_opened": return "ISS"
    case "issue_closed": return "CLS"
    case "issue_commented": return "CMT"
    case "pr_opened": return "PR"
    case "pr_merged": return "MRG"
    case "pr_closed": return "CLS"
    case "pr_commented": return "CMT"
    case "review_requested": return "REV"
    case "review_submitted": return "RVW"
    case "mentioned": return "MEN"
    case "ci_failed": return "CI!"
    case "status_changed": return "STS"
    case "assigned": return "ASG"
    case "commented": return "CMT"
    case "priority_changed": return "PRI"
    case "blocked": return "BLK"
    case "field_updated": return "UPD"
    case "mr_opened": return "MR"
    case "mr_merged": return "MRG"
    case "mr_commented": return "CMT"
    case "pipeline_failed": return "CI!"
    default: return String(eventType).slice(0, 3).toUpperCase()
  }
}

function eventTypeColor(eventType: ActivityEventType, theme: any): string {
  switch (eventType) {
    case "issue_created":
    case "issue_opened":
    case "pr_opened":
    case "mr_opened":
      return theme.success ?? theme.primary
    case "pr_merged":
    case "mr_merged":
      return theme.primary
    case "issue_closed":
    case "pr_closed":
      return theme.textMuted
    case "status_changed":
    case "review_submitted":
      return theme.info ?? theme.primary
    case "assigned":
    case "review_requested":
    case "priority_changed":
    case "mentioned":
      return theme.warning ?? theme.primary
    case "ci_failed":
    case "pipeline_failed":
    case "blocked":
      return theme.error ?? theme.primary
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

function loadEvents(actorTypeFilter?: ActorType, modeFilter?: "all" | "own" | "watch"): ActivityEvent[] {
  try {
    const all = Database.use((db) => {
      const query = db.select().from(ActivityEventTable)
      if (actorTypeFilter) {
        return query.where(eq(ActivityEventTable.actor_type, actorTypeFilter)).orderBy(desc(ActivityEventTable.timestamp)).limit(PAGE_SIZE).all() as ActivityEvent[]
      }
      return query.orderBy(desc(ActivityEventTable.timestamp)).limit(PAGE_SIZE).all() as ActivityEvent[]
    })
    // Apply mode filter client-side (mode column is being added by another agent)
    if (modeFilter === "own") {
      return all.filter((e) => { const mode = (e as any).mode; return mode === "own" || mode === null || mode === undefined })
    }
    if (modeFilter === "watch") {
      return all.filter((e) => (e as any).mode === "watch")
    }
    return all
  } catch {
    return []
  }
}

type ActorTypeFilter = "all" | ActorType
const ACTOR_TYPE_FILTERS: ActorTypeFilter[] = ["all", "human", "agent"]

type ModeFilter = "all" | "own" | "watch"
const MODE_FILTERS: ModeFilter[] = ["all", "own", "watch"]

function actorTypeBadge(actorType: ActorType | string): string {
  switch (actorType) {
    case "agent": return "BOT"
    case "system": return "SYS"
    case "human": return "   "
    default: return "   "
  }
}

function modeBadge(mode: string | null | undefined): string {
  return mode === "watch" ? " W " : " O "
}

function ActivityView() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [events, setEvents] = createSignal<ActivityEvent[]>([])
  const [scrollOffset, setScrollOffset] = createSignal(0)
  const [actorFilter, setActorFilter] = createSignal<ActorTypeFilter>("all")
  const [modeFilter, setModeFilter] = createSignal<ModeFilter>("all")
  const [pollCompleted, setPollCompleted] = createSignal(false)

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

  function cycleActorFilter() {
    const current = actorFilter()
    const idx = ACTOR_TYPE_FILTERS.indexOf(current)
    setActorFilter(ACTOR_TYPE_FILTERS[(idx + 1) % ACTOR_TYPE_FILTERS.length])
    refresh()
  }

  function cycleModeFilter() {
    const current = modeFilter()
    const idx = MODE_FILTERS.indexOf(current)
    setModeFilter(MODE_FILTERS[(idx + 1) % MODE_FILTERS.length])
    refresh()
  }

  function refresh() {
    const filter = actorFilter()
    const mode = modeFilter()
    setEvents(loadEvents(filter === "all" ? undefined : filter, mode))

    // Check if any poll has completed by looking at PollStateTable
    try {
      const hasCompletedPoll = Database.use((db) => {
        const rows = db.select().from(PollStateTable).limit(1).all()
        return rows.length > 0 && rows[0].last_success_ts !== null
      })
      if (hasCompletedPoll) {
        setPollCompleted(true)
      }
    } catch {
      // Ignore database errors
    }
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
        <text fg={theme.textMuted}>{"  |  "}</text>
        <text fg={theme.textMuted}>Mode: </text>
        <For each={MODE_FILTERS}>
          {(filter) => (
            <text fg={modeFilter() === filter ? theme.primary : theme.textMuted} attributes={modeFilter() === filter ? TextAttributes.BOLD : 0}>
              {` ${filter === "all" ? "All" : filter === "own" ? "Own" : "Watch"} `}
            </text>
          )}
        </For>
      </box>
      <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
        <box width={8} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Time</text></box>
        <box width={5} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Type</text></box>
        <box flexGrow={1}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Title</text></box>
        <box width={14} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Actor</text></box>
      </box>
      <Show when={events().length > 0} fallback={
        <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
          <Show when={!pollCompleted()} fallback={
            <text fg={theme.textMuted}>No activity events yet. Events will appear after the first poll cycle.</text>
          }>
            <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{spinnerFrames[spinnerFrame()]}{" Loading activity feed..."}</text>
            <box height={1} />
            <text fg={theme.textMuted} attributes={TextAttributes.DIM}>Polling activity sources</text>
          </Show>
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
              const maxTitleWidth = () => Math.max(dimensions().width - 28, 10)

              return (
                <box height={1} flexDirection="row" paddingLeft={1}>
                  <box width={8} flexShrink={0}><text fg={theme.textMuted}>{formatTimestamp(event.timestamp)}</text></box>
                  <box width={5} flexShrink={0}><text fg={badgeColor()} attributes={TextAttributes.BOLD}>{eventTypeBadge(event.event_type as ActivityEventType)}</text></box>
                  <box flexGrow={1}>
                    <text fg={fg()}>{event.title.length > maxTitleWidth() ? event.title.slice(0, maxTitleWidth() - 1) + "…" : event.title}</text>
                  </box>
                  <box width={14} flexShrink={0}>
                    <text fg={event.actor_type === "agent" ? (theme.warning ?? theme.primary) : theme.textMuted}>
                      {(event.actor ?? "").length > 12 ? (event.actor ?? "").slice(0, 11) + "…" : (event.actor ?? "")}
                    </text>
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
