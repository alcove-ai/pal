/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { registerTab } from "@tui/pal/tab-registry"

const id = "internal:pal-settings"

function SettingsView() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <box width={dimensions().width} flexGrow={1} alignItems="center" justifyContent="center">
      <text fg={theme.textMuted}>Settings -- coming soon</text>
    </box>
  )
}

const tui: TuiPlugin = async () => {
  registerTab({ key: 5, label: "Settings", order: 500, render: () => <SettingsView /> })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
