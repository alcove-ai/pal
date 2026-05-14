/**
 * Typed process config loader for `.opencode/process.yaml`.
 *
 * Defines the team's planning-process phases, per-issue-type rules,
 * default phase sequences, and exemption rules.  Falls back to a
 * built-in default that matches the hardcoded assessor behavior.
 *
 * Pattern follows pal-config.ts / domain-health/config.ts:
 *   - caching, file watching, defensive validation
 *   - `get()` for the current config
 */

import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Instance } from "@/project/instance"
import fsNode from "fs"
import path from "path"

const log = Log.create({ service: "process.config" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhaseContentRequirement {
  location: "description" | "sub_issues"
  header?: string
  min_words?: number
  min_count?: number
  alternate_patterns?: Array<{ regex: string }>
}

export interface SignOffCriterion {
  type: "comment_keyword"
  keyword: string
}

export interface PhaseDefinition {
  id: string
  name: string
  description?: string
  content: PhaseContentRequirement
  sign_off?: { mode: "any" | "all"; criteria: SignOffCriterion[] }
}

export interface IssueTypeRule {
  phases: string[]
  overrides?: Record<string, { content?: PhaseContentRequirement }>
}

export interface ProcessDefinition {
  version: number
  phases: PhaseDefinition[]
  issue_types: Record<string, IssueTypeRule>
  default_phases: string[]
  exemptions?: { summary_patterns?: string[]; labels?: string[] }
}

// ---------------------------------------------------------------------------
// Default config — mirrors the hardcoded assessor.ts behaviour
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ProcessDefinition = {
  version: 1,
  phases: [
    {
      id: "problem_statement",
      name: "Problem Statement",
      description: "A clearly articulated problem the work addresses",
      content: {
        location: "description",
        header: "^h3\\.\\s*Problem\\s+Statement\\s*$",
        min_words: 15,
        alternate_patterns: [
          { regex: "\\b(steps?\\s+to\\s+reproduce|expected|actual)\\b" },
        ],
      },
    },
    {
      id: "scope",
      name: "Scope of Work",
      description: "High-level scope outlining what is in / out",
      content: {
        location: "description",
        header: "^h2\\.\\s*Scope\\s+of\\s+Work\\s*$",
        min_words: 15,
      },
    },
  ],
  issue_types: {
    Epic: {
      phases: ["problem_statement", "scope"],
      overrides: {
        problem_statement: {
          content: {
            location: "description",
            header: "^h2\\.\\s*Problem\\s+Statement\\s*$",
            min_words: 20,
          },
        },
      },
    },
    Task: { phases: ["problem_statement"] },
    Bug: { phases: ["problem_statement"] },
    Story: { phases: ["problem_statement"] },
    "Sub-task": { phases: ["problem_statement"] },
  },
  default_phases: ["problem_statement"],
  exemptions: {
    summary_patterns: [
      "^Document\\s+",
      "\\bbump\\s+version\\b",
      "\\bfix\\s+typo\\b",
      "\\brename\\b",
    ],
    labels: ["chore", "housekeeping"],
  },
}

// ---------------------------------------------------------------------------
// Lightweight YAML parser
// ---------------------------------------------------------------------------
// Reuses the approach from upstream-relevance/config.ts but extended to
// handle the deeper nesting required by process.yaml.

function parseValue(raw: string): string | number | boolean {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "")
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  const num = Number(trimmed)
  if (!isNaN(num) && trimmed !== "") return num
  return trimmed
}

interface YamlNode {
  [key: string]: unknown
}

/**
 * Minimal indent-based YAML parser.
 * Handles mappings (key: value), sequences (- item), and nested structures.
 * Sufficient for the process.yaml schema; NOT a full YAML implementation.
 */
function parseYaml(content: string): YamlNode {
  const lines = content.split("\n").map((l) => l.replace(/\r$/, ""))

  function indentOf(line: string): number {
    const m = line.match(/^(\s*)/)
    return m ? m[1].length : 0
  }

  function parseBlock(start: number, minIndent: number): [YamlNode, number] {
    const result: YamlNode = {}
    let i = start

    while (i < lines.length) {
      const line = lines[i]

      // Skip blank / comment lines
      if (line.trim() === "" || line.trim().startsWith("#")) {
        i++
        continue
      }

      const indent = indentOf(line)
      if (indent < minIndent) break // dedented → parent owns this line

      // Sequence item at current level: handled by caller via parseSequence
      if (line.trim().startsWith("- ")) {
        break // let the caller handle sequences
      }

      // key: value or key:
      const kvMatch = line.match(/^(\s*)([a-zA-Z0-9_-]+):\s*(.*)$/)
      if (!kvMatch) {
        i++
        continue
      }

      const key = kvMatch[2]
      const valPart = kvMatch[3].trim()

      if (valPart === "" || valPart === "|" || valPart === ">") {
        // Peek ahead: could be a mapping, a sequence, or a multi-line scalar
        const nextNonBlank = findNextNonBlank(i + 1)
        if (nextNonBlank !== -1 && indentOf(lines[nextNonBlank]) > indent) {
          if (lines[nextNonBlank].trim().startsWith("- ")) {
            const [arr, nextI] = parseSequence(i + 1, indent + 1)
            result[key] = arr
            i = nextI
          } else {
            const [child, nextI] = parseBlock(i + 1, indent + 1)
            result[key] = child
            i = nextI
          }
        } else {
          result[key] = ""
          i++
        }
      } else {
        result[key] = parseValue(valPart)
        i++
      }
    }
    return [result, i]
  }

  function parseSequence(start: number, minIndent: number): [unknown[], number] {
    const arr: unknown[] = []
    let i = start

    while (i < lines.length) {
      const line = lines[i]
      if (line.trim() === "" || line.trim().startsWith("#")) {
        i++
        continue
      }
      const indent = indentOf(line)
      if (indent < minIndent) break

      if (line.trim().startsWith("- ")) {
        // Extract the content after "- "
        const afterDash = line.replace(/^\s*-\s*/, "")

        // Is this "- key: value" (inline mapping start)?
        const inlineKV = afterDash.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
        if (inlineKV) {
          // Start of a mapping item in the sequence
          const itemIndent = indentOf(line) + 2 // children indented further
          const firstKey = inlineKV[1]
          const firstVal = inlineKV[2].trim()

          const obj: YamlNode = {}
          if (firstVal === "") {
            // Sub-block under this key
            const nextNonBlank = findNextNonBlank(i + 1)
            if (nextNonBlank !== -1 && indentOf(lines[nextNonBlank]) >= itemIndent) {
              if (lines[nextNonBlank].trim().startsWith("- ")) {
                const [subArr, nextI] = parseSequence(i + 1, itemIndent)
                obj[firstKey] = subArr
                i = nextI
              } else {
                const [child, nextI] = parseBlock(i + 1, itemIndent)
                obj[firstKey] = child
                i = nextI
              }
            } else {
              obj[firstKey] = ""
              i++
            }
          } else {
            obj[firstKey] = parseValue(firstVal)
            i++
          }

          // Continue reading sibling keys at itemIndent level
          while (i < lines.length) {
            const nextLine = lines[i]
            if (nextLine.trim() === "" || nextLine.trim().startsWith("#")) {
              i++
              continue
            }
            const nextIndent = indentOf(nextLine)
            if (nextIndent < itemIndent) break
            if (nextLine.trim().startsWith("- ")) break // next sequence item

            const sibKV = nextLine.match(/^(\s*)([a-zA-Z0-9_-]+):\s*(.*)$/)
            if (sibKV) {
              const sibKey = sibKV[2]
              const sibVal = sibKV[3].trim()
              if (sibVal === "") {
                const peekNext = findNextNonBlank(i + 1)
                if (peekNext !== -1 && indentOf(lines[peekNext]) > nextIndent) {
                  if (lines[peekNext].trim().startsWith("- ")) {
                    const [subArr, nextI] = parseSequence(i + 1, nextIndent + 1)
                    obj[sibKey] = subArr
                    i = nextI
                  } else {
                    const [child, nextI] = parseBlock(i + 1, nextIndent + 1)
                    obj[sibKey] = child
                    i = nextI
                  }
                } else {
                  obj[sibKey] = ""
                  i++
                }
              } else {
                obj[sibKey] = parseValue(sibVal)
                i++
              }
            } else {
              i++
            }
          }

          arr.push(obj)
        } else {
          // Simple scalar item: "- value"
          arr.push(parseValue(afterDash))
          i++
        }
      } else {
        break
      }
    }
    return [arr, i]
  }

  function findNextNonBlank(from: number): number {
    for (let j = from; j < lines.length; j++) {
      const t = lines[j].trim()
      if (t !== "" && !t.startsWith("#")) return j
    }
    return -1
  }

  const [result] = parseBlock(0, 0)
  return result
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateContentReq(raw: unknown): PhaseContentRequirement | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const obj = raw as Record<string, unknown>

  const location = obj.location === "description" || obj.location === "sub_issues"
    ? obj.location
    : "description"

  const result: PhaseContentRequirement = { location }

  if (typeof obj.header === "string") result.header = obj.header
  if (typeof obj.min_words === "number") result.min_words = obj.min_words
  if (typeof obj.min_count === "number") result.min_count = obj.min_count

  if (Array.isArray(obj.alternate_patterns)) {
    const patterns: Array<{ regex: string }> = []
    for (const p of obj.alternate_patterns) {
      if (p && typeof p === "object" && typeof (p as Record<string, unknown>).regex === "string") {
        patterns.push({ regex: (p as Record<string, unknown>).regex as string })
      }
    }
    if (patterns.length > 0) result.alternate_patterns = patterns
  }

  return result
}

function validateSignOff(raw: unknown): PhaseDefinition["sign_off"] | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const obj = raw as Record<string, unknown>

  const mode = obj.mode === "any" || obj.mode === "all" ? obj.mode : "any"
  const criteria: SignOffCriterion[] = []

  if (Array.isArray(obj.criteria)) {
    for (const c of obj.criteria) {
      if (c && typeof c === "object") {
        const cr = c as Record<string, unknown>
        if (cr.type === "comment_keyword" && typeof cr.keyword === "string") {
          criteria.push({ type: "comment_keyword", keyword: cr.keyword })
        }
      }
    }
  }

  return criteria.length > 0 ? { mode, criteria } : undefined
}

function validatePhase(raw: unknown): PhaseDefinition | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>

  if (typeof obj.id !== "string" || typeof obj.name !== "string") return null

  const content = validateContentReq(obj.content)
  if (!content) return null

  const phase: PhaseDefinition = {
    id: obj.id,
    name: obj.name,
    content,
  }

  if (typeof obj.description === "string") phase.description = obj.description

  const signOff = validateSignOff(obj.sign_off)
  if (signOff) phase.sign_off = signOff

  return phase
}

function validateIssueTypeRule(raw: unknown): IssueTypeRule | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>

  if (!Array.isArray(obj.phases)) return null
  const phases = (obj.phases as unknown[]).filter((p): p is string => typeof p === "string")
  if (phases.length === 0) return null

  const rule: IssueTypeRule = { phases }

  if (obj.overrides && typeof obj.overrides === "object") {
    const overrides: Record<string, { content?: PhaseContentRequirement }> = {}
    for (const [key, val] of Object.entries(obj.overrides as Record<string, unknown>)) {
      if (val && typeof val === "object") {
        const ov = val as Record<string, unknown>
        const content = validateContentReq(ov.content)
        if (content) {
          overrides[key] = { content }
        }
      }
    }
    if (Object.keys(overrides).length > 0) rule.overrides = overrides
  }

  return rule
}

function validateConfig(parsed: Record<string, unknown>): ProcessDefinition {
  const config: ProcessDefinition = {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    phases: [],
    issue_types: {},
    default_phases: [],
  }

  // Phases
  if (Array.isArray(parsed.phases)) {
    for (const raw of parsed.phases) {
      const phase = validatePhase(raw)
      if (phase) config.phases.push(phase)
    }
  }

  // Issue types
  if (parsed.issue_types && typeof parsed.issue_types === "object") {
    for (const [key, val] of Object.entries(parsed.issue_types as Record<string, unknown>)) {
      const rule = validateIssueTypeRule(val)
      if (rule) config.issue_types[key] = rule
    }
  }

  // Default phases
  if (Array.isArray(parsed.default_phases)) {
    config.default_phases = (parsed.default_phases as unknown[]).filter(
      (p): p is string => typeof p === "string",
    )
  }

  // Exemptions
  if (parsed.exemptions && typeof parsed.exemptions === "object") {
    const ex = parsed.exemptions as Record<string, unknown>
    config.exemptions = {
      summary_patterns: Array.isArray(ex.summary_patterns)
        ? (ex.summary_patterns as unknown[]).filter((s): s is string => typeof s === "string")
        : undefined,
      labels: Array.isArray(ex.labels)
        ? (ex.labels as unknown[]).filter((s): s is string => typeof s === "string")
        : undefined,
    }
  }

  // Sanity: if no phases loaded, fall back to defaults
  if (config.phases.length === 0) {
    log.warn("process.yaml has no valid phases, falling back to defaults")
    return DEFAULT_CONFIG
  }

  return config
}

// ---------------------------------------------------------------------------
// Caching & file watcher  (mirrors pal-config.ts pattern)
// ---------------------------------------------------------------------------

let cachedConfig: ProcessDefinition | undefined
let cachedPath: string | undefined
let watcher: fsNode.FSWatcher | undefined
const changeListeners: Array<(config: ProcessDefinition) => void> = []

function resolveConfigPath(): string {
  try {
    const dir = Instance.directory
    return path.join(dir, ".opencode", "process.yaml")
  } catch {
    return path.join(Global.Path.config, "process.yaml")
  }
}

function loadFromDisk(configPath: string): ProcessDefinition {
  try {
    if (!fsNode.existsSync(configPath)) {
      log.info("no process.yaml found, using defaults", { path: configPath })
      return DEFAULT_CONFIG
    }

    const raw = fsNode.readFileSync(configPath, "utf-8")
    const parsed = parseYaml(raw)

    const config = validateConfig(parsed)
    log.info("loaded process config", {
      path: configPath,
      phases: config.phases.length,
      issueTypes: Object.keys(config.issue_types).length,
    })
    return config
  } catch (err) {
    log.error("failed to load process.yaml, using defaults", { path: configPath, error: err })
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
      log.info("process.yaml changed, reloading", { eventType })

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
      log.warn("process.yaml watcher error", { error: err })
    })
  } catch (err) {
    log.warn("failed to watch process.yaml", { error: err })
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the current process definition (cached, watched for changes).
 * If `.opencode/process.yaml` does not exist, returns built-in defaults
 * matching the original hardcoded assessor behaviour.
 */
export function getProcessConfig(): ProcessDefinition {
  const configPath = resolveConfigPath()

  if (cachedConfig && cachedPath === configPath) {
    return cachedConfig
  }

  cachedPath = configPath
  cachedConfig = loadFromDisk(configPath)
  setupWatcher(configPath)

  return cachedConfig
}

/**
 * Look up the ordered phase definitions for a given Jira issue type.
 *
 * 1. If `issueType` has an explicit entry in `issue_types`, use its phases list.
 * 2. Otherwise fall back to `default_phases`.
 * 3. For each phase id, resolve the full `PhaseDefinition`, applying any
 *    per-issue-type overrides.
 */
export function getPhasesForIssueType(issueType: string): PhaseDefinition[] {
  const config = getProcessConfig()
  const rule = config.issue_types[issueType]
  const phaseIds = rule ? rule.phases : config.default_phases

  const phaseMap = new Map(config.phases.map((p) => [p.id, p]))

  return phaseIds
    .map((id) => {
      const base = phaseMap.get(id)
      if (!base) return null

      // Apply issue-type-specific overrides
      const override = rule?.overrides?.[id]
      if (!override) return base

      return {
        ...base,
        content: override.content ?? base.content,
      }
    })
    .filter((p): p is PhaseDefinition => p !== null)
}

/** Register a listener that fires whenever process.yaml changes on disk. */
export function onChange(listener: (config: ProcessDefinition) => void): () => void {
  changeListeners.push(listener)
  return () => {
    const idx = changeListeners.indexOf(listener)
    if (idx >= 0) changeListeners.splice(idx, 1)
  }
}

/** Tear down the file watcher and clear the cache. */
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

export * as ProcessConfig from "./process-config"
