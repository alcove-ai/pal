import type { UpstreamConfig, ClassifiableEvent, RelevanceResult, RelevanceLevel } from "./types"

/**
 * Layer 1: Rule-based classifier.
 * Synchronous, zero-cost. Matches keywords, labels, and paths from upstream.yaml.
 * Returns a result if a rule matches, or null if Layer 2 should be consulted.
 */
export function classifyLayer1(event: ClassifiableEvent, config: UpstreamConfig): RelevanceResult | null {
  // Check levels in priority order: must-act > review > noise > watch
  // noise before watch so explicit noise rules take precedence
  const levels: RelevanceLevel[] = ["must-act", "review", "noise", "watch"]

  for (const level of levels) {
    const rule = config[level]
    const match = matchRule(event, rule)
    if (match) {
      return {
        level,
        reasoning: `Layer 1: ${match}`,
        layer: 1,
      }
    }
  }

  return null
}

function matchRule(
  event: ClassifiableEvent,
  rule: { labels?: string[]; keywords?: string[]; paths?: string[] },
): string | null {
  const text = buildSearchText(event)
  const labels = extractLabels(event)
  const paths = extractPaths(event)

  // Check labels
  if (rule.labels && rule.labels.length > 0) {
    for (const ruleLabel of rule.labels) {
      const lower = ruleLabel.toLowerCase()
      for (const eventLabel of labels) {
        if (eventLabel.toLowerCase() === lower) {
          return `label match: "${ruleLabel}"`
        }
      }
    }
  }

  // Check keywords (case-insensitive substring match)
  if (rule.keywords && rule.keywords.length > 0) {
    const lowerText = text.toLowerCase()
    for (const keyword of rule.keywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        return `keyword match: "${keyword}"`
      }
    }
  }

  // Check paths (prefix match)
  if (rule.paths && rule.paths.length > 0) {
    for (const rulePath of rule.paths) {
      for (const eventPath of paths) {
        if (eventPath.startsWith(rulePath) || eventPath.includes(rulePath)) {
          return `path match: "${rulePath}"`
        }
      }
    }
  }

  return null
}

function buildSearchText(event: ClassifiableEvent): string {
  const parts = [event.title]
  if (event.summary) parts.push(event.summary)

  if (event.metadata) {
    // Include PR/issue body if available
    if (typeof event.metadata.body === "string") parts.push(event.metadata.body)
    // Include branch name
    if (typeof event.metadata.branch === "string") parts.push(event.metadata.branch)
    // Include commit messages
    if (typeof event.metadata.commit_message === "string") parts.push(event.metadata.commit_message)
  }

  return parts.join(" ")
}

function extractLabels(event: ClassifiableEvent): string[] {
  if (!event.metadata) return []

  const labels: string[] = []

  if (Array.isArray(event.metadata.labels)) {
    for (const label of event.metadata.labels) {
      if (typeof label === "string") labels.push(label)
      else if (typeof label === "object" && label !== null && "name" in label && typeof label.name === "string") {
        labels.push(label.name)
      }
    }
  }

  return labels
}

function extractPaths(event: ClassifiableEvent): string[] {
  if (!event.metadata) return []

  const paths: string[] = []

  if (Array.isArray(event.metadata.files)) {
    for (const f of event.metadata.files) {
      if (typeof f === "string") paths.push(f)
      else if (typeof f === "object" && f !== null && "filename" in f && typeof f.filename === "string") {
        paths.push(f.filename)
      }
    }
  }

  // Also consider the repo path as context
  if (typeof event.metadata.repo === "string") {
    paths.push(event.metadata.repo)
  }

  return paths
}
