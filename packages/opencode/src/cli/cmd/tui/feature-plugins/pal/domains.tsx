import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, onMount, onCleanup, For, Show } from "solid-js"
import { Database } from "@/storage/db"
import { ActivityEventTable } from "@/activity-feed/activity-feed.sql"
import { desc } from "drizzle-orm"
import type { ActivityEvent, ActivitySource } from "@/activity-feed/types"
import { DomainConfig } from "@/domain-health/config"
import { Classifier } from "@/domain-health/classifier"
import { Health } from "@/domain-health/health"
import type { DomainsConfig } from "@/domain-health/config"
import type { HealthSignals, HealthLevel } from "@/domain-health/health"
import { TextAttributes } from "@opentui/core"
import { registerTab } from "@tui/pal/tab-registry"

const id = "internal:pal-domains"
const MAX_EVENTS = 500
const PAGE_SIZE = 50

interface DomainRow { name: string; owner: string; eventCount: number; health: HealthSignals }
interface SnapshotData { domains: DomainRow[]; uncategorized: { eventCount: number; health: HealthSignals; highUncategorized: boolean }; totalEvents: number }

function loadEvents(): ActivityEvent[] {
  try { return Database.use((db) => db.select().from(ActivityEventTable).orderBy(desc(ActivityEventTable.timestamp)).limit(MAX_EVENTS).all() as ActivityEvent[]) }
  catch { return [] }
}

function computeSnapshot(config: DomainsConfig, events: ActivityEvent[]): SnapshotData {
  const { byDomain, uncategorized } = Classifier.classifyEvents(events, config)
  const domains: DomainRow[] = config.domains.map((d) => {
    const domainEvents = byDomain.get(d.name) ?? []
    return { name: d.name, owner: d.owner, eventCount: domainEvents.length, health: Health.computeHealth(domainEvents) }
  })
  const uncatHealth = Health.computeHealth(uncategorized)
  const totalEvents = events.length
  return { domains, uncategorized: { eventCount: uncategorized.length, health: uncatHealth, highUncategorized: totalEvents > 0 && uncategorized.length / totalEvents > 0.2 }, totalEvents }
}

function levelIndicator(_level: HealthLevel): string { return "●" }
function levelColor(level: HealthLevel, theme: any): string {
  switch (level) { case "green": return theme.success ?? "#22c55e"; case "yellow": return theme.warning ?? "#eab308"; case "red": return theme.error ?? "#ef4444" }
}
function formatSignalValue(label: string, value: number): string {
  switch (label) { case "Flow": return value.toFixed(1); case "Stale": return `${value.toFixed(0)}d`; case "Block": return `${value}`; case "Trend": return value > 0 ? `+${value}%` : `${value}%`; default: return `${value}` }
}
function sourceIcon(source: ActivitySource): string {
  switch (source) { case "jira": return "J"; case "github": return "G"; case "gitlab": return "L"; default: return "?" }
}
function formatTimestamp(ts: number): string {
  const now = Date.now(); const diff = now - ts
  if (diff < 60_000) return "just now"; if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`; if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  const date = new Date(ts); return `${date.getMonth() + 1}/${date.getDate()}`
}

function DomainsView() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [config, setConfig] = createSignal<DomainsConfig>(DomainConfig.get())
  const [events, setEvents] = createSignal<ActivityEvent[]>([])
  const [snapshot, setSnapshot] = createSignal<SnapshotData | null>(null)
  const [drillDomain, setDrillDomain] = createSignal<string | null>(null)
  const [drillEvents, setDrillEvents] = createSignal<ActivityEvent[]>([])

  function refresh() {
    const cfg = DomainConfig.get(); setConfig(cfg)
    const evts = loadEvents(); setEvents(evts)
    if (cfg.domains.length > 0) setSnapshot(computeSnapshot(cfg, evts)); else setSnapshot(null)
  }

  function drillInto(domainName: string) {
    const cfg = config(); const evts = events()
    const { byDomain, uncategorized } = Classifier.classifyEvents(evts, cfg)
    if (domainName === "__uncategorized__") { setDrillDomain("Uncategorized"); setDrillEvents(uncategorized) }
    else { setDrillDomain(domainName); setDrillEvents(byDomain.get(domainName) ?? []) }
  }
  void drillInto

  const unsubscribe = DomainConfig.onChange(() => refresh())
  onMount(() => refresh())
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  onMount(() => { refreshTimer = setInterval(refresh, 30_000) })
  onCleanup(() => { if (refreshTimer) clearInterval(refreshTimer); unsubscribe() })

  return (
    <box width={dimensions().width} flexGrow={1} flexDirection="column">
      <Show when={drillDomain() !== null} fallback={<GridView />}>
        <DrillView />
      </Show>
    </box>
  )

  function GridView() {
    return (
      <box width={dimensions().width} flexGrow={1} flexDirection="column">
        <box height={1} flexShrink={0} paddingLeft={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>Domain Health</text>
          <text fg={theme.textMuted}>{" "}({config().domains.length} domains, {events().length} events)</text>
        </box>
        <Show when={config().domains.length > 0 && snapshot() !== null} fallback={
          <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
            <text fg={theme.textMuted}>No domains configured.</text>
            <text fg={theme.textMuted}>Create .opencode/domains.json to define domains.</text>
            <text fg={theme.textMuted}>See domains.example.json for the format.</text>
          </box>
        }>
          <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
            <box width={3} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>H</text></box>
            <box width={16} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Domain</text></box>
            <box width={6} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Evts</text></box>
            <box width={8} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Flow</text></box>
            <box width={8} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Stale</text></box>
            <box width={8} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Block</text></box>
            <box width={8} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Trend</text></box>
            <box flexGrow={1}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Owner</text></box>
          </box>
          <box flexGrow={1} flexDirection="column" overflow="hidden">
            <For each={snapshot()?.domains ?? []}>{(domain) => <DomainRowComponent domain={domain} />}</For>
            <Show when={snapshot()?.uncategorized}>{(uncat) => {
              const u = uncat()
              return (
                <box height={1} flexDirection="row" paddingLeft={1}>
                  <box width={3} flexShrink={0}><text fg={levelColor(u.health.overall, theme)}>{levelIndicator(u.health.overall)}</text></box>
                  <box width={16} flexShrink={0}><text fg={u.highUncategorized ? (theme.warning ?? theme.text) : theme.textMuted} attributes={u.highUncategorized ? TextAttributes.BOLD : 0}>{u.highUncategorized ? "Uncategorized!" : "Uncategorized"}</text></box>
                  <box width={6} flexShrink={0}><text fg={theme.text}>{u.eventCount}</text></box>
                  <box width={8} flexShrink={0}><text fg={levelColor(u.health.flowRatio.level, theme)}>{levelIndicator(u.health.flowRatio.level)} {formatSignalValue("Flow", u.health.flowRatio.value)}</text></box>
                  <box width={8} flexShrink={0}><text fg={levelColor(u.health.staleness.level, theme)}>{levelIndicator(u.health.staleness.level)} {formatSignalValue("Stale", u.health.staleness.value)}</text></box>
                  <box width={8} flexShrink={0}><text fg={levelColor(u.health.blockageCount.level, theme)}>{levelIndicator(u.health.blockageCount.level)} {formatSignalValue("Block", u.health.blockageCount.value)}</text></box>
                  <box width={8} flexShrink={0}><text fg={levelColor(u.health.activityTrend.level, theme)}>{levelIndicator(u.health.activityTrend.level)} {formatSignalValue("Trend", u.health.activityTrend.value)}</text></box>
                  <box flexGrow={1}><text fg={theme.textMuted}>-</text></box>
                </box>
              )
            }}</Show>
          </box>
          <Show when={snapshot()?.uncategorized?.highUncategorized}>
            <box height={1} flexShrink={0} paddingLeft={1}><text fg={theme.warning ?? theme.text}>Hint: &gt;20% of events are uncategorized. Consider updating your domains config.</text></box>
          </Show>
        </Show>
      </box>
    )
  }

  function DomainRowComponent(props: { domain: DomainRow }) {
    const d = () => props.domain; const h = () => d().health
    return (
      <box height={1} flexDirection="row" paddingLeft={1}>
        <box width={3} flexShrink={0}><text fg={levelColor(h().overall, theme)}>{levelIndicator(h().overall)}</text></box>
        <box width={16} flexShrink={0}><text fg={theme.text} attributes={TextAttributes.BOLD}>{d().name.length > 14 ? d().name.slice(0, 13) + "…" : d().name}</text></box>
        <box width={6} flexShrink={0}><text fg={theme.text}>{d().eventCount}</text></box>
        <box width={8} flexShrink={0}><text fg={levelColor(h().flowRatio.level, theme)}>{levelIndicator(h().flowRatio.level)} {formatSignalValue("Flow", h().flowRatio.value)}</text></box>
        <box width={8} flexShrink={0}><text fg={levelColor(h().staleness.level, theme)}>{levelIndicator(h().staleness.level)} {formatSignalValue("Stale", h().staleness.value)}</text></box>
        <box width={8} flexShrink={0}><text fg={levelColor(h().blockageCount.level, theme)}>{levelIndicator(h().blockageCount.level)} {formatSignalValue("Block", h().blockageCount.value)}</text></box>
        <box width={8} flexShrink={0}><text fg={levelColor(h().activityTrend.level, theme)}>{levelIndicator(h().activityTrend.level)} {formatSignalValue("Trend", h().activityTrend.value)}</text></box>
        <box flexGrow={1}><text fg={theme.textMuted}>{(d().owner ?? "").length > 12 ? d().owner.slice(0, 11) + "…" : (d().owner ?? "")}</text></box>
      </box>
    )
  }

  function DrillView() {
    const evts = () => drillEvents().slice(0, PAGE_SIZE)
    return (
      <box width={dimensions().width} flexGrow={1} flexDirection="column">
        <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>{drillDomain()}</text>
          <text fg={theme.textMuted}> ({drillEvents().length} events) </text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>[press Esc or Backspace to go back]</text>
        </box>
        <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
          <box width={8} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Time</text></box>
          <box width={3} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Src</text></box>
          <box width={5} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Type</text></box>
          <box flexGrow={1}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Title / Summary</text></box>
          <box width={16} flexShrink={0}><text fg={theme.textMuted} attributes={TextAttributes.DIM}>Actor</text></box>
        </box>
        <Show when={evts().length > 0} fallback={
          <box flexGrow={1} alignItems="center" justifyContent="center"><text fg={theme.textMuted}>No events in this domain.</text></box>
        }>
          <box flexGrow={1} flexDirection="column" overflow="hidden">
            <For each={evts()}>{(event) => {
              const maxTitleWidth = () => Math.max(dimensions().width - 35, 10)
              return (
                <box height={1} flexDirection="row" paddingLeft={1}>
                  <box width={8} flexShrink={0}><text fg={theme.textMuted}>{formatTimestamp(event.timestamp)}</text></box>
                  <box width={3} flexShrink={0}><text fg={theme.primary} attributes={TextAttributes.BOLD}>{sourceIcon(event.source as ActivitySource)}</text></box>
                  <box width={5} flexShrink={0}><text fg={theme.textMuted}>{event.event_type.slice(0, 4).toUpperCase()}</text></box>
                  <box flexGrow={1}><text fg={theme.text}>{event.title.length > maxTitleWidth() ? event.title.slice(0, maxTitleWidth() - 1) + "…" : event.title}</text></box>
                  <box width={16} flexShrink={0}><text fg={theme.textMuted}>{(event.actor ?? "").length > 14 ? (event.actor ?? "").slice(0, 13) + "…" : (event.actor ?? "")}</text></box>
                </box>
              )
            }}</For>
          </box>
        </Show>
      </box>
    )
  }
}

const tui: TuiPlugin = async () => {
  registerTab({ key: 3, label: "Domains", order: 300, render: () => <DomainsView /> })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
