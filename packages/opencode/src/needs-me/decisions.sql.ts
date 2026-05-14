import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const TriageDecisionTable = sqliteTable(
  "needs_me_triage_decision",
  {
    id: text().primaryKey(),
    work_item_key: text().notNull(),
    rule_source: text().notNull(),
    event_type: text().notNull(),
    item_score: integer().notNull(),
    item_tier: integer().notNull(),
    feed: text(),
    mode: text(),
    action: text().notNull(),
    action_detail: text(),
    session_id: text(),
    decided_at: integer().notNull(),
  },
  (table) => [
    index("triage_decision_rule_source_idx").on(table.rule_source),
    index("triage_decision_action_idx").on(table.action),
    index("triage_decision_decided_at_idx").on(table.decided_at),
  ],
)
