import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, For } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { getTabs } from "@tui/pal/tab-registry"

type TabDisplay = { key: number; label: string }

export function TabBar(props: { activeTab: number }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const allTabs = createMemo<TabDisplay[]>(() => {
    const palTabs = getTabs().map((t) => ({ key: t.key, label: t.label }))
    return [{ key: 1, label: "Agent" }, ...palTabs]
  })

  const version = `PAL v${InstallationVersion}`

  return (
    <box
      flexDirection="row"
      height={1}
      width={dimensions().width}
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
                {` [${tab.key}] ${tab.label} `}
              </text>
            )
          }}
        </For>
      </box>
      <box flexShrink={0} paddingRight={1}>
        <text fg={theme.textMuted}>{version}</text>
      </box>
    </box>
  )
}
