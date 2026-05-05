import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Instance } from "@/project/instance"
import fsNode from "fs"
import path from "path"

const log = Log.create({ service: "domain-health.config" })

export interface DomainConfig {
  name: string
  jira_components: string[]
  jira_labels: string[]
  repo_globs: string[]
  owner: string
}

export interface DomainsConfig {
  domains: DomainConfig[]
}

const DEFAULT_CONFIG: DomainsConfig = {
  domains: [],
}

let cachedConfig: DomainsConfig | undefined
let cachedPath: string | undefined
let watcher: fsNode.FSWatcher | undefined
const changeListeners: Array<(config: DomainsConfig) => void> = []

function resolveConfigPath(): string {
  try {
    const dir = Instance.directory
    return path.join(dir, ".opencode", "domains.json")
  } catch {
    return path.join(Global.Path.config, "domains.json")
  }
}

function loadFromDisk(configPath: string): DomainsConfig {
  try {
    if (!fsNode.existsSync(configPath)) {
      log.info("no domains.json found, using empty config", { path: configPath })
      return DEFAULT_CONFIG
    }

    const raw = fsNode.readFileSync(configPath, "utf-8")
    const parsed = JSON.parse(raw) as unknown

    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).domains)) {
      log.warn("invalid domains.json structure, using defaults", { path: configPath })
      return DEFAULT_CONFIG
    }

    const config = parsed as DomainsConfig

    // Validate each domain entry
    const valid: DomainConfig[] = []
    for (const d of config.domains) {
      if (!d.name || typeof d.name !== "string") {
        log.warn("skipping domain with missing name")
        continue
      }
      valid.push({
        name: d.name,
        jira_components: Array.isArray(d.jira_components) ? d.jira_components : [],
        jira_labels: Array.isArray(d.jira_labels) ? d.jira_labels : [],
        repo_globs: Array.isArray(d.repo_globs) ? d.repo_globs : [],
        owner: typeof d.owner === "string" ? d.owner : "",
      })
    }

    log.info("loaded domains config", { path: configPath, count: valid.length })
    return { domains: valid }
  } catch (err) {
    log.error("failed to load domains.json", { path: configPath, error: err })
    return DEFAULT_CONFIG
  }
}

function setupWatcher(configPath: string): void {
  if (watcher) {
    try {
      watcher.close()
    } catch { /* ignore */ }
    watcher = undefined
  }

  const dir = path.dirname(configPath)
  const basename = path.basename(configPath)

  try {
    if (!fsNode.existsSync(dir)) return

    watcher = fsNode.watch(dir, (eventType, filename) => {
      if (filename !== basename) return
      log.info("domains.json changed, reloading", { eventType })

      const newConfig = loadFromDisk(configPath)
      cachedConfig = newConfig

      for (const listener of changeListeners) {
        try {
          listener(newConfig)
        } catch (err) {
          log.error("config change listener error", { error: err })
        }
      }
    })

    watcher.on("error", (err) => {
      log.warn("domains.json watcher error", { error: err })
    })
  } catch (err) {
    log.warn("failed to watch domains.json", { error: err })
  }
}

export function get(): DomainsConfig {
  const configPath = resolveConfigPath()

  if (cachedConfig && cachedPath === configPath) {
    return cachedConfig
  }

  cachedPath = configPath
  cachedConfig = loadFromDisk(configPath)
  setupWatcher(configPath)

  return cachedConfig
}

export function onChange(listener: (config: DomainsConfig) => void): () => void {
  changeListeners.push(listener)
  return () => {
    const idx = changeListeners.indexOf(listener)
    if (idx >= 0) changeListeners.splice(idx, 1)
  }
}

export function dispose(): void {
  if (watcher) {
    try {
      watcher.close()
    } catch { /* ignore */ }
    watcher = undefined
  }
  cachedConfig = undefined
  cachedPath = undefined
  changeListeners.length = 0
}

export * as DomainConfig from "./config"
