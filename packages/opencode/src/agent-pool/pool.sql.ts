import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const AgentResultTable = sqliteTable(
  "agent_result",
  {
    source_id: text().primaryKey(),
    session_id: text(),
    summary: text().notNull(),
    recommended_action: text(),
    status: text().notNull(),
    analyzed_event_ts: integer().notNull(),
    analyzed_at: integer().notNull(),
    urgency: integer().notNull().default(5),
  },
  (table) => [
    index("agent_result_status_idx").on(table.status),
    index("agent_result_analyzed_at_idx").on(table.analyzed_at),
  ],
)
