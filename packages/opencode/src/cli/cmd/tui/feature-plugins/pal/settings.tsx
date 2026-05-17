import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { createSignal, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { registerTab } from "@tui/pal/tab-registry"
import { get as getRole, set as setRole } from "@/config/role"
import { load as loadProcessDoc, set as setProcessDoc, resolvedPath } from "@/process/process-doc"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogConfirm } from "@tui/ui/dialog-confirm"

const id = "internal:pal-settings"

const PROCESS_TEMPLATE = `# Development Process

## Workflow
<!-- Define your team's workflow stages -->
<!-- Example: Backlog -> Ready -> In Progress -> Review -> Done -->

## Roles
<!-- Who does what on your team? -->

## Definition of Done
<!-- When is a task considered complete? -->
`

function SettingsView() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const [role, setRoleText] = createSignal(getRole() ?? "")
  const [hasProcessDoc, setHasProcessDoc] = createSignal(false)
  const [docPath, setDocPath] = createSignal("")

  function refreshState() {
    setRoleText(getRole() ?? "")
    const doc = loadProcessDoc()
    setHasProcessDoc(!!doc)
    setDocPath(resolvedPath() ?? "")
  }

  onMount(refreshState)

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return
    if (evt.defaultPrevented) return
    if (evt.ctrl || evt.meta || evt.shift) return

    if (evt.name === "e") {
      evt.preventDefault()
      void editRole()
      return
    }
    if (evt.name === "t" && !hasProcessDoc()) {
      evt.preventDefault()
      void createProcessTemplate()
      return
    }
  })

  async function editRole() {
    const result = await DialogPrompt.show(dialog, "What's your role on this team?", {
      value: role(),
      placeholder: "I'm the [Role]. I [what you do on the team].",
    })
    if (result?.trim()) {
      setRole(result.trim())
      setRoleText(result.trim())
    }
  }

  async function createProcessTemplate() {
    const confirmed = await DialogConfirm.show(
      dialog,
      "Create process template",
      "Create a starter .opencode/process.md? You and your team can edit it to describe your workflow.",
    )
    if (confirmed) {
      setProcessDoc(PROCESS_TEMPLATE)
      refreshState()
    }
  }

  return (
    <box width={dimensions().width} flexGrow={1} flexDirection="column" paddingLeft={1} paddingTop={1}>
      <text fg={theme.primary} attributes={TextAttributes.BOLD}>PAL Settings</text>
      <box height={1} />

      <text fg={theme.text} attributes={TextAttributes.BOLD}>Your Role</text>
      <box height={1} />
      <Show when={role()} fallback={
        <box flexDirection="column">
          <text fg={theme.warning}>No role configured. Press 'e' to set your role.</text>
          <text fg={theme.textMuted}>Example: "I'm the Tech Lead. I review specs and approve tasks."</text>
        </box>
      }>
        <text fg={theme.text}>{role()}</text>
      </Show>

      <box height={2} />
      <text fg={theme.text} attributes={TextAttributes.BOLD}>Process Document</text>
      <box height={1} />
      <Show when={hasProcessDoc()} fallback={
        <box flexDirection="column">
          <text fg={theme.warning}>No process document found. Press 't' to create a template.</text>
          <text fg={theme.textMuted}>Or add .opencode/process.md or CONTRIBUTING.md to your repo.</text>
        </box>
      }>
        <text fg={theme.success}>{"Loaded from "}{docPath()}</text>
      </Show>

      <box flexGrow={1} />
      <box height={1} flexShrink={0} flexDirection="row">
        <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"e edit role  "}</text>
        <Show when={!hasProcessDoc()}>
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>{"t create process template  "}</text>
        </Show>
      </box>
      <box height={1} />
    </box>
  )
}

function OnboardingGuard() {
  const dialog = useDialog()

  onMount(() => {
    setTimeout(async () => {
      if (!getRole()) {
        const roleText = await DialogPrompt.show(dialog, "Welcome to PAL! What's your role on this team?", {
          placeholder: "I'm the [Role]. I [what you do on the team].",
        })
        if (roleText?.trim()) {
          setRole(roleText.trim())
        }
      }

      if (!loadProcessDoc()) {
        const confirmed = await DialogConfirm.show(
          dialog,
          "Process document missing",
          "PAL needs a process document (.opencode/process.md or CONTRIBUTING.md) to understand your team's workflow. Create a starter template?",
        )
        if (confirmed) {
          setProcessDoc(PROCESS_TEMPLATE)
        }
      }
    }, 500)
  })

  return null
}

const tui: TuiPlugin = async (api) => {
  registerTab({ key: 6, label: "Settings", order: 600, render: () => <SettingsView /> })

  api.slots.register({
    slots: {
      app: () => <OnboardingGuard />,
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
