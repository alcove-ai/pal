import * as Log from "@opencode-ai/core/util/log"
import path from "path"
import { existsSync, readFileSync } from "fs"
import type { UpstreamConfig, UpstreamRule } from "./types"

const log = Log.create({ service: "upstream-relevance.config" })

const DEFAULT_CONFIG: UpstreamConfig = {
  "must-act": {
    labels: ["security", "CVE", "cve", "breaking", "breaking-change", "critical", "vulnerability"],
    keywords: ["CVE-", "security fix", "breaking change", "data loss", "privilege escalation"],
    paths: [],
  },
  review: {
    labels: ["bug", "bugfix", "regression", "performance"],
    keywords: ["fix:", "bugfix:", "regression", "performance degradation"],
    paths: ["pulpcore/app/", "pulpcore/content/", "pulp_rpm/", "pulp_file/"],
  },
  watch: {
    labels: ["enhancement", "feature", "refactor"],
    keywords: ["feat:", "refactor:", "deprecate"],
    paths: ["docs/", "CHANGES/"],
  },
  noise: {
    labels: ["chore", "ci", "test", "typo", "cosmetic"],
    keywords: ["chore:", "ci:", "test:", "typo", "bump version", "update changelog"],
    paths: [".github/", ".ci/", "towncrier/", "MANIFEST.in"],
  },
  layer2: {
    maxCallsPerPoll: 20,
    dailySoftCap: 200,
    circuitBreakerThreshold: 3,
    model: "claude-sonnet-4-5-20250514",
  },
}

function parseYaml(content: string): Record<string, unknown> {
  // Lightweight YAML parser for our simple config structure.
  // Handles nested keys, arrays (- item), and string/number values.
  const result: Record<string, unknown> = {}
  const lines = content.split("\n")
  let currentKey = ""
  let currentObj: Record<string, unknown> = result
  let currentArray: string[] | null = null
  let currentArrayKey = ""

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "")

    // Skip comments and empty lines
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue
    }

    // Array item
    const arrayMatch = line.match(/^(\s+)-\s+(.+)$/)
    if (arrayMatch && currentArray !== null) {
      const value = arrayMatch[2].trim().replace(/^["']|["']$/g, "")
      currentArray.push(value)
      continue
    }

    // Flush any pending array
    if (currentArray !== null) {
      currentObj[currentArrayKey] = currentArray
      currentArray = null
    }

    // Top-level key (no indentation)
    const topKeyMatch = line.match(/^([a-zA-Z0-9_-]+):\s*$/)
    if (topKeyMatch) {
      currentKey = topKeyMatch[1]
      const obj: Record<string, unknown> = {}
      result[currentKey] = obj
      currentObj = obj
      continue
    }

    // Top-level key with value
    const topKVMatch = line.match(/^([a-zA-Z0-9_-]+):\s+(.+)$/)
    if (topKVMatch) {
      currentKey = topKVMatch[1]
      result[currentKey] = parseValue(topKVMatch[2])
      currentObj = result
      continue
    }

    // Nested key with empty value (array or sub-object follows)
    const nestedEmptyMatch = line.match(/^\s+([a-zA-Z0-9_-]+):\s*$/)
    if (nestedEmptyMatch) {
      currentArrayKey = nestedEmptyMatch[1]
      currentArray = []
      continue
    }

    // Nested key with value
    const nestedKVMatch = line.match(/^\s+([a-zA-Z0-9_-]+):\s+(.+)$/)
    if (nestedKVMatch) {
      currentObj[nestedKVMatch[1]] = parseValue(nestedKVMatch[2])
      continue
    }
  }

  // Flush trailing array
  if (currentArray !== null) {
    currentObj[currentArrayKey] = currentArray
  }

  return result
}

function parseValue(raw: string): string | number | boolean {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "")
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  const num = Number(trimmed)
  if (!isNaN(num) && trimmed !== "") return num
  return trimmed
}

function mergeRule(base: UpstreamRule, override: Record<string, unknown> | undefined): UpstreamRule {
  if (!override) return base
  return {
    paths: Array.isArray(override.paths) ? (override.paths as string[]) : base.paths,
    labels: Array.isArray(override.labels) ? (override.labels as string[]) : base.labels,
    keywords: Array.isArray(override.keywords) ? (override.keywords as string[]) : base.keywords,
  }
}

export function loadConfig(): UpstreamConfig {
  const configPath = path.join(process.cwd(), "upstream.yaml")

  if (!existsSync(configPath)) {
    log.info("no upstream.yaml found, using defaults")
    return DEFAULT_CONFIG
  }

  try {
    const content = readFileSync(configPath, "utf-8")
    const parsed = parseYaml(content)

    const config: UpstreamConfig = {
      "must-act": mergeRule(DEFAULT_CONFIG["must-act"], parsed["must-act"] as Record<string, unknown>),
      review: mergeRule(DEFAULT_CONFIG.review, parsed["review"] as Record<string, unknown>),
      watch: mergeRule(DEFAULT_CONFIG.watch, parsed["watch"] as Record<string, unknown>),
      noise: mergeRule(DEFAULT_CONFIG.noise, parsed["noise"] as Record<string, unknown>),
      layer2: {
        ...DEFAULT_CONFIG.layer2,
        ...(typeof parsed.layer2 === "object" && parsed.layer2 !== null
          ? {
              maxCallsPerPoll:
                typeof (parsed.layer2 as Record<string, unknown>).maxCallsPerPoll === "number"
                  ? ((parsed.layer2 as Record<string, unknown>).maxCallsPerPoll as number)
                  : DEFAULT_CONFIG.layer2.maxCallsPerPoll,
              dailySoftCap:
                typeof (parsed.layer2 as Record<string, unknown>).dailySoftCap === "number"
                  ? ((parsed.layer2 as Record<string, unknown>).dailySoftCap as number)
                  : DEFAULT_CONFIG.layer2.dailySoftCap,
              circuitBreakerThreshold:
                typeof (parsed.layer2 as Record<string, unknown>).circuitBreakerThreshold === "number"
                  ? ((parsed.layer2 as Record<string, unknown>).circuitBreakerThreshold as number)
                  : DEFAULT_CONFIG.layer2.circuitBreakerThreshold,
              model:
                typeof (parsed.layer2 as Record<string, unknown>).model === "string"
                  ? ((parsed.layer2 as Record<string, unknown>).model as string)
                  : DEFAULT_CONFIG.layer2.model,
            }
          : {}),
      },
    }

    log.info("loaded upstream.yaml config", { path: configPath })
    return config
  } catch (err) {
    log.error("failed to parse upstream.yaml, using defaults", { error: err })
    return DEFAULT_CONFIG
  }
}

export function getDefaultConfig(): UpstreamConfig {
  return DEFAULT_CONFIG
}
