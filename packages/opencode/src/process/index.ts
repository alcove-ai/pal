/**
 * PAL Business Process Facilitation Plugin
 *
 * Integrates with the activity feed to assess Jira issues on each poll cycle,
 * surfaces process gaps in Needs Me, and provides /pal-skip escape hatch.
 *
 * Read-only: never modifies Jira issues.
 */

import * as Log from "@opencode-ai/core/util/log"
import * as PalConfig from "@/config/pal-config"
import { Database } from "@/storage/db"
import { IssueProcessStateTable, SkipTrackingTable } from "./process.sql"
import { ActivityEventTable } from "@/activity-feed/activity-feed.sql"
import { assess, type IssueInput, type Phase, type AssessmentResult } from "./assessor"
import { detectProposals, storeProposals, getActiveProposals, type IssueMetadata, type EpicProposal } from "./epic-proposer"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Effect, Layer, Context, Schema } from "effect"
import { Identifier } from "@/id/id"
import { eq, sql, and, gt, desc } from "drizzle-orm"

const log = Log.create({ service: "process" })

/** Default weight for process-gap items in Needs Me */
const PROCESS_GAP_WEIGHT = 20

/** Rolling window for skip rate calculation: 30 days */
const SKIP_RATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** Skip rate threshold (30%) to trigger advisory */
const SKIP_RATE_THRESHOLD = 0.3

// --- Bus events ---

export const ProcessAssessmentCompleted = BusEvent.define(
  "process.assessment.completed",
  Schema.Struct({
    assessed: Schema.Number,
    needsProblem: Schema.Number,
    ready: Schema.Number,
  }),
)

export const ProcessEpicProposed = BusEvent.define(
  "process.epic.proposed",
  Schema.Struct({
    clusterKey: Schema.String,
    issueCount: Schema.Number,
  }),
)

export const ProcessSkipAdvisory = BusEvent.define(
  "process.skip.advisory",
  Schema.Struct({
    skipRate: Schema.Number,
    totalIssues: Schema.Number,
    skippedIssues: Schema.Number,
  }),
)

// --- Types ---

export interface ProcessGapItem {
  issueKey: string
  phase: Phase
  weight: number
  title: string
  url: string
}

export interface ComplianceSummary {
  byPhase: Record<Phase, number>
  totalAssessed: number
  skipRate: number
  skippedInWindow: number
  totalInWindow: number
  activeProposals: EpicProposal[]
}

// --- Service interface ---

export interface Interface {
  /** Run assessment against all recent Jira events. Called on each poll cycle. */
  readonly assessFromActivityFeed: () => Effect.Effect<void>
  /** Get issues in needs_problem phase that are transitioning to In Progress */
  readonly getProcessGaps: () => Effect.Effect<ProcessGapItem[]>
  /** Record a /pal-skip for an issue */
  readonly skip: (issueKey: string) => Effect.Effect<{ advisory: boolean; skipRate: number }>
  /** Get the compliance summary for the settings tab */
  readonly getComplianceSummary: () => Effect.Effect<ComplianceSummary>
  /** Get the process state for a specific issue */
  readonly getIssueState: (issueKey: string) => Effect.Effect<{ phase: Phase; problemQuality: string; scopeQuality: string; exemptionReason: string | null; skipCount: number } | null>
}

function buildJiraFallbackUrl(issueKey: string): string {
  const config = PalConfig.get()
  const baseUrl = config.activityFeed?.jira?.url
  if (baseUrl) {
    const normalized = baseUrl.replace(/\/+$/, "")
    return `${normalized}/browse/${issueKey}`
  }
  return issueKey
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Process") {}

export const layer: Layer.Layer<Service, never, Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    // --- Database helpers ---

    function upsertIssueState(
      issueKey: string,
      result: AssessmentResult,
    ): void {
      Database.use((db) => {
        db.insert(IssueProcessStateTable)
          .values({
            issue_key: issueKey,
            phase: result.phase,
            problem_quality: result.problemQuality,
            scope_quality: result.scopeQuality,
            exemption_reason: result.exemptionReason,
            last_assessed: Date.now(),
            skip_count: 0,
          })
          .onConflictDoUpdate({
            target: IssueProcessStateTable.issue_key,
            set: {
              phase: result.phase,
              problem_quality: result.problemQuality,
              scope_quality: result.scopeQuality,
              exemption_reason: result.exemptionReason,
              last_assessed: Date.now(),
            },
          })
          .run()
      })
    }

    function getDistinctJiraIssuesFromEvents(): Array<{
      key: string
      title: string
      url: string | null
      metadata: Record<string, unknown> | null
    }> {
      return Database.use((db) => {
        // Get the most recent event per Jira issue key
        const rows = db
          .select({
            source_id: ActivityEventTable.source_id,
            title: ActivityEventTable.title,
            url: ActivityEventTable.url,
            metadata: ActivityEventTable.metadata,
          })
          .from(ActivityEventTable)
          .where(eq(ActivityEventTable.source, "jira"))
          .orderBy(desc(ActivityEventTable.timestamp))
          .all()

        // Deduplicate by source_id (issue key)
        const seen = new Map<string, typeof rows[0]>()
        for (const row of rows) {
          if (!seen.has(row.source_id)) {
            seen.set(row.source_id, row)
          }
        }

        return Array.from(seen.values()).map((r) => ({
          key: r.source_id,
          title: r.title,
          url: r.url,
          metadata: r.metadata as Record<string, unknown> | null,
        }))
      })
    }

    function getIssuesByPhase(): Record<Phase, number> {
      const result: Record<Phase, number> = {
        needs_problem: 0,
        has_problem: 0,
        needs_scope: 0,
        ready: 0,
      }

      Database.use((db) => {
        const rows = db
          .select({
            phase: IssueProcessStateTable.phase,
            count: sql<number>`count(*)`,
          })
          .from(IssueProcessStateTable)
          .groupBy(IssueProcessStateTable.phase)
          .all()

        for (const row of rows) {
          const phase = row.phase as Phase
          if (phase in result) {
            result[phase] = row.count
          }
        }
      })

      return result
    }

    function getInProgressNeedsProblem(): Array<{
      issue_key: string
      phase: string
    }> {
      // Find issues that are in needs_problem phase
      // The "In Progress" detection comes from activity events with status_changed metadata
      return Database.use((db) => {
        // Get issues in needs_problem phase
        const processStates = db
          .select({
            issue_key: IssueProcessStateTable.issue_key,
            phase: IssueProcessStateTable.phase,
          })
          .from(IssueProcessStateTable)
          .where(eq(IssueProcessStateTable.phase, "needs_problem"))
          .all()

        // Cross-reference with activity events to see if any transitioned to In Progress
        const inProgressKeys = new Set<string>()
        const statusEvents = db
          .select({
            source_id: ActivityEventTable.source_id,
            metadata: ActivityEventTable.metadata,
          })
          .from(ActivityEventTable)
          .where(
            and(
              eq(ActivityEventTable.source, "jira"),
              eq(ActivityEventTable.event_type, "status_changed"),
            ),
          )
          .orderBy(desc(ActivityEventTable.timestamp))
          .all()

        for (const evt of statusEvents) {
          const meta = evt.metadata as Record<string, unknown> | null
          if (meta?.change_to === "In Progress") {
            inProgressKeys.add(evt.source_id)
          }
        }

        return processStates.filter((s) => inProgressKeys.has(s.issue_key))
      })
    }

    function recordSkip(issueKey: string): void {
      Database.use((db) => {
        // Insert skip tracking record
        db.insert(SkipTrackingTable)
          .values({
            id: Identifier.create("psk", "ascending"),
            issue_key: issueKey,
            skipped_at: Date.now(),
            advisory_shown: 0,
          })
          .run()

        // Increment skip count on the issue state
        const existing = db
          .select({ skip_count: IssueProcessStateTable.skip_count })
          .from(IssueProcessStateTable)
          .where(eq(IssueProcessStateTable.issue_key, issueKey))
          .get()

        if (existing) {
          db.update(IssueProcessStateTable)
            .set({ skip_count: existing.skip_count + 1 })
            .where(eq(IssueProcessStateTable.issue_key, issueKey))
            .run()
        }
      })
    }

    function computeSkipRate(): { skipRate: number; skipped: number; total: number } {
      const cutoff = Date.now() - SKIP_RATE_WINDOW_MS
      return Database.use((db) => {
        // Count unique issues assessed in the window
        const totalResult = db
          .select({ count: sql<number>`count(*)` })
          .from(IssueProcessStateTable)
          .where(gt(IssueProcessStateTable.last_assessed, cutoff))
          .get()
        const total = totalResult?.count ?? 0

        // Count unique issues skipped in the window
        const skippedResult = db
          .select({ count: sql<number>`count(distinct ${SkipTrackingTable.issue_key})` })
          .from(SkipTrackingTable)
          .where(gt(SkipTrackingTable.skipped_at, cutoff))
          .get()
        const skipped = skippedResult?.count ?? 0

        const skipRate = total > 0 ? skipped / total : 0
        return { skipRate, skipped, total }
      })
    }

    function hasAdvisoryBeenShown(): boolean {
      const cutoff = Date.now() - SKIP_RATE_WINDOW_MS
      return Database.use((db) => {
        const result = db
          .select({ count: sql<number>`count(*)` })
          .from(SkipTrackingTable)
          .where(
            and(
              gt(SkipTrackingTable.skipped_at, cutoff),
              eq(SkipTrackingTable.advisory_shown, 1),
            ),
          )
          .get()
        return (result?.count ?? 0) > 0
      })
    }

    function markAdvisoryShown(): void {
      const cutoff = Date.now() - SKIP_RATE_WINDOW_MS
      Database.use((db) => {
        db.update(SkipTrackingTable)
          .set({ advisory_shown: 1 })
          .where(gt(SkipTrackingTable.skipped_at, cutoff))
          .run()
      })
    }

    // --- Effect service methods ---

    const assessFromActivityFeed = Effect.fn("Process.assessFromActivityFeed")(function* () {
      try {
        const issues = getDistinctJiraIssuesFromEvents()
        let assessed = 0
        let needsProblem = 0
        let ready = 0

        // Also collect metadata for epic proposals
        const issueMetadataList: IssueMetadata[] = []

        for (const issue of issues) {
          const meta = issue.metadata ?? {}

          const input: IssueInput = {
            key: issue.key,
            summary: issue.title.replace(`${issue.key}: `, ""),
            issueType: (meta.issue_type as string) ?? "Task",
            description: (meta.description as string) ?? null,
            labels: (meta.labels as string[]) ?? [],
          }

          const result = assess(input)
          upsertIssueState(issue.key, result)
          assessed++

          if (result.phase === "needs_problem") needsProblem++
          if (result.phase === "ready") ready++

          // Collect for epic proposal detection
          issueMetadataList.push({
            key: issue.key,
            issueType: input.issueType,
            components: (meta.components as string[]) ?? [],
            labels: input.labels,
            parentKey: (meta.parent_key as string) ?? null,
            createdAt: (meta.created_ts as number) ?? Date.now(),
          })
        }

        // Detect and store epic proposals
        const proposals = detectProposals(issueMetadataList)
        if (proposals.length > 0) {
          storeProposals(proposals)
          for (const p of proposals) {
            yield* bus
              .publish(ProcessEpicProposed, {
                clusterKey: p.clusterKey,
                issueCount: p.issueKeys.length,
              })
              .pipe(Effect.ignore)
          }
        }

        yield* bus
          .publish(ProcessAssessmentCompleted, {
            assessed,
            needsProblem,
            ready,
          })
          .pipe(Effect.ignore)

        log.info("process assessment complete", { assessed, needsProblem, ready, proposals: proposals.length })
      } catch (err) {
        log.error("process assessment failed", { error: err })
      }
    })

    const getProcessGaps = Effect.fn("Process.getProcessGaps")(function* () {
      const gaps = getInProgressNeedsProblem()
      const items: ProcessGapItem[] = []

      for (const gap of gaps) {
        // Look up the title from the most recent event
        const eventInfo = Database.use((db) => {
          return db
            .select({
              title: ActivityEventTable.title,
              url: ActivityEventTable.url,
            })
            .from(ActivityEventTable)
            .where(
              and(
                eq(ActivityEventTable.source, "jira"),
                eq(ActivityEventTable.source_id, gap.issue_key),
              ),
            )
            .orderBy(desc(ActivityEventTable.timestamp))
            .limit(1)
            .get()
        })

        items.push({
          issueKey: gap.issue_key,
          phase: gap.phase as Phase,
          weight: PROCESS_GAP_WEIGHT,
          title: eventInfo?.title ?? gap.issue_key,
          url: eventInfo?.url ?? buildJiraFallbackUrl(gap.issue_key),
        })
      }

      return items
    })

    const skip = Effect.fn("Process.skip")(function* (issueKey: string) {
      recordSkip(issueKey)

      const { skipRate, skipped, total } = computeSkipRate()
      let advisory = false

      if (skipRate > SKIP_RATE_THRESHOLD && !hasAdvisoryBeenShown()) {
        advisory = true
        markAdvisoryShown()

        yield* bus
          .publish(ProcessSkipAdvisory, {
            skipRate,
            totalIssues: total,
            skippedIssues: skipped,
          })
          .pipe(Effect.ignore)

        log.info("skip advisory triggered", { skipRate, total, skipped })
      }

      return { advisory, skipRate }
    })

    const getComplianceSummary = Effect.fn("Process.getComplianceSummary")(function* () {
      const byPhase = getIssuesByPhase()
      const totalAssessed = Object.values(byPhase).reduce((a, b) => a + b, 0)
      const { skipRate, skipped, total } = computeSkipRate()
      const activeProposals = getActiveProposals()

      return {
        byPhase,
        totalAssessed,
        skipRate,
        skippedInWindow: skipped,
        totalInWindow: total,
        activeProposals,
      }
    })

    const getIssueState = Effect.fn("Process.getIssueState")(function* (issueKey: string) {
      return Database.use((db) => {
        const row = db
          .select()
          .from(IssueProcessStateTable)
          .where(eq(IssueProcessStateTable.issue_key, issueKey))
          .get()

        if (!row) return null

        return {
          phase: row.phase as Phase,
          problemQuality: row.problem_quality,
          scopeQuality: row.scope_quality,
          exemptionReason: row.exemption_reason,
          skipCount: row.skip_count,
        }
      })
    })

    return Service.of({
      assessFromActivityFeed,
      getProcessGaps,
      skip,
      getComplianceSummary,
      getIssueState,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Process from "."
