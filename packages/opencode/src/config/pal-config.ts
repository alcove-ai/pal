import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Instance } from "@/project/instance"
import fsNode from "fs"
import path from "path"

const log = Log.create({ service: "config.pal" })

// --- Activity feed: Jira ---

export interface JiraConfig {
  /** Base URL for the Jira instance (e.g. "https://redhat.atlassian.net") */
  url?: string
  /** JQL project filter (e.g. "PULP") */
  project?: string
  /** JQL time range for polling (e.g. "-3m") */
  updatedSince?: string
}

// --- Activity feed: GitHub ---

export interface GitHubRepoTiers {
  /** Repos where all activity is tracked */
  tier1?: string[]
  /** Repos where PRs/issues are tracked */
  tier2?: string[]
  /** Repos where only mentions/review requests are tracked */
  tier3?: string[]
}

export interface GitHubConfig {
  repos?: GitHubRepoTiers
  /** GitHub org for upstream review request polling */
  upstreamPollOrg?: string
  /** Bot logins to ignore */
  botIgnoreList?: string[]
}

// --- Activity feed: GitLab ---

export interface GitLabRepoEntry {
  projectId: string
  projectPath: string
}

export interface GitLabConfig {
  repos?: GitLabRepoEntry[]
}

// --- Activity feed (combined) ---

export interface ActivityFeedConfig {
  jira?: JiraConfig
  github?: GitHubConfig
  gitlab?: GitLabConfig
}

// --- Upstream relevance ---

export interface UpstreamRelevanceConfig {
  /** Inline deployment context for LLM-based classification (Layer 2).
   *  If set, used instead of reading deployment-context.md from disk. */
  deploymentContext?: string
}

// --- Process facilitation ---

export interface ProcessExemption {
  /** Regex patterns matched against issue summary */
  summaryPatterns?: string[]
  /** Labels that auto-exempt an issue */
  labels?: string[]
}

export interface ProcessConfig {
  /** Minimum word count for an epic problem statement to be "present" */
  epicProblemMinWords?: number
  /** Minimum word count for a task/bug problem statement to be "present" */
  taskProblemMinWords?: number
  /** Minimum word count for an epic scope section to be "present" */
  epicScopeMinWords?: number
  /** Auto-exemption rules */
  exemptions?: ProcessExemption
}

// --- Top-level PAL config ---

export interface PalConfig {
  activityFeed?: ActivityFeedConfig
  upstreamRelevance?: UpstreamRelevanceConfig
  process?: ProcessConfig
}

const DEFAULT_CONFIG: PalConfig = {}

let cachedConfig: PalConfig | undefined
let cachedPath: string | undefined
let watcher: fsNode.FSWatcher | undefined
const changeListeners: Array<(config: PalConfig) => void> = []

function resolveConfigPath(): string {
  try {
    const dir = Instance.directory
    return path.join(dir, ".opencode", "pal.json")
  } catch {
    return path.join(Global.Path.config, "pal.json")
  }
}

function loadFromDisk(configPath: string): PalConfig {
  try {
    if (!fsNode.existsSync(configPath)) {
      log.info("no pal.json found, using empty config", { path: configPath })
      return DEFAULT_CONFIG
    }

    const raw = fsNode.readFileSync(configPath, "utf-8")
    const parsed = JSON.parse(raw) as unknown

    if (!parsed || typeof parsed !== "object") {
      log.warn("invalid pal.json structure, using defaults", { path: configPath })
      return DEFAULT_CONFIG
    }

    const config = parsed as PalConfig

    // Validate sub-sections defensively
    const result: PalConfig = {}

    if (config.activityFeed && typeof config.activityFeed === "object") {
      result.activityFeed = {}

      const af = config.activityFeed

      // Jira
      if (af.jira && typeof af.jira === "object") {
        result.activityFeed.jira = {
          url: typeof af.jira.url === "string" ? af.jira.url : undefined,
          project: typeof af.jira.project === "string" ? af.jira.project : undefined,
          updatedSince: typeof af.jira.updatedSince === "string" ? af.jira.updatedSince : undefined,
        }
      }

      // GitHub
      if (af.github && typeof af.github === "object") {
        const gh = af.github
        result.activityFeed.github = {
          repos: gh.repos && typeof gh.repos === "object"
            ? {
                tier1: Array.isArray(gh.repos.tier1) ? gh.repos.tier1 : undefined,
                tier2: Array.isArray(gh.repos.tier2) ? gh.repos.tier2 : undefined,
                tier3: Array.isArray(gh.repos.tier3) ? gh.repos.tier3 : undefined,
              }
            : undefined,
          upstreamPollOrg: typeof gh.upstreamPollOrg === "string" ? gh.upstreamPollOrg : undefined,
          botIgnoreList: Array.isArray(gh.botIgnoreList) ? gh.botIgnoreList : undefined,
        }
      }

      // GitLab
      if (af.gitlab && typeof af.gitlab === "object") {
        const gl = af.gitlab
        if (Array.isArray(gl.repos)) {
          result.activityFeed.gitlab = {
            repos: gl.repos
              .filter((r: unknown): r is GitLabRepoEntry =>
                !!r && typeof r === "object" && typeof (r as any).projectId === "string" && typeof (r as any).projectPath === "string")
              .map((r) => ({ projectId: r.projectId, projectPath: r.projectPath })),
          }
        }
      }
    }

    // Upstream relevance
    if (config.upstreamRelevance && typeof config.upstreamRelevance === "object") {
      result.upstreamRelevance = {
        deploymentContext:
          typeof config.upstreamRelevance.deploymentContext === "string"
            ? config.upstreamRelevance.deploymentContext
            : undefined,
      }
    }

    // Process facilitation
    if (config.process && typeof config.process === "object") {
      const p = config.process
      result.process = {
        epicProblemMinWords: typeof p.epicProblemMinWords === "number" ? p.epicProblemMinWords : undefined,
        taskProblemMinWords: typeof p.taskProblemMinWords === "number" ? p.taskProblemMinWords : undefined,
        epicScopeMinWords: typeof p.epicScopeMinWords === "number" ? p.epicScopeMinWords : undefined,
        exemptions: p.exemptions && typeof p.exemptions === "object"
          ? {
              summaryPatterns: Array.isArray(p.exemptions.summaryPatterns) ? p.exemptions.summaryPatterns : undefined,
              labels: Array.isArray(p.exemptions.labels) ? p.exemptions.labels : undefined,
            }
          : undefined,
      }
    }

    log.info("loaded pal config", { path: configPath })
    return result
  } catch (err) {
    log.error("failed to load pal.json", { path: configPath, error: err })
    return DEFAULT_CONFIG
  }
}

function setupWatcher(configPath: string): void {
  if (watcher) {
    try {
      watcher.close()
    } catch {
      /* ignore */
    }
    watcher = undefined
  }

  const dir = path.dirname(configPath)
  const basename = path.basename(configPath)

  try {
    if (!fsNode.existsSync(dir)) return

    watcher = fsNode.watch(dir, (eventType, filename) => {
      if (filename !== basename) return
      log.info("pal.json changed, reloading", { eventType })

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
      log.warn("pal.json watcher error", { error: err })
    })
  } catch (err) {
    log.warn("failed to watch pal.json", { error: err })
  }
}

export function get(): PalConfig {
  const configPath = resolveConfigPath()

  if (cachedConfig && cachedPath === configPath) {
    return cachedConfig
  }

  cachedPath = configPath
  cachedConfig = loadFromDisk(configPath)
  setupWatcher(configPath)

  return cachedConfig
}

export function onChange(listener: (config: PalConfig) => void): () => void {
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
    } catch {
      /* ignore */
    }
    watcher = undefined
  }
  cachedConfig = undefined
  cachedPath = undefined
  changeListeners.length = 0
}

export * as PalConfig from "./pal-config"
