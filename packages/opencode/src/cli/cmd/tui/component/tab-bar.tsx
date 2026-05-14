import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { getTabs } from "@tui/pal/tab-registry"
import { onUpdateComplete } from "@/installation/pal-update"

type TabDisplay = { key: number; label: string }

const [pendingVersion, setPendingVersion] = createSignal<string | null>(null)
onUpdateComplete((version) => setPendingVersion(version))

export function TabBar(props: { activeTab: number }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const allTabs = createMemo<TabDisplay[]>(() => {
    const palTabs = getTabs().map((t) => ({ key: t.key, label: t.label }))
    return [{ key: 1, label: "Agent" }, ...palTabs]
  })

  const version = `PAL v${InstallationVersion}`

  return (
    <box flexDirection="column" flexShrink={0} width={dimensions().width}>
      <box
        flexDirection="row"
        height={1}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="row" flexGrow={1} gap={1} paddingLeft={1}>
          <For each={allTabs()}>
            {(tab) => {
              const isActive = () => props.activeTab === tab.key
              return (
                <text
                  fg={isActive() ? theme.background : theme.textMuted}
                  bg={isActive() ? theme.primary : undefined}
                  attributes={isActive() ? TextAttributes.BOLD : undefined}
                >
                  {` [^${tab.key}] ${tab.label} `}
                </text>
              )
            }}
          </For>
        </box>
        <box flexShrink={0} paddingRight={1}>
          <text fg={theme.textMuted}>{version}</text>
        </box>
      </box>
      <Show when={pendingVersion()}>
        <box height={1} flexShrink={0} backgroundColor={theme.warning} width={dimensions().width}>
          <text fg={theme.background} attributes={TextAttributes.BOLD}>
            {` ⟳ PAL v${pendingVersion()} downloaded — restart to apply (quit and rerun pal) `}
          </text>
        </box>
      </Show>
    </box>
  )
}
