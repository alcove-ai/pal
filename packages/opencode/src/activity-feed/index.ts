import * as Log from "@opencode-ai/core/util/log"
import { Database } from "@/storage/db"
import { ActivityEventTable, PollStateTable } from "./activity-feed.sql"
import { desc, eq, and, lt, sql } from "drizzle-orm"
import type { PollingAdapter, ActivityEvent, ActivitySource, ActorType, PollState } from "./types"
import { createJiraAdapter } from "./jira-adapter"
import { createGitHubAdapter } from "./github-adapter"
import { createGitLabAdapter } from "./gitlab-adapter"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Effect, Layer, Context, Schema, Stream } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { EffectBridge } from "@/effect/bridge"
import { UpstreamRelevance } from "@/upstream-relevance"

const log = Log.create({ service: "activity-feed" })

const BASE_INTERVAL_MS = 90_000
const MAX_INTERVAL_MS = 300_000
const RECOVERY_THRESHOLD = 3
const RETENTION_DAYS = 30
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000
const PRUNE_BATCH_LIMIT = 500
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000

// Bus events
export const ActivityEventsUpdated = BusEvent.define(
  "activity.events.updated",
  Schema.Struct({
    count: Schema.Number,
    source: Schema.String,
  }),
)

export const ActivityPollStatus = BusEvent.define(
  "activity.poll.status",
  Schema.Struct({
    source: Schema.String,
    status: Schema.Union([Schema.Literal("ok"), Schema.Literal("error"), Schema.Literal("unavailable")]),
    consecutiveFailures: Schema.Number,
    lastSuccessTs: Schema.optional(Schema.Number),
  }),
)

// Service interface
export interface Interface {
  readonly start: () => Effect.Effect<void>
  readonly getEvents: (opts?: {
    limit?: number
    offset?: number
    source?: ActivitySource
    actorType?: ActorType
    unreadOnly?: boolean
  }) => Effect.Effect<ActivityEvent[]>
  readonly markRead: (id: string) => Effect.Effect<void>
  readonly markAllRead: () => Effect.Effect<void>
  readonly getUnreadCount: () => Effect.Effect<number>
  readonly getPollStatus: () => Effect.Effect<PollState[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ActivityFeed") {}

export const layer: Layer.Layer<Service, never, Bus.Service | MCP.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const mcp = yield* MCP.Service

    const adapters: PollingAdapter[] = []
    let pollCycleCount = 0
    let timer: ReturnType<typeof setInterval> | undefined

    // Create MCP tools accessor
    async function getMcpTools() {
      try {
        return await Effect.runPromise(mcp.tools())
      } catch {
        return undefined
      }
    }

    // Register adapters (each independently checks isAvailable before polling)
    adapters.push(createJiraAdapter(getMcpTools))
    adapters.push(createGitHubAdapter())
    adapters.push(createGitLabAdapter(getMcpTools))

    // --- Database helpers ---

    function insertEvents(events: ActivityEvent[]): number {
      if (events.length === 0) return 0
      let inserted = 0
      Database.use((db) => {
        for (const event of events) {
          try {
            db.insert(ActivityEventTable)
              .values({
                id: event.id,
                source: event.source,
                source_id: event.source_id,
                event_type: event.event_type,
                title: event.title,
                summary: event.summary,
                actor: event.actor,
                actor_type: event.actor_type,
                timestamp: event.timestamp,
                url: event.url,
                metadata: event.metadata,
                is_read: event.is_read,
                created_at: event.created_at,
              })
              .onConflictDoNothing()
              .run()
            inserted++
          } catch (err) {
            // INSERT OR IGNORE semantics via onConflictDoNothing
            log.debug("event insert conflict or error", {
              source_id: event.source_id,
              event_type: event.event_type,
              error: err,
            })
          }
        }
      })
      return inserted
    }

    function getPollState(source: string): PollState | undefined {
      return Database.use((db) => {
        const rows = db.select().from(PollStateTable).where(eq(PollStateTable.id, source)).limit(1).all()
        return rows[0] as PollState | undefined
      })
    }

    function upsertPollState(state: PollState): void {
      Database.use((db) => {
        db.insert(PollStateTable)
          .values({
            id: state.id,
            source: state.source,
            last_poll_ts: state.last_poll_ts,
            last_success_ts: state.last_success_ts,
            consecutive_failures: state.consecutive_failures,
          })
          .onConflictDoUpdate({
            target: PollStateTable.id,
            set: {
              last_poll_ts: state.last_poll_ts,
              last_success_ts: state.last_success_ts,
              consecutive_failures: state.consecutive_failures,
            },
          })
          .run()
      })
    }

    function pruneOldEvents(): void {
      const cutoff = Date.now() - RETENTION_MS
      Database.use((db) => {
        db.delete(ActivityEventTable).where(lt(ActivityEventTable.created_at, cutoff)).limit(PRUNE_BATCH_LIMIT).run()
      })
    }

    function queryEvents(opts?: {
      limit?: number
      offset?: number
      source?: ActivitySource
      actorType?: ActorType
      unreadOnly?: boolean
    }): ActivityEvent[] {
      return Database.use((db) => {
        const conditions = []
        if (opts?.source) {
          conditions.push(eq(ActivityEventTable.source, opts.source))
        }
        if (opts?.actorType) {
          conditions.push(eq(ActivityEventTable.actor_type, opts.actorType))
        }
        if (opts?.unreadOnly) {
          conditions.push(eq(ActivityEventTable.is_read, 0))
        }

        const where = conditions.length > 0 ? and(...conditions) : undefined

        return db
          .select()
          .from(ActivityEventTable)
          .where(where)
          .orderBy(desc(ActivityEventTable.timestamp))
          .limit(opts?.limit ?? 50)
          .offset(opts?.offset ?? 0)
          .all() as ActivityEvent[]
      })
    }

    function countUnread(): number {
      return Database.use((db) => {
        const result = db
          .select({ count: sql<number>`count(*)` })
          .from(ActivityEventTable)
          .where(eq(ActivityEventTable.is_read, 0))
          .get()
        return result?.count ?? 0
      })
    }

    // --- Polling logic ---

    function computeInterval(consecutiveFailures: number): number {
      if (consecutiveFailures === 0) return BASE_INTERVAL_MS
      return Math.min(BASE_INTERVAL_MS * (consecutiveFailures + 1), MAX_INTERVAL_MS)
    }

    let bridge: EffectBridge.Shape | undefined

    async function pollAdapter(adapter: PollingAdapter): Promise<void> {
      const source = adapter.source

      try {
        const available = await adapter.isAvailable()
        if (!available) {
          log.info("adapter not available, skipping", { source })
          if (bridge) {
            await bridge.promise(
              bus
                .publish(ActivityPollStatus, {
                  source,
                  status: "unavailable" as const,
                  consecutiveFailures: 0,
                })
                .pipe(Effect.ignore),
            )
          }
          return
        }

        const state = getPollState(source)
        const now = Date.now()

        // First run uses 24h lookback
        const _lookbackTs = state?.last_poll_ts ?? now - FIRST_RUN_LOOKBACK_MS

        const events = await adapter.poll()

        // Filter events to only those within our lookback window
        const filteredEvents = state
          ? events.filter((e) => e.timestamp >= (state.last_poll_ts ?? 0))
          : events.filter((e) => e.timestamp >= now - FIRST_RUN_LOOKBACK_MS)

        const inserted = insertEvents(filteredEvents)

        // Classify upstream events for relevance (non-blocking)
        if (inserted > 0) {
          try {
            await UpstreamRelevance.classifyBatch(filteredEvents)
          } catch (err) {
            log.debug("relevance classification failed", { error: err })
          }
        }

        const consecutiveFailures = state?.consecutive_failures ?? 0
        const newFailures =
          consecutiveFailures > 0 && consecutiveFailures <= RECOVERY_THRESHOLD ? consecutiveFailures - 1 : 0

        upsertPollState({
          id: source,
          source,
          last_poll_ts: now,
          last_success_ts: now,
          consecutive_failures: newFailures,
        })

        if (inserted > 0 && bridge) {
          await bridge.promise(
            bus.publish(ActivityEventsUpdated, { count: inserted, source }).pipe(Effect.ignore),
          )
        }

        if (bridge) {
          await bridge.promise(
            bus
              .publish(ActivityPollStatus, {
                source,
                status: "ok" as const,
                consecutiveFailures: newFailures,
                lastSuccessTs: now,
              })
              .pipe(Effect.ignore),
          )
        }

        log.info("poll complete", { source, events: events.length, filtered: filteredEvents.length, inserted })
      } catch (err) {
        log.error("poll failed", { source, error: err })

        const state = getPollState(source)
        const failures = (state?.consecutive_failures ?? 0) + 1

        upsertPollState({
          id: source,
          source,
          last_poll_ts: Date.now(),
          last_success_ts: state?.last_success_ts ?? null,
          consecutive_failures: failures,
        })

        if (bridge) {
          await bridge.promise(
            bus
              .publish(ActivityPollStatus, {
                source,
                status: "error" as const,
                consecutiveFailures: failures,
                lastSuccessTs: state?.last_success_ts ?? undefined,
              })
              .pipe(Effect.ignore),
          )
        }
      }
    }

    async function runPollCycle(): Promise<void> {
      pollCycleCount++

      // Prune every 10th cycle
      if (pollCycleCount % 10 === 0) {
        try {
          pruneOldEvents()
          log.info("pruned old events")
        } catch (err) {
          log.error("failed to prune old events", { error: err })
        }
      }

      for (const adapter of adapters) {
        await pollAdapter(adapter)
      }

      // Schedule next poll based on worst adapter state
      scheduleNextPoll()
    }

    function scheduleNextPoll(): void {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }

      let maxFailures = 0
      for (const adapter of adapters) {
        const state = getPollState(adapter.source)
        if (state && state.consecutive_failures > maxFailures) {
          maxFailures = state.consecutive_failures
        }
      }

      const interval = computeInterval(maxFailures)
      timer = setTimeout(() => {
        void runPollCycle()
      }, interval)
    }

    // --- Effect service ---

    const start = Effect.fn("ActivityFeed.start")(function* () {
      bridge = yield* EffectBridge.make()

      // Prune on startup
      try {
        pruneOldEvents()
      } catch (err) {
        log.error("failed to prune on startup", { error: err })
      }

      // Run first poll immediately
      void runPollCycle()

      log.info("activity feed started", { adapters: adapters.map((a) => a.source) })
    })

    const getEvents = Effect.fn("ActivityFeed.getEvents")(function* (opts?: {
      limit?: number
      offset?: number
      source?: ActivitySource
      actorType?: ActorType
      unreadOnly?: boolean
    }) {
      return queryEvents(opts)
    })

    const markRead = Effect.fn("ActivityFeed.markRead")(function* (id: string) {
      Database.use((db) => {
        db.update(ActivityEventTable).set({ is_read: 1 }).where(eq(ActivityEventTable.id, id)).run()
      })
    })

    const markAllRead = Effect.fn("ActivityFeed.markAllRead")(function* () {
      Database.use((db) => {
        db.update(ActivityEventTable).set({ is_read: 1 }).where(eq(ActivityEventTable.is_read, 0)).run()
      })
    })

    const getUnreadCount = Effect.fn("ActivityFeed.getUnreadCount")(function* () {
      return countUnread()
    })

    const getPollStatus = Effect.fn("ActivityFeed.getPollStatus")(function* () {
      return Database.use((db) => {
        return db.select().from(PollStateTable).all() as PollState[]
      })
    })

    return Service.of({
      start,
      getEvents,
      markRead,
      markAllRead,
      getUnreadCount,
      getPollStatus,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(MCP.defaultLayer))

export * as ActivityFeed from "."
