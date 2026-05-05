import * as Log from "@opencode-ai/core/util/log"
import { Database } from "@/storage/db"
import { ActivityEventTable } from "@/activity-feed/activity-feed.sql"
import { desc } from "drizzle-orm"
import type { ActivityEvent } from "@/activity-feed/types"
import { DomainConfig } from "./config"
import { Classifier } from "./classifier"
import { Health } from "./health"
import type { DomainsConfig, DomainConfig as DomainConfigType } from "./config"
import type { HealthSignals } from "./health"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Effect, Layer, Context, Schema } from "effect"

const log = Log.create({ service: "domain-health" })

const MAX_EVENTS = 500

// Bus event emitted when domain health is recomputed
export const DomainHealthUpdated = BusEvent.define(
  "domain.health.updated",
  Schema.Struct({
    domainCount: Schema.Number,
    uncategorizedCount: Schema.Number,
  }),
)

export interface DomainHealthSummary {
  name: string
  owner: string
  eventCount: number
  health: HealthSignals
}

export interface DomainHealthSnapshot {
  domains: DomainHealthSummary[]
  uncategorized: {
    eventCount: number
    health: HealthSignals
    /** True if uncategorized events are >20% of total */
    highUncategorized: boolean
  }
  totalEvents: number
  config: DomainsConfig
  computedAt: number
}

// Service interface
export interface Interface {
  readonly getSnapshot: () => Effect.Effect<DomainHealthSnapshot>
  readonly getDomainEvents: (domainName: string) => Effect.Effect<ActivityEvent[]>
  readonly getConfig: () => Effect.Effect<DomainsConfig>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DomainHealth") {}

export const layer: Layer.Layer<Service, never, Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    let cachedSnapshot: DomainHealthSnapshot | undefined
    let lastComputeTs = 0
    const CACHE_TTL_MS = 15_000

    // Subscribe to config changes and invalidate cache
    DomainConfig.onChange(() => {
      log.info("domains config changed, invalidating cache")
      cachedSnapshot = undefined
      lastComputeTs = 0
    })

    function loadEvents(): ActivityEvent[] {
      try {
        return Database.use((db) => {
          return db
            .select()
            .from(ActivityEventTable)
            .orderBy(desc(ActivityEventTable.timestamp))
            .limit(MAX_EVENTS)
            .all() as ActivityEvent[]
        })
      } catch {
        return []
      }
    }

    function computeSnapshot(): DomainHealthSnapshot {
      const now = Date.now()

      // Use cached if fresh enough
      if (cachedSnapshot && now - lastComputeTs < CACHE_TTL_MS) {
        return cachedSnapshot
      }

      const config = DomainConfig.get()
      const events = loadEvents()
      const { byDomain, uncategorized } = Classifier.classifyEvents(events, config)

      const domains: DomainHealthSummary[] = []

      for (const domainDef of config.domains) {
        const domainEvents = byDomain.get(domainDef.name) ?? []
        const health = Health.computeHealth(domainEvents)
        domains.push({
          name: domainDef.name,
          owner: domainDef.owner,
          eventCount: domainEvents.length,
          health,
        })
      }

      const uncatHealth = Health.computeHealth(uncategorized)
      const totalEvents = events.length
      const highUncategorized = totalEvents > 0 && uncategorized.length / totalEvents > 0.2

      const snapshot: DomainHealthSnapshot = {
        domains,
        uncategorized: {
          eventCount: uncategorized.length,
          health: uncatHealth,
          highUncategorized,
        },
        totalEvents,
        config,
        computedAt: now,
      }

      cachedSnapshot = snapshot
      lastComputeTs = now

      return snapshot
    }

    const getSnapshot = Effect.fn("DomainHealth.getSnapshot")(function* () {
      return computeSnapshot()
    })

    const getDomainEvents = Effect.fn("DomainHealth.getDomainEvents")(function* (domainName: string) {
      const config = DomainConfig.get()
      const events = loadEvents()

      if (domainName === "__uncategorized__") {
        const { uncategorized } = Classifier.classifyEvents(events, config)
        return uncategorized
      }

      const { byDomain } = Classifier.classifyEvents(events, config)
      return byDomain.get(domainName) ?? []
    })

    const getConfig = Effect.fn("DomainHealth.getConfig")(function* () {
      return DomainConfig.get()
    })

    return Service.of({
      getSnapshot,
      getDomainEvents,
      getConfig,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as DomainHealth from "."
