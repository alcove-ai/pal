import { Database } from "@/storage/db"
import { TriageDecisionTable } from "./decisions.sql"
import { Identifier } from "@/id/id"
import { eq, desc } from "drizzle-orm"

export function recordTriageDecision(
  item: {
    workItemKey: string
    ruleSource: string
    rule: string
    score: number
    tier: number
    feed?: string | null
    mode?: string | null
  },
  action: string,
  actionDetail?: string,
  sessionId?: string,
): void {
  try {
    Database.use((db) => {
      db.insert(TriageDecisionTable)
        .values({
          id: Identifier.create("td", "ascending"),
          work_item_key: item.workItemKey,
          rule_source: item.ruleSource,
          event_type: item.rule,
          item_score: item.score,
          item_tier: item.tier,
          feed: item.feed ?? null,
          mode: item.mode ?? null,
          action,
          action_detail: actionDetail ?? null,
          session_id: sessionId ?? null,
          decided_at: Date.now(),
        })
        .run()
    })
  } catch {}
}

export function getRecentDecisions(ruleSource: string, limit: number = 10): any[] {
  try {
    return Database.use((db) => {
      return db
        .select()
        .from(TriageDecisionTable)
        .where(eq(TriageDecisionTable.rule_source, ruleSource))
        .orderBy(desc(TriageDecisionTable.decided_at))
        .limit(limit)
        .all()
    })
  } catch {
    return []
  }
}
