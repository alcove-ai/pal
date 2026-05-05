import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, onMount, onCleanup, For, Show } from "solid-js"
import { Database } from "@/storage/db"
import { ActivityEventTable } from "@/activity-feed/activity-feed.sql"
import { desc, eq } from "drizzle-orm"
import type { ActivityEvent, ActivitySource, ActivityEventType } from "@/activity-feed/types"
import { TextAttributes } from "@opentui/core"

const PAGE_SIZE = 50

function sourceIcon(source: ActivitySource): string {
  switch (source) {
    case "jira":
      return "J"
    case "github":
      return "G"
    case "gitlab":
      return "L"
    default:
      return "?"
  }
}

function eventTypeBadge(eventType: ActivityEventType): string {
  switch (eventType) {
    case "issue_created":
      return "NEW"
    case "status_changed":
      return "STS"
    case "assigned":
      return "ASG"
    case "commented":
      return "CMT"
    case "priority_changed":
      return "PRI"
    case "blocked":
      return "BLK"
    case "field_updated":
      return "UPD"
    default:
      return "???"
  }
}

function eventTypeColor(eventType: ActivityEventType, theme: any): string {
  switch (eventType) {
    case "issue_created":
      return theme.success ?? theme.primary
    case "status_changed":
      return theme.info ?? theme.primary
    case "assigned":
      return theme.warning ?? theme.primary
    case "commented":
      return theme.textMuted
    case "priority_changed":
      return theme.warning ?? theme.primary
    case "blocked":
      return theme.error ?? theme.primary
    case "field_updated":
      return theme.textMuted
    default:
      return theme.textMuted
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

function loadEvents(): ActivityEvent[] {
  try {
    return Database.use((db) => {
      return db
        .select()
        .from(ActivityEventTable)
        .orderBy(desc(ActivityEventTable.timestamp))
        .limit(PAGE_SIZE)
        .all() as ActivityEvent[]
    })
  } catch {
    return []
  }
}

export function Activity() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [events, setEvents] = createSignal<ActivityEvent[]>([])
  const [scrollOffset, setScrollOffset] = createSignal(0)

  function refresh() {
    setEvents(loadEvents())
  }

  onMount(() => {
    refresh()
  })

  // Refresh every 30 seconds while visible
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    refreshTimer = setInterval(refresh, 30_000)
  })
  onCleanup(() => {
    if (refreshTimer) clearInterval(refreshTimer)
  })

  const visibleHeight = () => Math.max(dimensions().height - 4, 1)

  const visibleEvents = () => {
    const all = events()
    const offset = scrollOffset()
    return all.slice(offset, offset + visibleHeight())
  }

  return (
    <box width={dimensions().width} flexGrow={1} flexDirection="column">
      {/* Header */}
      <box height={1} flexShrink={0} paddingLeft={1}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          Activity Feed
        </text>
        <text fg={theme.textMuted}> ({events().length} events)</text>
      </box>

      {/* Column headers */}
      <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
        <box width={8} flexShrink={0}>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
            Time
          </text>
        </box>
        <box width={3} flexShrink={0}>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
            Src
          </text>
        </box>
        <box width={5} flexShrink={0}>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
            Type
          </text>
        </box>
        <box flexGrow={1}>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
            Title / Summary
          </text>
        </box>
        <box width={16} flexShrink={0}>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
            Actor
          </text>
        </box>
      </box>

      {/* Event list */}
      <Show
        when={events().length > 0}
        fallback={
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={theme.textMuted}>No activity events yet. Events will appear after the first poll cycle.</text>
          </box>
        }
      >
        <box flexGrow={1} flexDirection="column" overflow="hidden">
          <For each={visibleEvents()}>
            {(event) => {
              const isUnread = () => event.is_read === 0
              const fg = () => (isUnread() ? theme.text : theme.textMuted)
              const badgeColor = () => eventTypeColor(event.event_type as ActivityEventType, theme)
              const maxTitleWidth = () => Math.max(dimensions().width - 35, 10)

              return (
                <box height={1} flexDirection="row" paddingLeft={1}>
                  <box width={8} flexShrink={0}>
                    <text fg={theme.textMuted}>{formatTimestamp(event.timestamp)}</text>
                  </box>
                  <box width={3} flexShrink={0}>
                    <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                      {sourceIcon(event.source as ActivitySource)}
                    </text>
                  </box>
                  <box width={5} flexShrink={0}>
                    <text fg={badgeColor()}>{eventTypeBadge(event.event_type as ActivityEventType)}</text>
                  </box>
                  <box flexGrow={1}>
                    <text fg={fg()}>
                      {event.title.length > maxTitleWidth()
                        ? event.title.slice(0, maxTitleWidth() - 1) + "…"
                        : event.title}
                    </text>
                  </box>
                  <box width={16} flexShrink={0}>
                    <text fg={theme.textMuted}>
                      {(event.actor ?? "").length > 14 ? (event.actor ?? "").slice(0, 13) + "…" : (event.actor ?? "")}
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
