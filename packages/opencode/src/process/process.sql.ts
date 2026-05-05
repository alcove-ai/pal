import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

/**
 * Tracks the business-process assessment state for each Jira issue.
 * Written by the assessor on every poll cycle; never modifies Jira.
 */
export const IssueProcessStateTable = sqliteTable(
  "issue_process_state",
  {
    /** Jira issue key, e.g. "PULP-1712" */
    issue_key: text().primaryKey(),
    /** Current lifecycle phase */
    phase: text().notNull(),
    /** Quality of the problem statement: missing | present | weak */
    problem_quality: text().notNull().default("missing"),
    /** Quality of the scope section (epics only): missing | present */
    scope_quality: text().notNull().default("missing"),
    /** If auto-exempted, the reason string; null otherwise */
    exemption_reason: text(),
    /** Epoch ms of the last assessment */
    last_assessed: integer().notNull(),
    /** Number of times the user invoked /pal-skip for this issue */
    skip_count: integer().notNull().default(0),
  },
  (table) => [
    index("issue_process_state_phase_idx").on(table.phase),
  ],
)

/**
 * Proposed epic groupings detected by the epic-proposer.
 * Stored locally; never written to Jira.
 */
export const ProposedEpicTable = sqliteTable(
  "proposed_epic",
  {
    id: text().primaryKey(),
    /** The shared dimension (component name or label) */
    cluster_key: text().notNull(),
    /** Comma-separated issue keys in the cluster */
    issue_keys: text().notNull(),
    /** Epoch ms when the proposal was created */
    proposed_at: integer().notNull(),
    /** Whether the user has dismissed this proposal */
    dismissed: integer().notNull().default(0),
  },
  (table) => [
    index("proposed_epic_cluster_key_idx").on(table.cluster_key),
    index("proposed_epic_proposed_at_idx").on(table.proposed_at),
  ],
)

/**
 * Per-user /pal-skip tracking for advisory threshold detection.
 */
export const SkipTrackingTable = sqliteTable(
  "process_skip_tracking",
  {
    id: text().primaryKey(),
    /** The issue key that was skipped */
    issue_key: text().notNull(),
    /** Epoch ms when the skip was recorded */
    skipped_at: integer().notNull(),
    /** Whether the advisory was already shown for the rolling window containing this skip */
    advisory_shown: integer().notNull().default(0),
  },
  (table) => [
    index("skip_tracking_issue_key_idx").on(table.issue_key),
    index("skip_tracking_skipped_at_idx").on(table.skipped_at),
  ],
)
