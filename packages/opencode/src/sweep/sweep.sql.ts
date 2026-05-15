import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const SweepResultTable = sqliteTable(
  "sweep_result",
  {
    source_id: text().primaryKey(),
    source: text().notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    action: text().notNull(),
    priority: text().notNull(),
    phase: text(),
    url: text(),
    actor: text(),
    last_event_ts: integer().notNull(),
    swept_at: integer().notNull(),
    feed: text(),
    mode: text(),
  },
  (table) => [
    index("sweep_result_priority_idx").on(table.priority, table.last_event_ts),
  ],
)
