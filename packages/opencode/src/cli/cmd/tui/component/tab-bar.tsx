import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

export type TabDefinition = {
  key: number
  label: string
}

const TABS: TabDefinition[] = [
  { key: 1, label: "Agent" },
  { key: 2, label: "Needs Me" },
  { key: 3, label: "Domains" },
  { key: 4, label: "Activity" },
  { key: 5, label: "Settings" },
]

export function TabBar(props: { activeTab: number }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

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
        <For each={TABS}>
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
