import * as Log from "@opencode-ai/core/util/log"
import type { PollingAdapter, ActivityEvent, ActivityEventType } from "./types"
import { Identifier } from "@/id/id"

/** Minimal tool interface matching what MCP.tools() returns */
interface McpTool {
  execute?: (input: any, options?: any) => any
}

const log = Log.create({ service: "activity-feed.jira" })

const GITHUB_PR_REGEX = /github\.com\/[\w-]+\/[\w-]+\/pull\/\d+/g
const GITLAB_MR_REGEX = /gitlab\.[a-z.]+\/[\w-]+\/[\w-]+\/-\/merge_requests\/\d+/g

const TRACKED_CHANGELOG_FIELDS: Record<string, ActivityEventType> = {
  status: "status_changed",
  assignee: "assigned",
  priority: "priority_changed",
}

interface ChangelogItem {
  field: string
  fieldtype?: string
  from?: string | null
  fromString?: string | null
  to?: string | null
  toString?: string | null
}

interface ChangelogEntry {
  id?: string
  created?: string
  author?: {
    displayName?: string
    emailAddress?: string
  }
  items?: ChangelogItem[]
}

interface JiraComment {
  id?: string
  created?: string
  updated?: string
  author?: {
    displayName?: string
    emailAddress?: string
  }
  body?: string
}

interface JiraIssue {
  key: string
  fields: {
    summary?: string
    created?: string
    updated?: string
    creator?: { displayName?: string }
    assignee?: { displayName?: string }
    status?: { name?: string }
    priority?: { name?: string }
    labels?: string[]
    description?: string
    comment?: {
      comments?: JiraComment[]
    }
  }
  changelog?: {
    histories?: ChangelogEntry[]
  }
}

function extractPrUrls(text: string | null | undefined): string[] {
  if (!text) return []
  const githubMatches = text.match(GITHUB_PR_REGEX) ?? []
  const gitlabMatches = text.match(GITLAB_MR_REGEX) ?? []
  return [...new Set([...githubMatches.map((m) => `https://${m}`), ...gitlabMatches.map((m) => `https://${m}`)])]
}

function issueUrl(key: string): string {
  return `https://redhat.atlassian.net/browse/${key}`
}

function parseTimestamp(dateStr: string | null | undefined): number {
  if (!dateStr) return Date.now()
  const ms = Date.parse(dateStr)
  return isNaN(ms) ? Date.now() : ms
}

export function createJiraAdapter(mcpTools: () => Promise<Record<string, McpTool> | undefined>): PollingAdapter {
  return {
    source: "jira",

    async isAvailable(): Promise<boolean> {
      try {
        const tools = await mcpTools()
        if (!tools) return false
        // Look for the jira_search tool from the Atlassian MCP server
        const hasJiraSearch = Object.keys(tools).some((name) => name.includes("jira_search"))
        return hasJiraSearch
      } catch {
        return false
      }
    },

    async poll(): Promise<ActivityEvent[]> {
      const tools = await mcpTools()
      if (!tools) {
        log.warn("MCP tools not available, skipping Jira poll")
        return []
      }

      const searchToolName = Object.keys(tools).find((name) => name.includes("jira_search"))
      if (!searchToolName) {
        log.warn("jira_search tool not found, skipping Jira poll")
        return []
      }

      const searchTool = tools[searchToolName]
      if (!searchTool?.execute) {
        log.warn("jira_search tool resolved to undefined or has no execute")
        return []
      }

      try {
        const result = await searchTool.execute(
          {
            jql: 'project = PULP AND updated >= "-3m" ORDER BY updated DESC',
            fields: "summary,status,assignee,priority,labels,created,updated,creator,description,comment",
            expand: "changelog",
            limit: 50,
          },
          { abortSignal: AbortSignal.timeout(25_000) },
        )

        if (!result) {
          log.warn("jira_search returned no result")
          return []
        }

        const content = extractContent(result)
        if (!content) {
          log.warn("could not extract content from jira_search result")
          return []
        }

        let parsed: { issues?: JiraIssue[]; total?: number }
        try {
          parsed = typeof content === "string" ? JSON.parse(content) : content
        } catch {
          log.warn("failed to parse jira_search response", { content: String(content).slice(0, 200) })
          return []
        }

        const issues = parsed.issues ?? []
        if (issues.length > 100) {
          log.warn("anomaly guard: capping issues at 100", { total: issues.length })
          issues.length = 100
        }

        const events: ActivityEvent[] = []

        for (const issue of issues) {
          const prUrls = extractPrUrls(issue.fields.description)
          // Also extract from comments
          for (const comment of issue.fields.comment?.comments ?? []) {
            prUrls.push(...extractPrUrls(comment.body))
          }
          const uniquePrUrls = [...new Set(prUrls)]

          const baseMetadata: Record<string, unknown> = {
            status: issue.fields.status?.name,
            priority: issue.fields.priority?.name,
            labels: issue.fields.labels,
            jira_key: issue.key,
          }
          if (uniquePrUrls.length > 0) {
            baseMetadata.github_pr_urls = uniquePrUrls
          }

          // Check if issue was created recently
          const createdTs = parseTimestamp(issue.fields.created)
          events.push({
            id: Identifier.create("evt", "ascending"),
            source: "jira",
            source_id: issue.key,
            event_type: "issue_created",
            title: `${issue.key}: ${issue.fields.summary ?? "Untitled"}`,
            summary: `Issue created`,
            actor: issue.fields.creator?.displayName ?? null,
            timestamp: createdTs,
            url: issueUrl(issue.key),
            metadata: baseMetadata,
            is_read: 0,
              relevance: null,
              relevance_reasoning: null,
            created_at: Date.now(),
          })

          // Process changelog entries
          for (const history of issue.changelog?.histories ?? []) {
            const historyTs = parseTimestamp(history.created)
            const historyActor = history.author?.displayName ?? null

            for (const item of history.items ?? []) {
              const field = item.field?.toLowerCase()
              if (!field) continue

              // Check for blocked label
              if (field === "labels" && item.toString?.includes("Blocked")) {
                events.push({
                  id: Identifier.create("evt", "ascending"),
                  source: "jira",
                  source_id: issue.key,
                  event_type: "blocked",
                  title: `${issue.key}: ${issue.fields.summary ?? "Untitled"}`,
                  summary: `Issue blocked`,
                  actor: historyActor,
                  timestamp: historyTs,
                  url: issueUrl(issue.key),
                  metadata: { ...baseMetadata, blocked: true },
                  is_read: 0,
              relevance: null,
              relevance_reasoning: null,
                  created_at: Date.now(),
                })
                continue
              }

              const eventType = TRACKED_CHANGELOG_FIELDS[field]
              if (eventType) {
                const summary = buildChangelogSummary(field, item)
                events.push({
                  id: Identifier.create("evt", "ascending"),
                  source: "jira",
                  source_id: issue.key,
                  event_type: eventType,
                  title: `${issue.key}: ${issue.fields.summary ?? "Untitled"}`,
                  summary,
                  actor: historyActor,
                  timestamp: historyTs,
                  url: issueUrl(issue.key),
                  metadata: {
                    ...baseMetadata,
                    change_from: item.fromString,
                    change_to: item.toString,
                  },
                  is_read: 0,
              relevance: null,
              relevance_reasoning: null,
                  created_at: Date.now(),
                })
              } else if (field !== "description" && field !== "labels") {
                // field_updated catch-all, skip cosmetic fields
                events.push({
                  id: Identifier.create("evt", "ascending"),
                  source: "jira",
                  source_id: issue.key,
                  event_type: "field_updated",
                  title: `${issue.key}: ${issue.fields.summary ?? "Untitled"}`,
                  summary: `Field "${item.field}" updated`,
                  actor: historyActor,
                  timestamp: historyTs,
                  url: issueUrl(issue.key),
                  metadata: {
                    ...baseMetadata,
                    field: item.field,
                    change_from: item.fromString,
                    change_to: item.toString,
                  },
                  is_read: 0,
              relevance: null,
              relevance_reasoning: null,
                  created_at: Date.now(),
                })
              }
            }
          }

          // Process comments
          for (const comment of issue.fields.comment?.comments ?? []) {
            const commentTs = parseTimestamp(comment.created ?? comment.updated)
            events.push({
              id: Identifier.create("evt", "ascending"),
              source: "jira",
              source_id: issue.key,
              event_type: "commented",
              title: `${issue.key}: ${issue.fields.summary ?? "Untitled"}`,
              summary: comment.body ? comment.body.slice(0, 200) : "New comment",
              actor: comment.author?.displayName ?? null,
              timestamp: commentTs,
              url: issueUrl(issue.key),
              metadata: { ...baseMetadata, comment_id: comment.id },
              is_read: 0,
              relevance: null,
              relevance_reasoning: null,
              created_at: Date.now(),
            })
          }
        }

        return events
      } catch (err) {
        log.error("failed to poll Jira", { error: err })
        return []
      }
    },
  }
}

function buildChangelogSummary(field: string, item: ChangelogItem): string {
  switch (field) {
    case "status":
      return `Status: ${item.fromString ?? "?"} -> ${item.toString ?? "?"}`
    case "assignee":
      return item.toString ? `Assigned to ${item.toString}` : "Unassigned"
    case "priority":
      return `Priority: ${item.fromString ?? "?"} -> ${item.toString ?? "?"}`
    default:
      return `${field} changed`
  }
}

function extractContent(result: unknown): unknown {
  if (!result || typeof result !== "object") return result
  const r = result as Record<string, unknown>
  if ("content" in r && Array.isArray(r.content)) {
    for (const item of r.content) {
      if (item && typeof item === "object" && "text" in item) {
        return item.text
      }
    }
  }
  return result
}
