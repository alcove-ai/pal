import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const RadarResultTable = sqliteTable(
  "radar_result",
  {
    url: text().primaryKey(),
    session_id: text(),
    summary: text().notNull(),
    impact: text(),
    change_description: text(),
    urgency: integer().notNull().default(5),
    status: text().notNull(),
    analyzed_at: integer().notNull(),
  },
  (table) => [
    index("radar_result_status_idx").on(table.status),
    index("radar_result_analyzed_at_idx").on(table.analyzed_at),
  ],
)
