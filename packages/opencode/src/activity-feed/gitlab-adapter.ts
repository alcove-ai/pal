import * as Log from "@opencode-ai/core/util/log"
import type { PollingAdapter, ActivityEvent, ActivityEventType } from "./types"
import { Identifier } from "@/id/id"
import { detectActorType, type AgentDetectorConfig } from "./agent-detector"
import { PalConfig, type GitLabRepoEntry } from "@/config/pal-config"

const log = Log.create({ service: "activity-feed.gitlab" })

/** Minimal tool interface matching what MCP.tools() returns */
interface McpTool {
  execute?: (input: any, options?: any) => any
}

// --- Default repos to poll (empty by default; configure via pal.json) ---

const DEFAULT_REPOS: GitLabRepoEntry[] = []

// --- Interfaces for GitLab MCP responses ---

interface GitLabMR {
  iid: number
  title: string
  state: string
  web_url: string
  created_at: string
  updated_at: string
  merged_at?: string | null
  author: {
    username: string
    name?: string
  }
  reviewers?: Array<{
    username: string
    name?: string
  }>
  source_branch: string
  target_branch: string
  draft: boolean
  labels?: string[]
}

interface GitLabPipelineJob {
  id: number
  name: string
  status: string
  web_url: string
  finished_at: string | null
}

interface GitLabPipeline {
  id: number
  status: string
  web_url: string
  created_at: string
  updated_at: string
  jobs?: GitLabPipelineJob[]
}

interface GitLabDiscussion {
  id: string
  notes: Array<{
    id: number
    body: string
    author: {
      username: string
      name?: string
    }
    created_at: string
    updated_at: string
    system: boolean
    noteable_type: string
  }>
}

// --- Helpers ---

function parseTimestamp(dateStr: string | null | undefined): number {
  if (!dateStr) return Date.now()
  const ms = Date.parse(dateStr)
  return isNaN(ms) ? Date.now() : ms
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

function parseToolResult<T>(result: unknown): T | null {
  const content = extractContent(result)
  if (!content) return null
  try {
    return typeof content === "string" ? (JSON.parse(content) as T) : (content as T)
  } catch {
    log.debug("failed to parse MCP tool response", { content: String(content).slice(0, 200) })
    return null
  }
}

// --- Adapter ---

export interface GitLabAdapterConfig {
  repos?: GitLabRepoEntry[]
  agentDetector?: AgentDetectorConfig
}

export function createGitLabAdapter(
  mcpTools: () => Promise<Record<string, McpTool> | undefined>,
  config?: GitLabAdapterConfig,
): PollingAdapter {
  const palConfig = PalConfig.get().activityFeed?.gitlab
  const repos = config?.repos ?? palConfig?.repos ?? DEFAULT_REPOS
  const agentConfig = config?.agentDetector

  return {
    source: "gitlab",

    async isAvailable(): Promise<boolean> {
      try {
        const tools = await mcpTools()
        if (!tools) return false
        // Check for GitLab MCP tools
        const hasGitLabTool = Object.keys(tools).some(
          (name) => name.includes("list_merge_requests") || name.includes("gitlab"),
        )
        return hasGitLabTool
      } catch {
        return false
      }
    },

    async poll(): Promise<ActivityEvent[]> {
      const tools = await mcpTools()
      if (!tools) {
        log.warn("MCP tools not available, skipping GitLab poll")
        return []
      }

      // Find the required tools
      const listMRsToolName = Object.keys(tools).find((name) => name.includes("list_merge_requests"))
      const getPipelineToolName = Object.keys(tools).find((name) => name.includes("get_merge_request_pipeline"))
      const getReviewsToolName = Object.keys(tools).find((name) => name.includes("get_merge_request_reviews"))

      if (!listMRsToolName) {
        log.warn("list_merge_requests tool not found, skipping GitLab poll")
        return []
      }

      const listMRsTool = tools[listMRsToolName]
      if (!listMRsTool?.execute) {
        log.warn("list_merge_requests tool has no execute method")
        return []
      }

      const getPipelineTool = getPipelineToolName ? tools[getPipelineToolName] : null
      const getReviewsTool = getReviewsToolName ? tools[getReviewsToolName] : null

      const events: ActivityEvent[] = []

      for (const repo of repos) {
        try {
          const repoEvents = await pollRepo(
            repo,
            listMRsTool,
            getPipelineTool,
            getReviewsTool,
            agentConfig,
          )
          events.push(...repoEvents)
        } catch (err) {
          log.error("failed to poll GitLab repo", {
            projectPath: repo.projectPath,
            error: err,
          })
        }
      }

      return events
    },
  }
}

async function pollRepo(
  repo: GitLabRepoEntry,
  listMRsTool: McpTool,
  getPipelineTool: McpTool | null,
  getReviewsTool: McpTool | null,
  agentConfig?: AgentDetectorConfig,
): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = []

  // Fetch open MRs
  const mrResult = await listMRsTool.execute!(
    {
      project_id: repo.projectId,
      state: "all",
      limit: 30,
    },
    { abortSignal: AbortSignal.timeout(15_000) },
  )

  const mrs = parseToolResult<GitLabMR[] | { merge_requests?: GitLabMR[] }>(mrResult)
  if (!mrs) return events

  const mrList: GitLabMR[] = Array.isArray(mrs)
    ? mrs
    : (mrs as { merge_requests?: GitLabMR[] }).merge_requests ?? []

  if (mrList.length > 100) {
    log.warn("anomaly guard: capping MRs at 100", { total: mrList.length })
    mrList.length = 100
  }

  for (const mr of mrList) {
    const sourceId = `${repo.projectPath}!${mr.iid}`

    const baseMetadata: Record<string, unknown> = {
      project_id: repo.projectId,
      project_path: repo.projectPath,
      mr_iid: mr.iid,
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
      draft: mr.draft,
      labels: mr.labels,
    }

    // Determine MR state event
    if (mr.state === "merged") {
      events.push({
        id: Identifier.create("evt", "ascending"),
        source: "gitlab",
        source_id: sourceId,
        event_type: "mr_merged",
        title: `${repo.projectPath}!${mr.iid}: ${mr.title}`,
        summary: `MR merged`,
        actor: mr.author.username,
        actor_type: detectActorType(mr.author.username, baseMetadata, agentConfig),
        timestamp: parseTimestamp(mr.merged_at ?? mr.updated_at),
        url: mr.web_url,
        metadata: baseMetadata,
        is_read: 0,
              feed: null,
              mode: (repo.mode ?? "own") as "own" | "watch",
              relevance: null,
              relevance_reasoning: null,
        created_at: Date.now(),
      })
    } else if (mr.state === "opened") {
      events.push({
        id: Identifier.create("evt", "ascending"),
        source: "gitlab",
        source_id: sourceId,
        event_type: "mr_opened",
        title: `${repo.projectPath}!${mr.iid}: ${mr.title}`,
        summary: `MR opened by ${mr.author.username}`,
        actor: mr.author.username,
        actor_type: detectActorType(mr.author.username, baseMetadata, agentConfig),
        timestamp: parseTimestamp(mr.created_at),
        url: mr.web_url,
        metadata: baseMetadata,
        is_read: 0,
              feed: null,
              mode: (repo.mode ?? "own") as "own" | "watch",
              relevance: null,
              relevance_reasoning: null,
        created_at: Date.now(),
      })

      // Check pipeline status for open MRs
      if (getPipelineTool?.execute) {
        try {
          const pipelineResult = await getPipelineTool.execute(
            {
              project_id: repo.projectId,
              merge_request_iid: mr.iid,
            },
            { abortSignal: AbortSignal.timeout(10_000) },
          )

          const pipeline = parseToolResult<GitLabPipeline | { pipeline?: GitLabPipeline }>(pipelineResult)
          const pipelineData = pipeline
            ? "pipeline" in (pipeline as Record<string, unknown>)
              ? (pipeline as { pipeline?: GitLabPipeline }).pipeline
              : (pipeline as GitLabPipeline)
            : null

          if (pipelineData && pipelineData.status === "failed") {
            const failedJobs = pipelineData.jobs?.filter((j) => j.status === "failed") ?? []
            const failedNames = failedJobs.map((j) => j.name).join(", ")

            events.push({
              id: Identifier.create("evt", "ascending"),
              source: "gitlab",
              source_id: sourceId,
              event_type: "pipeline_failed",
              title: `${repo.projectPath}!${mr.iid}: ${mr.title}`,
              summary: failedNames ? `Pipeline failed: ${failedNames}` : "Pipeline failed",
              actor: null,
              actor_type: "system" as const,
              timestamp: parseTimestamp(pipelineData.updated_at),
              url: pipelineData.web_url ?? mr.web_url,
              metadata: {
                ...baseMetadata,
                pipeline_id: pipelineData.id,
                pipeline_status: pipelineData.status,
                ...(failedJobs.length > 0
                  ? { failed_jobs: failedJobs.map((j) => ({ name: j.name, id: j.id })) }
                  : {}),
              },
              is_read: 0,
              feed: null,
              mode: (repo.mode ?? "own") as "own" | "watch",
              relevance: null,
              relevance_reasoning: null,
              created_at: Date.now(),
            })
          }
        } catch (err) {
          log.debug("failed to fetch pipeline for MR", {
            projectPath: repo.projectPath,
            mrIid: mr.iid,
            error: err,
          })
        }
      }

      // Check for comments/discussions on open MRs
      if (getReviewsTool?.execute) {
        try {
          const reviewsResult = await getReviewsTool.execute(
            {
              project_id: repo.projectId,
              merge_request_iid: mr.iid,
            },
            { abortSignal: AbortSignal.timeout(10_000) },
          )

          const discussions = parseToolResult<
            GitLabDiscussion[] | { discussions?: GitLabDiscussion[] }
          >(reviewsResult)
          const discussionList = discussions
            ? Array.isArray(discussions)
              ? discussions
              : (discussions as { discussions?: GitLabDiscussion[] }).discussions ?? []
            : []

          for (const discussion of discussionList) {
            for (const note of discussion.notes) {
              // Skip system notes (auto-generated by GitLab)
              if (note.system) continue

              events.push({
                id: Identifier.create("evt", "ascending"),
                source: "gitlab",
                source_id: sourceId,
                event_type: "mr_commented",
                title: `${repo.projectPath}!${mr.iid}: ${mr.title}`,
                summary: note.body ? note.body.slice(0, 200) : "New comment",
                actor: note.author.username,
                actor_type: detectActorType(note.author.username, baseMetadata, agentConfig),
                timestamp: parseTimestamp(note.created_at),
                url: mr.web_url,
                metadata: {
                  ...baseMetadata,
                  discussion_id: discussion.id,
                  note_id: note.id,
                },
                is_read: 0,
                feed: null,
              mode: (repo.mode ?? "own") as "own" | "watch",
              relevance: null,
              relevance_reasoning: null,
                created_at: Date.now(),
              })
            }
          }
        } catch (err) {
          log.debug("failed to fetch reviews for MR", {
            projectPath: repo.projectPath,
            mrIid: mr.iid,
            error: err,
          })
        }
      }
    }
  }

  return events
}
