import type { JSX } from "@opentui/solid"

export type PalTabDefinition = {
  key: number
  label: string
  order: number
  render: () => JSX.Element
}

const tabs = new Map<number, PalTabDefinition>()
const listeners = new Set<() => void>()

export function registerTab(def: PalTabDefinition): () => void {
  tabs.set(def.key, def)
  listeners.forEach((fn) => fn())
  return () => {
    tabs.delete(def.key)
    listeners.forEach((fn) => fn())
  }
}

export function getTabs(): PalTabDefinition[] {
  return Array.from(tabs.values()).sort((a, b) => a.order - b.order)
}

export function getTabCount(): number {
  return tabs.size + 1
}

export function onTabsChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
