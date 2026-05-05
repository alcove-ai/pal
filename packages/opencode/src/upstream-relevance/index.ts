import * as Log from "@opencode-ai/core/util/log"
import { Database } from "@/storage/db"
import { ActivityEventTable } from "@/activity-feed/activity-feed.sql"
import { eq, and, isNull, sql as drizzleSql } from "drizzle-orm"
import { loadConfig } from "./config"
import { classifyLayer1 } from "./layer1"
import { classifyLayer2, resetPollBudget, canCallLayer2 } from "./layer2"
import type { ClassifiableEvent, RelevanceResult, UpstreamConfig } from "./types"

const log = Log.create({ service: "upstream-relevance" })

/** Sources considered "upstream" for relevance classification */
const UPSTREAM_SOURCES = new Set(["github", "gitlab"])

let config: UpstreamConfig | undefined

function getConfig(): UpstreamConfig {
  if (!config) {
    config = loadConfig()
  }
  return config
}

/** Reload config from disk (e.g., after upstream.yaml changes) */
export function reloadConfig(): void {
  config = loadConfig()
}

function persistResult(id: string, result: RelevanceResult): void {
  try {
    Database.use((db) => {
      db.update(ActivityEventTable)
        .set({
          relevance: result.level,
          relevance_reasoning: result.reasoning,
        })
        .where(eq(ActivityEventTable.id, id))
        .run()
    })
  } catch (err) {
    log.debug("failed to persist relevance result", { id, error: err })
  }
}

/** Classify a single event with Layer 1 only (synchronous, zero cost) */
export function classifySync(event: ClassifiableEvent): RelevanceResult {
  const cfg = getConfig()
  const layer1Result = classifyLayer1(event, cfg)
  if (layer1Result) {
    return layer1Result
  }
  return {
    level: "watch",
    reasoning: "Layer 1: no rule matched, defaulting to watch",
    layer: 1,
  }
}

/** Classify a single event with Layer 1 + Layer 2 (async, budget-capped) */
export async function classifyAsync(event: ClassifiableEvent): Promise<RelevanceResult> {
  const cfg = getConfig()

  // Layer 1 first
  const layer1Result = classifyLayer1(event, cfg)
  if (layer1Result) {
    return layer1Result
  }

  // Layer 2: LLM-based (async, budget-capped)
  if (canCallLayer2(cfg)) {
    const layer2Result = await classifyLayer2(event, cfg)
    if (layer2Result) {
      return layer2Result
    }
  }

  // Fallback
  return {
    level: "watch",
    reasoning: "No rule matched, LLM unavailable — defaulting to watch",
    layer: 1,
  }
}

/**
 * Classify a batch of newly-polled events.
 * Only classifies upstream events (github/gitlab).
 * Resets per-poll budget before starting.
 */
export async function classifyBatch(
  events: Array<ClassifiableEvent & { id: string }>,
): Promise<number> {
  const upstream = events.filter((e) => UPSTREAM_SOURCES.has(e.source))
  if (upstream.length === 0) return 0

  resetPollBudget()

  let classified = 0
  for (const event of upstream) {
    try {
      const result = await classifyAsync(event)
      persistResult(event.id, result)
      classified++
    } catch (err) {
      log.error("failed to classify event", { id: event.id, error: err })
    }
  }

  log.info("batch classification complete", {
    total: upstream.length,
    classified,
  })

  return classified
}

/**
 * Retroactively re-run Layer 1 on all upstream events.
 * Use after upstream.yaml config changes.
 */
export function reclassifyAllSync(): number {
  reloadConfig()

  const allEvents = Database.use((db) => {
    return db
      .select()
      .from(ActivityEventTable)
      .where(
        drizzleSql`${ActivityEventTable.source} IN ('github', 'gitlab')`,
      )
      .limit(1000)
      .all()
  })

  let classified = 0
  for (const row of allEvents) {
    const event: ClassifiableEvent = {
      title: row.title,
      summary: row.summary ?? null,
      event_type: row.event_type,
      source: row.source,
      actor: row.actor ?? null,
      metadata: (row.metadata as Record<string, unknown>) ?? null,
    }

    const result = classifySync(event)
    persistResult(row.id, result)
    classified++
  }

  log.info("retroactively reclassified all upstream events", { count: classified })
  return classified
}

export * as UpstreamRelevance from "."
