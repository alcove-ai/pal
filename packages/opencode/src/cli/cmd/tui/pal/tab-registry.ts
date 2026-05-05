import type { JSX } from "@opentui/solid"

export type PalTabDefinition = {
  key: number
  label: string
  order: number
  render: () => JSX.Element
}

const tabs = new Map<number, PalTabDefinition>()

// Not reactive — tabs are registered synchronously by internal plugins
// before the TUI's first render (during TuiPluginRuntime.init()).

export function registerTab(def: PalTabDefinition): void {
  tabs.set(def.key, def)
}

export function getTabs(): PalTabDefinition[] {
  return Array.from(tabs.values()).sort((a, b) => a.order - b.order)
}

// +1 for the hardcoded Agent tab (key=1) which is not in the registry
export function getTabCount(): number {
  return tabs.size + 1
}
