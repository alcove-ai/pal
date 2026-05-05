import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"

export function NeedsMe() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <box
      width={dimensions().width}
      flexGrow={1}
      alignItems="center"
      justifyContent="center"
    >
      <text fg={theme.textMuted}>Needs Me -- coming soon</text>
    </box>
  )
}
