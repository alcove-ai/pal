import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"

/**
 * Tracks dismissed/snoozed queue items.
 * - action = "dismiss" | "snooze"
 * - snooze_until: epoch ms when a snoozed item should re-surface (null for dismiss)
 * - rule_source: the classifier rule + source combination, e.g. "review_requested:github"
 *   Used for auto-suppression counting.
 */
export const DismissedEventTable = sqliteTable(
  "needs_me_dismissed_event",
  {
    id: text().primaryKey(),
    /** The work-item dedup key (e.g. jira key, PR URL) */
    work_item_key: text().notNull(),
    /** "dismiss" or "snooze" */
    action: text().notNull(),
    /** For snooze: epoch ms to re-queue; null for dismiss */
    snooze_until: integer(),
    /** Classifier rule + source, e.g. "review_requested:github" */
    rule_source: text().notNull(),
    /** Epoch ms when the action was taken */
    dismissed_at: integer().notNull(),
  },
  (table) => [
    index("dismissed_event_work_item_idx").on(table.work_item_key),
    index("dismissed_event_rule_source_idx").on(table.rule_source),
    index("dismissed_event_snooze_until_idx").on(table.snooze_until),
  ],
)

/**
 * Auto-suppression patterns.
 * Created when the same rule_source combination is dismissed 3+ times.
 * Decays after 30 days with no matching events.
 */
export const SuppressionPatternTable = sqliteTable(
  "needs_me_suppression_pattern",
  {
    id: text().primaryKey(),
    /** The rule_source pattern being suppressed */
    rule_source: text().notNull(),
    /** Number of dismissals that led to this suppression */
    dismiss_count: integer().notNull().default(0),
    /** Epoch ms when this suppression was created */
    created_at: integer().notNull(),
    /** Epoch ms of the last event that matched this pattern */
    last_matched_at: integer().notNull(),
  },
  (table) => [uniqueIndex("suppression_pattern_rule_source_idx").on(table.rule_source)],
)
