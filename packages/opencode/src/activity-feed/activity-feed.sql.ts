import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"

export const ActivityEventTable = sqliteTable(
  "activity_event",
  {
    id: text().primaryKey(),
    source: text().notNull(),
    source_id: text().notNull(),
    event_type: text().notNull(),
    title: text().notNull(),
    summary: text(),
    actor: text(),
    timestamp: integer().notNull(),
    url: text(),
    metadata: text({ mode: "json" }),
    is_read: integer().notNull().default(0),
    relevance: text(),
    relevance_reasoning: text(),
    created_at: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("activity_event_dedup_idx").on(table.source, table.source_id, table.event_type, table.timestamp),
    index("activity_event_timestamp_idx").on(table.timestamp),
    index("activity_event_is_read_timestamp_idx").on(table.is_read, table.timestamp),
    index("activity_event_relevance_idx").on(table.relevance, table.timestamp),
  ],
)

export const PollStateTable = sqliteTable("poll_state", {
  id: text().primaryKey(),
  source: text().notNull(),
  last_poll_ts: integer().notNull(),
  last_success_ts: integer(),
  consecutive_failures: integer().notNull().default(0),
})
