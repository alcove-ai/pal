import * as Log from "@opencode-ai/core/util/log"
import { Database } from "@/storage/db"
import { DismissedEventTable, SuppressionPatternTable } from "./needs-me.sql"
import { ActivityEventTable } from "@/activity-feed/activity-feed.sql"
import { desc, eq, and, lt, gt, sql } from "drizzle-orm"
import type { ActivityEvent } from "@/activity-feed/types"
import { classify, type NeedsMeConfig, type NeedsMeItem } from "./classifier"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Effect, Layer, Context, Schema } from "effect"
import { Identifier } from "@/id/id"

const log = Log.create({ service: "needs-me" })

/** Number of dismissals before auto-suppression triggers */
const AUTO_SUPPRESS_THRESHOLD = 3

/** Suppression decay: 30 days with no matching events */
const SUPPRESSION_DECAY_MS = 30 * 24 * 60 * 60 * 1000

/** Queue overflow threshold */
const OVERFLOW_THRESHOLD = 20

/** Sustained overflow duration (2 hours) */
const OVERFLOW_SUSTAIN_MS = 2 * 60 * 60 * 1000

/** Snooze presets in milliseconds */
export const SNOOZE_DURATIONS = {
  "1h": 1 * 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  tomorrow: 16 * 60 * 60 * 1000, // ~next morning
  "next-week": 7 * 24 * 60 * 60 * 1000,
} as const

export type SnoozeDuration = keyof typeof SNOOZE_DURATIONS

// --- Bus events ---

export const NeedsMeQueueUpdated = BusEvent.define(
  "needsme.queue.updated",
  Schema.Struct({
    itemCount: Schema.Number,
    overflowAlert: Schema.Boolean,
  }),
)

// --- Service interface ---

export interface Interface {
  /** Recompute the queue from current activity events */
  readonly refresh: () => Effect.Effect<NeedsMeItem[]>
  /** Get the current queue (cached from last refresh) */
  readonly getQueue: () => Effect.Effect<NeedsMeItem[]>
  /** Dismiss an item permanently (re-appears only on new event) */
  readonly dismiss: (workItemKey: string, ruleSource: string) => Effect.Effect<void>
  /** Snooze an item for a duration */
  readonly snooze: (workItemKey: string, ruleSource: string, duration: SnoozeDuration) => Effect.Effect<void>
  /** Get the overflow alert state */
  readonly getOverflowAlert: () => Effect.Effect<{ active: boolean; since: number | null }>
  /** Get the last-checked timestamp */
  readonly getLastChecked: () => Effect.Effect<number | null>
  /** Update scoring config (takes effect on next refresh) */
  readonly setConfig: (config: NeedsMeConfig) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/NeedsMe") {}

export const layer: Layer.Layer<Service, never, Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    let cachedQueue: NeedsMeItem[] = []
    let lastCheckedTs: number | null = null
    let overflowSince: number | null = null
    let scoringConfig: NeedsMeConfig = {}

    // --- Database helpers ---

    function getDismissedKeys(): Set<string> {
      return Database.use((db) => {
        const rows = db
          .select({ work_item_key: DismissedEventTable.work_item_key })
          .from(DismissedEventTable)
          .where(eq(DismissedEventTable.action, "dismiss"))
          .all()
        return new Set(rows.map((r) => r.work_item_key))
      })
    }

    function getSnoozedKeys(): Map<string, number> {
      const now = Date.now()
      return Database.use((db) => {
        const rows = db
          .select({
            work_item_key: DismissedEventTable.work_item_key,
            snooze_until: DismissedEventTable.snooze_until,
          })
          .from(DismissedEventTable)
          .where(
            and(
              eq(DismissedEventTable.action, "snooze"),
              gt(DismissedEventTable.snooze_until, now),
            ),
          )
          .all()
        const map = new Map<string, number>()
        for (const r of rows) {
          if (r.snooze_until) map.set(r.work_item_key, r.snooze_until)
        }
        return map
      })
    }

    function getSuppressedRuleSources(): Set<string> {
      const cutoff = Date.now() - SUPPRESSION_DECAY_MS
      return Database.use((db) => {
        const rows = db
          .select({ rule_source: SuppressionPatternTable.rule_source })
          .from(SuppressionPatternTable)
          .where(gt(SuppressionPatternTable.last_matched_at, cutoff))
          .all()
        return new Set(rows.map((r) => r.rule_source))
      })
    }

    function countDismissalsForRuleSource(ruleSource: string): number {
      return Database.use((db) => {
        const result = db
          .select({ count: sql<number>`count(*)` })
          .from(DismissedEventTable)
          .where(
            and(
              eq(DismissedEventTable.rule_source, ruleSource),
              eq(DismissedEventTable.action, "dismiss"),
            ),
          )
          .get()
        return result?.count ?? 0
      })
    }

    function insertDismissal(workItemKey: string, ruleSource: string, action: "dismiss" | "snooze", snoozeUntil: number | null): void {
      Database.use((db) => {
        db.insert(DismissedEventTable)
          .values({
            id: Identifier.create("nmd", "ascending"),
            work_item_key: workItemKey,
            action,
            snooze_until: snoozeUntil,
            rule_source: ruleSource,
            dismissed_at: Date.now(),
          })
          .run()
      })
    }

    function upsertSuppression(ruleSource: string, dismissCount: number): void {
      const now = Date.now()
      Database.use((db) => {
        db.insert(SuppressionPatternTable)
          .values({
            id: Identifier.create("nms", "ascending"),
            rule_source: ruleSource,
            dismiss_count: dismissCount,
            created_at: now,
            last_matched_at: now,
          })
          .onConflictDoUpdate({
            target: SuppressionPatternTable.rule_source,
            set: {
              dismiss_count: dismissCount,
              last_matched_at: now,
            },
          })
          .run()
      })
    }

    function touchSuppression(ruleSource: string): void {
      Database.use((db) => {
        db.update(SuppressionPatternTable)
          .set({ last_matched_at: Date.now() })
          .where(eq(SuppressionPatternTable.rule_source, ruleSource))
          .run()
      })
    }

    function pruneDecayedSuppressions(): void {
      const cutoff = Date.now() - SUPPRESSION_DECAY_MS
      Database.use((db) => {
        db.delete(SuppressionPatternTable)
          .where(lt(SuppressionPatternTable.last_matched_at, cutoff))
          .run()
      })
    }

    function pruneExpiredSnoozes(): void {
      const now = Date.now()
      Database.use((db) => {
        db.delete(DismissedEventTable)
          .where(
            and(
              eq(DismissedEventTable.action, "snooze"),
              lt(DismissedEventTable.snooze_until, now),
            ),
          )
          .run()
      })
    }

    function loadRecentEvents(): ActivityEvent[] {
      return Database.use((db) => {
        return db
          .select()
          .from(ActivityEventTable)
          .orderBy(desc(ActivityEventTable.timestamp))
          .limit(500)
          .all() as ActivityEvent[]
      })
    }

    // --- Queue computation ---

    function computeQueue(): NeedsMeItem[] {
      // Prune expired snoozes and decayed suppressions
      pruneExpiredSnoozes()
      pruneDecayedSuppressions()

      // Load raw events
      const events = loadRecentEvents()

      // Classify and score
      const { items } = classify(events, scoringConfig)

      // Apply dismiss/snooze/suppression filters
      const dismissed = getDismissedKeys()
      const snoozed = getSnoozedKeys()
      const suppressed = getSuppressedRuleSources()

      const filtered = items.filter((item) => {
        // Dismissed items only reappear on new events (we check by work_item_key)
        if (dismissed.has(item.workItemKey)) return false

        // Snoozed items hidden until snooze expires
        if (snoozed.has(item.workItemKey)) return false

        // Auto-suppressed rule+source patterns
        if (suppressed.has(item.ruleSource) && !item.isExemptFromSuppression) {
          // Touch the suppression to prevent decay
          touchSuppression(item.ruleSource)
          return false
        }

        return true
      })

      return filtered
    }

    // --- Overflow tracking ---

    function updateOverflowState(queueSize: number): boolean {
      const now = Date.now()
      if (queueSize > OVERFLOW_THRESHOLD) {
        if (overflowSince === null) {
          overflowSince = now
        }
        return now - overflowSince >= OVERFLOW_SUSTAIN_MS
      } else {
        overflowSince = null
        return false
      }
    }

    // --- Effect service ---

    const refresh = Effect.fn("NeedsMe.refresh")(function* () {
      try {
        cachedQueue = computeQueue()
        lastCheckedTs = Date.now()

        const overflowAlert = updateOverflowState(cachedQueue.length)

        yield* bus
          .publish(NeedsMeQueueUpdated, {
            itemCount: cachedQueue.length,
            overflowAlert,
          })
          .pipe(Effect.ignore)

        log.info("needs-me queue refreshed", { items: cachedQueue.length, overflow: overflowAlert })
      } catch (err) {
        log.error("failed to refresh needs-me queue", { error: err })
      }
      return cachedQueue
    })

    const getQueue = Effect.fn("NeedsMe.getQueue")(function* () {
      return cachedQueue
    })

    const dismiss = Effect.fn("NeedsMe.dismiss")(function* (workItemKey: string, ruleSource: string) {
      insertDismissal(workItemKey, ruleSource, "dismiss", null)

      // Check auto-suppression threshold
      const count = countDismissalsForRuleSource(ruleSource)
      if (count >= AUTO_SUPPRESS_THRESHOLD) {
        upsertSuppression(ruleSource, count)
        log.info("auto-suppression activated", { ruleSource, dismissCount: count })
      }

      // Remove from cached queue
      cachedQueue = cachedQueue.filter((i) => i.workItemKey !== workItemKey)
    })

    const snooze = Effect.fn("NeedsMe.snooze")(function* (
      workItemKey: string,
      ruleSource: string,
      duration: SnoozeDuration,
    ) {
      const snoozeUntil = Date.now() + SNOOZE_DURATIONS[duration]
      insertDismissal(workItemKey, ruleSource, "snooze", snoozeUntil)

      // Remove from cached queue
      cachedQueue = cachedQueue.filter((i) => i.workItemKey !== workItemKey)
    })

    const getOverflowAlert = Effect.fn("NeedsMe.getOverflowAlert")(function* () {
      const active = overflowSince !== null && Date.now() - overflowSince >= OVERFLOW_SUSTAIN_MS
      return { active, since: overflowSince }
    })

    const getLastChecked = Effect.fn("NeedsMe.getLastChecked")(function* () {
      return lastCheckedTs
    })

    const setConfig = Effect.fn("NeedsMe.setConfig")(function* (config: NeedsMeConfig) {
      scoringConfig = config
    })

    return Service.of({
      refresh,
      getQueue,
      dismiss,
      snooze,
      getOverflowAlert,
      getLastChecked,
      setConfig,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as NeedsMe from "."
