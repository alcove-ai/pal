import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, onMount, onCleanup, For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { registerTab } from "@tui/pal/tab-registry"
import { get as getRole } from "@/config/role"
import {
  loadRadarItems,
  addItem,
  removeItem,
  getResult,
  type RadarItem,
  type RadarResult,
} from "@/radar/radar-store"
import { queueRadarAnalysis, queueStaleRadarItems, checkRadarResults } from "@/radar/radar-pool"
import { registerSession, isRunning, getElapsedMs } from "@/agent-pool/pool"

const id = "internal:pal-radar"
const REFRESH_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sourceChar(url: string): string {
  const lower = url.toLowerCase()
  if (lower.includes("atlassian.net") || lower.includes("jira")) return "J"
  if (lower.includes("github.com")) return "G"
  if (lower.includes("gitlab")) return "L"
  return "W"
}

function urgencyBadge(urgency: number): string {
  if (urgency >= 8) return "!! "
  if (urgency >= 5) return " ! "
  if (urgency >= 3) return " ~ "
  return " . "
}

function urgencyColor(urgency: number, theme: any): string {
  if (urgency >= 8) return theme.error ?? "#ff0000"
  if (urgency >= 5) return theme.warning ?? "#ffaa00"
  if (urgency >= 3) return theme.info ?? theme.primary
  return theme.textMuted
}

function formatTimeSince(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function formatElapsed(ms: number | null): string {
  if (ms === null) return "..."
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m${secs % 60}s`
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function RadarView(props: { api: TuiPluginApi }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [items, setItems] = createSignal<RadarItem[]>([])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [scrollOffset, setScrollOffset] = createSignal(0)
  const [searchMode, setSearchMode] = createSignal(false)
  const [searchText, setSearchText] = createSignal("")
  const [addMode, setAddMode] = createSignal(false)
  const [addText, setAddText] = createSignal("")

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

  function refresh() {
    // Sync completed pool results into radar store
    checkRadarResults()

    const loaded = loadRadarItems()
    setItems(loaded)

    // Queue any stale items for background analysis
    queueStaleRadarItems()

    // Clamp selection
    if (loaded.length > 0 && selectedIndex() >= loaded.length) {
      setSelectedIndex(loaded.length - 1)
    }
  }

  onMount(() => refresh())
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  onMount(() => { refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS) })
  onCleanup(() => { if (refreshTimer) clearInterval(refreshTimer) })

  const filteredItems = (): RadarItem[] => {
    const text = searchText().toLowerCase()
    if (!text) return items()
    return items().filter((item) => {
      if (item.url.toLowerCase().includes(text)) return true
      if (item.label?.toLowerCase().includes(text)) return true
      const result = getResult(item.url)
      if (result?.summary?.toLowerCase().includes(text)) return true
      if (result?.impact?.toLowerCase().includes(text)) return true
      return false
    })
  }

  // Visible height calculation: header(1) + add-mode(1?) + column-headers(1) + footer(1) = 3-4
  const visibleHeight = () => {
    const overhead = addMode() ? 4 : 3
    const availableRows = Math.max(dimensions().height - overhead, 2)
    return availableRows
  }

  const visibleItems = (): RadarItem[] => {
    const all = filteredItems()
    const offset = scrollOffset()
    const maxRows = visibleHeight()

    // Each item takes ~4 rows (3 content + 1 blank separator)
    const result: RadarItem[] = []
    let usedRows = 0
    for (let i = offset; i < all.length; i++) {
      const res = getResult(all[i].url)
      const contentRows = res?.status === "done" && res.impact ? 3 : 2
      const rowHeight = contentRows + 1 // +1 for blank separator
      if (usedRows + rowHeight > maxRows) break
      result.push(all[i])
      usedRows += rowHeight
    }
    return result
  }

  // Triage session launcher (same pattern as Needs Me)
  async function launchTriageSession(item: RadarItem) {
    const result = await props.api.client.session.create({
      title: `Radar: ${(item.label ?? item.url).slice(0, 50)}`,
    })
    if (!result.data?.id) return

    const sessionID = result.data.id
    // Register with pool using a minimal ActivityItem-like shape
    const activityItem = {
      source_id: item.url,
      source: sourceChar(item.url) === "J" ? "jira" : sourceChar(item.url) === "G" ? "github" : sourceChar(item.url) === "L" ? "gitlab" : "web",
      title: item.label ?? item.url,
      url: item.url,
      actor: null,
      last_event_ts: Date.now(),
      event_type: "radar-triage",
      summary: null,
      parent_key: null,
      issue_type: null,
      milestone: null,
      milestone_url: null,
      metadata: null,
    }
    registerSession(activityItem, sessionID)
    props.api.route.navigate("session", { sessionID })

    const role = getRole() ?? "No role configured."

    void props.api.client.session.prompt({
      sessionID,
      parts: [{
        type: "text" as const,
        text: `Your role: ${role}

Watched item: ${item.label ?? item.url}
URL: ${item.url}

Help me understand this item and its impact on my work. Fetch the full details first.`,
      }],
    })
  }

  // Keyboard handling
  useKeyboard((evt) => {
    if (props.api.ui.dialog.open) return
    if (evt.defaultPrevented) return

    // Add mode: capture URL text
    if (addMode()) {
      evt.preventDefault()
      const name = evt.name ?? ""
      if (name === "escape") {
        setAddMode(false)
        setAddText("")
        return
      }
      if (name === "return") {
        const url = addText().trim()
        if (url) {
          addItem(url)
          queueRadarAnalysis({ url, label: null }, null)
          refresh()
        }
        setAddMode(false)
        setAddText("")
        return
      }
      if (name === "backspace") {
        setAddText((t) => t.slice(0, -1))
        return
      }
      if (name && name.length === 1 && !evt.ctrl && !evt.meta) {
        setAddText((t) => t + name)
      }
      return
    }

    // Search mode: capture filter text
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
        setSelectedIndex(0)
        setScrollOffset(0)
        return
      }
      if (name && name.length === 1 && !evt.ctrl && !evt.meta) {
        setSearchText((t) => t + name)
        setSelectedIndex(0)
        setScrollOffset(0)
      }
      return
    }

    if (evt.ctrl || evt.meta || evt.shift) return

    const allItems = filteredItems()
    const name = evt.name ?? ""

    // /: search
    if (name === "/") {
      evt.preventDefault()
      setSearchMode(true)
      return
    }

    // a: add URL
    if (name === "a") {
      evt.preventDefault()
      setAddMode(true)
      setAddText("")
      return
    }

    if (allItems.length === 0) return

    // j / down: move selection down
    if (name === "down" || name === "j") {
      evt.preventDefault()
      setSelectedIndex((idx) => Math.min(allItems.length - 1, idx + 1))
      // Scroll if needed
      const vis = visibleItems()
      const selected = allItems[selectedIndex()]
      if (selected && !vis.some((v) => v.url === selected.url)) {
        setScrollOffset((prev) => prev + 1)
      }
      return
    }

    // k / up: move selection up
    if (name === "up" || name === "k") {
      evt.preventDefault()
      setSelectedIndex((idx) => Math.max(0, idx - 1))
      if (selectedIndex() < scrollOffset()) setScrollOffset(selectedIndex())
      return
    }

    // d: delete selected item
    if (name === "d") {
      evt.preventDefault()
      const item = allItems[selectedIndex()]
      if (item) {
        removeItem(item.url)
        refresh()
      }
      return
    }

    // r: re-scan selected item
    if (name === "r") {
      evt.preventDefault()
      const item = allItems[selectedIndex()]
      if (item) queueRadarAnalysis(item, getResult(item.url))
      return
    }

    // Enter: open triage session
    if (name === "return") {
      evt.preventDefault()
      const item = allItems[selectedIndex()]
      if (item) void launchTriageSession(item)
      return
    }
  })

  const paddingLeft = 14

  return (
    <box width={dimensions().width} flexGrow={1} flexDirection="column">
      {/* Header */}
      <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>Radar</text>
        <text fg={theme.textMuted}>{" ("}{filteredItems().length}{searchText() ? `/${items().length}` : ""}{" items)"}</text>
        {(searchMode() || searchText()) && (
          <text fg={searchMode() ? theme.warning : theme.info}>{" /"}{searchText()}{searchMode() ? "▌" : ""}</text>
        )}
        <box flexGrow={1} />
      </box>

      {/* Add mode input */}
      <Show when={addMode()}>
        <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
          <text fg={theme.warning} attributes={TextAttributes.BOLD}>{"Add URL: "}</text>
          <text fg={theme.text}>{addText()}</text>
          <text fg={theme.warning}>{"▌"}</text>
        </box>
      </Show>

      {/* Content */}
      <Show when={filteredItems().length > 0} fallback={
        <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
          <text fg={theme.textMuted}>No items on radar. Press 'a' to add a URL.</text>
        </box>
      }>
        <box flexGrow={1} flexDirection="column" overflow="hidden">
          <For each={visibleItems()}>
            {(item) => {
              const result = () => getResult(item.url)
              const analyzed = () => result()?.status === "done"
              const itemUrgency = () => result()?.urgency ?? 5
              const isSelected = () => {
                const idx = selectedIndex()
                const all = filteredItems()
                return idx < all.length && all[idx]?.url === item.url
              }
              const scanTime = () => {
                const r = result()
                return r ? formatTimeSince(r.analyzedAt) : "never"
              }
              const maxTitleWidth = () => Math.max(dimensions().width - 20, 10)
              const truncate = (s: string, extra = 0) => {
                const maxW = Math.max(dimensions().width - paddingLeft - 2 - extra, 10)
                return s.length > maxW ? s.slice(0, maxW - 1) + "…" : s
              }
              const displayTitle = () => {
                const title = item.label ?? item.url
                return title.length > maxTitleWidth() ? title.slice(0, maxTitleWidth() - 1) + "…" : title
              }

              return (
                <box flexDirection="column" backgroundColor={isSelected() ? theme.backgroundElement : undefined}>
                  {/* Row 1: urgency badge + source char + scan time + title */}
                  <box height={1} flexDirection="row" paddingLeft={1}>
                    <box width={2} flexShrink={0}>
                      {(() => {
                        if (isSelected()) return <text fg={theme.primary} attributes={TextAttributes.BOLD}>{analyzed() ? urgencyBadge(itemUrgency()) : isRunning(item.url) ? spinnerFrames[spinnerFrame()] : "· "}</text>
                        if (isRunning(item.url)) return <text fg={theme.info}>{spinnerFrames[spinnerFrame()]}</text>
                        if (analyzed()) return <text fg={urgencyColor(itemUrgency(), theme)} attributes={itemUrgency() >= 8 ? TextAttributes.BOLD : undefined}>{urgencyBadge(itemUrgency())}</text>
                        if (result()?.status === "error") return <text fg={theme.error}>{"! "}</text>
                        return <text fg={theme.textMuted}>{"· "}</text>
                      })()}
                    </box>
                    <box width={2} flexShrink={0}>
                      <text fg={isSelected() ? theme.primary : theme.text}>{sourceChar(item.url)}{" "}</text>
                    </box>
                    <box width={10} flexShrink={0}>
                      <text fg={isSelected() ? theme.primary : theme.textMuted}>{scanTime()}</text>
                    </box>
                    <box flexGrow={1}>
                      <text fg={isSelected() ? theme.primary : theme.text} attributes={isSelected() ? TextAttributes.BOLD : undefined}>{displayTitle()}</text>
                    </box>
                  </box>
                  {/* Row 2: State summary */}
                  <box height={1} flexDirection="row" paddingLeft={paddingLeft}>
                    {(() => {
                      const r = result()
                      if (r?.status === "done" && r.summary) {
                        return <text fg={isSelected() ? theme.primary : urgencyColor(itemUrgency(), theme)}>{truncate(`State: ${r.summary}`)}</text>
                      }
                      if (r?.status === "running") {
                        return <text fg={isSelected() ? theme.primary : theme.textMuted}>{spinnerFrames[spinnerFrame()]}{" Scanning ("}{formatElapsed(getElapsedMs(item.url))}{")..."}</text>
                      }
                      if (r?.status === "error") {
                        return <text fg={isSelected() ? theme.primary : theme.error}>{truncate(`✗ ${r.summary}`)}</text>
                      }
                      return <text fg={isSelected() ? theme.primary : theme.textMuted}>{"Not yet scanned"}</text>
                    })()}
                  </box>
                  {/* Row 3: Impact (only if analyzed) */}
                  <Show when={analyzed() && result()?.impact}>
                    <box height={1} flexDirection="row" paddingLeft={paddingLeft}>
                      <text fg={isSelected() ? theme.primary : theme.textMuted} attributes={TextAttributes.DIM}>{truncate(`Impact: ${result()!.impact!}`)}</text>
                    </box>
                  </Show>
                  {/* Blank separator */}
                  <box height={1} />
                </box>
              )
            }}
          </For>
        </box>
        {/* Footer */}
        <box height={1} flexShrink={0} paddingLeft={1} flexDirection="row">
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"j/k select  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"a add  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"d delete  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"r re-scan  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"enter triage  "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"/ search"}</text>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  registerTab({ key: 3, label: "Radar", order: 300, render: () => <RadarView api={api} /> })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
