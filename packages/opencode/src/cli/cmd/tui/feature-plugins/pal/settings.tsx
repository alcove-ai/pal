import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { registerTab } from "@tui/pal/tab-registry"
import { get as getRole, set as setRole } from "@/config/role"
import { load as loadProcessDoc } from "@/process/process-doc"

const id = "internal:pal-settings"

function SettingsView() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [role, setRoleText] = createSignal(getRole() ?? "")
  const [hasProcessDoc, setHasProcessDoc] = createSignal(false)
  const [processDocPath, setProcessDocPath] = createSignal("")

  onMount(() => {
    const doc = loadProcessDoc()
    setHasProcessDoc(!!doc)
    const cwd = process.cwd()
    const candidates = [".opencode/process.md", "CONTRIBUTING.md"]
    for (const c of candidates) {
      try {
        const fs = require("fs")
        if (fs.existsSync(require("path").join(cwd, c))) {
          setProcessDocPath(c)
          break
        }
      } catch {}
    }
  })

  return (
    <box width={dimensions().width} flexGrow={1} flexDirection="column" paddingLeft={1} paddingTop={1}>
      <text fg={theme.primary} attributes={TextAttributes.BOLD}>PAL Settings</text>
      <box height={1} />

      <text fg={theme.text} attributes={TextAttributes.BOLD}>Your Role</text>
      <box height={1} />
      <Show when={role()} fallback={
        <box flexDirection="column">
          <text fg={theme.warning}>No role configured.</text>
          <text fg={theme.textMuted}>Create .opencode/role.md with a description of your role in the team process.</text>
          <text fg={theme.textMuted}>Example: "I'm the Technical Lead. I review specs and approve tasks for refinement."</text>
        </box>
      }>
        <text fg={theme.text}>{role()}</text>
      </Show>

      <box height={2} />
      <text fg={theme.text} attributes={TextAttributes.BOLD}>Process Document</text>
      <box height={1} />
      <Show when={hasProcessDoc()} fallback={
        <box flexDirection="column">
          <text fg={theme.warning}>No process document found.</text>
          <text fg={theme.textMuted}>Create .opencode/process.md or add a CONTRIBUTING.md to your repo.</text>
          <text fg={theme.textMuted}>This document describes your team's development process for the LLM sweep.</text>
        </box>
      }>
        <text fg={theme.success}>Loaded from {processDocPath()}</text>
      </Show>

      <box flexGrow={1} />
      <text fg={theme.textMuted} attributes={TextAttributes.DIM}>Edit .opencode/role.md and .opencode/process.md directly to update.</text>
      <box height={1} />
    </box>
  )
}

const tui: TuiPlugin = async () => {
  registerTab({ key: 6, label: "Settings", order: 600, render: () => <SettingsView /> })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
