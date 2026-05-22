import { eq } from "drizzle-orm"
import { readFileSync, appendFileSync, writeFileSync, existsSync } from "fs"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Database } from "@/storage/db"
import { RadarResultTable } from "./radar.sql"

const log = Log.create({ service: "radar-store" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RadarItem {
  url: string
  label: string | null
}

export interface RadarResult {
  url: string
  sessionId: string | null
  summary: string
  impact: string | null
  changeDescription: string | null
  urgency: number
  status: "running" | "done" | "error"
  analyzedAt: number
}

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

function radarFilePath(): string {
  return path.join(process.cwd(), ".opencode", "radar.txt")
}

function radarLocalFilePath(): string {
  return path.join(process.cwd(), ".opencode", "radar.local.txt")
}

// ---------------------------------------------------------------------------
// File parsing
// ---------------------------------------------------------------------------

function parseRadarFile(filePath: string): RadarItem[] {
  if (!existsSync(filePath)) return []

  try {
    const content = readFileSync(filePath, "utf-8")
    const items: RadarItem[] = []

    for (const raw of content.split("\n")) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue

      // First whitespace-delimited token is the URL; rest is the label
      const match = line.match(/^(\S+)(?:\s+(.+))?$/)
      if (!match) continue

      items.push({
        url: match[1],
        label: match[2]?.trim() ?? null,
      })
    }

    return items
  } catch (err) {
    log.error("failed to read radar file", { filePath, error: err })
    return []
  }
}

// ---------------------------------------------------------------------------
// Public API — file operations
// ---------------------------------------------------------------------------

export function loadRadarItems(): RadarItem[] {
  const mainItems = parseRadarFile(radarFilePath())
  const localItems = parseRadarFile(radarLocalFilePath())

  // Merge and deduplicate by URL (keep first occurrence)
  const seen = new Set<string>()
  const merged: RadarItem[] = []

  for (const item of [...mainItems, ...localItems]) {
    if (seen.has(item.url)) continue
    seen.add(item.url)
    merged.push(item)
  }

  return merged
}

export function addItem(url: string, label?: string): void {
  const filePath = radarLocalFilePath()
  const line = label ? `${url} ${label}` : url
  const suffix = "\n" + line + "\n"

  try {
    if (!existsSync(filePath)) {
      writeFileSync(filePath, line + "\n", "utf-8")
    } else {
      appendFileSync(filePath, suffix, "utf-8")
    }
  } catch (err) {
    log.error("failed to add radar item", { url, error: err })
  }
}

export function removeItem(url: string): void {
  const filePath = radarLocalFilePath()
  if (!existsSync(filePath)) return

  try {
    const content = readFileSync(filePath, "utf-8")
    const lines = content.split("\n")
    const filtered = lines.filter((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) return true
      const match = trimmed.match(/^(\S+)/)
      return match?.[1] !== url
    })
    writeFileSync(filePath, filtered.join("\n"), "utf-8")
  } catch (err) {
    log.error("failed to remove radar item", { url, error: err })
  }
}

// ---------------------------------------------------------------------------
// Helpers — DB row conversion
// ---------------------------------------------------------------------------

function rowToResult(row: typeof RadarResultTable.$inferSelect): RadarResult {
  return {
    url: row.url,
    sessionId: row.session_id ?? null,
    summary: row.summary,
    impact: row.impact ?? null,
    changeDescription: row.change_description ?? null,
    urgency: row.urgency,
    status: row.status as RadarResult["status"],
    analyzedAt: row.analyzed_at,
  }
}

// ---------------------------------------------------------------------------
// Public API — DB operations
// ---------------------------------------------------------------------------

export function getResult(url: string): RadarResult | null {
  try {
    return Database.use((db) => {
      const row = db
        .select()
        .from(RadarResultTable)
        .where(eq(RadarResultTable.url, url))
        .get()
      return row ? rowToResult(row) : null
    })
  } catch {
    return null
  }
}

export function getAllResults(): Map<string, RadarResult> {
  const results = new Map<string, RadarResult>()
  try {
    Database.use((db) => {
      const rows = db.select().from(RadarResultTable).all()
      for (const row of rows) {
        results.set(row.url, rowToResult(row))
      }
    })
  } catch {
    // DB may not be ready yet; return empty
  }
  return results
}

export function persistResult(result: RadarResult): void {
  try {
    Database.use((db) => {
      db.insert(RadarResultTable)
        .values({
          url: result.url,
          session_id: result.sessionId,
          summary: result.summary,
          impact: result.impact,
          change_description: result.changeDescription,
          urgency: result.urgency,
          status: result.status,
          analyzed_at: result.analyzedAt,
        })
        .onConflictDoUpdate({
          target: RadarResultTable.url,
          set: {
            session_id: result.sessionId,
            summary: result.summary,
            impact: result.impact,
            change_description: result.changeDescription,
            urgency: result.urgency,
            status: result.status,
            analyzed_at: result.analyzedAt,
          },
        })
        .run()
    })
  } catch (err) {
    log.error("failed to persist radar result", { url: result.url, error: err })
  }
}

export * as RadarStore from "./radar-store"
