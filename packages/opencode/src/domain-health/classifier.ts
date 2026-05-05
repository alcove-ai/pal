import type { ActivityEvent } from "@/activity-feed/types"
import type { DomainConfig, DomainsConfig } from "./config"

export interface ClassifiedEvent {
  event: ActivityEvent
  domains: string[]
}

/**
 * Maps an activity event to the domains it belongs to.
 * An event can match multiple domains (multi-domain counting).
 * Events that match no domain fall into the "Uncategorized" bucket.
 */
export function classifyEvent(event: ActivityEvent, config: DomainsConfig): string[] {
  const matched: string[] = []

  for (const domain of config.domains) {
    if (matchesDomain(event, domain)) {
      matched.push(domain.name)
    }
  }

  return matched
}

/**
 * Classify a batch of events, returning per-domain event lists
 * plus an uncategorized bucket.
 */
export function classifyEvents(
  events: ActivityEvent[],
  config: DomainsConfig,
): { byDomain: Map<string, ActivityEvent[]>; uncategorized: ActivityEvent[] } {
  const byDomain = new Map<string, ActivityEvent[]>()

  // Initialize domain buckets
  for (const domain of config.domains) {
    byDomain.set(domain.name, [])
  }

  const uncategorized: ActivityEvent[] = []

  for (const event of events) {
    const domains = classifyEvent(event, config)

    if (domains.length === 0) {
      uncategorized.push(event)
    } else {
      for (const domainName of domains) {
        const list = byDomain.get(domainName)
        if (list) {
          list.push(event)
        }
      }
    }
  }

  return { byDomain, uncategorized }
}

function matchesDomain(event: ActivityEvent, domain: DomainConfig): boolean {
  const meta = event.metadata as Record<string, unknown> | null

  // Match by Jira components
  if (domain.jira_components.length > 0 && meta) {
    const eventComponents = extractComponents(meta)
    for (const comp of domain.jira_components) {
      if (eventComponents.some((c) => c.toLowerCase() === comp.toLowerCase())) {
        return true
      }
    }
  }

  // Match by Jira labels
  if (domain.jira_labels.length > 0 && meta) {
    const eventLabels = extractLabels(meta)
    for (const label of domain.jira_labels) {
      if (eventLabels.some((l) => l.toLowerCase() === label.toLowerCase())) {
        return true
      }
    }
  }

  // Match by repo globs (check URL or metadata for repo info)
  if (domain.repo_globs.length > 0) {
    const repoUrl = event.url ?? ""
    const prUrls = (meta?.github_pr_urls as string[]) ?? []
    const allUrls = [repoUrl, ...prUrls]

    for (const glob of domain.repo_globs) {
      for (const url of allUrls) {
        if (matchGlob(url, glob)) {
          return true
        }
      }
    }
  }

  return false
}

function extractComponents(meta: Record<string, unknown>): string[] {
  if (Array.isArray(meta.components)) {
    return meta.components.filter((c): c is string => typeof c === "string")
  }
  if (typeof meta.component === "string") {
    return [meta.component]
  }
  return []
}

function extractLabels(meta: Record<string, unknown>): string[] {
  if (Array.isArray(meta.labels)) {
    return meta.labels.filter((l): l is string => typeof l === "string")
  }
  return []
}

/**
 * Simple glob matching for repo URLs.
 * Supports * as wildcard for path segments.
 */
function matchGlob(url: string, glob: string): boolean {
  if (!url || !glob) return false

  // Convert glob to regex
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  try {
    const regex = new RegExp(escaped, "i")
    return regex.test(url)
  } catch {
    return false
  }
}

export * as Classifier from "./classifier"
