export type ActivitySource = "jira" | "github" | "gitlab"

export type SourceMode = "own" | "watch"

export type ActorType = "human" | "agent" | "system"

export type ActivityEventType =
  // Jira event types
  | "issue_created"
  | "status_changed"
  | "assigned"
  | "commented"
  | "priority_changed"
  | "blocked"
  | "field_updated"
  // GitHub event types
  | "pr_opened"
  | "pr_merged"
  | "pr_closed"
  | "review_requested"
  | "review_submitted"
  | "pr_commented"
  | "issue_opened"
  | "issue_closed"
  | "issue_commented"
  | "mentioned"
  | "ci_failed"
  // GitLab event types
  | "mr_opened"
  | "mr_merged"
  | "mr_commented"
  | "pipeline_failed"

export interface ActivityEvent {
  id: string
  source: ActivitySource
  source_id: string
  event_type: ActivityEventType
  title: string
  summary: string | null
  actor: string | null
  actor_type: ActorType
  timestamp: number
  url: string | null
  metadata: Record<string, unknown> | null
  is_read: number
  feed: string | null
  mode: "own" | "watch" | null
  relevance: string | null
  relevance_reasoning: string | null
  created_at: number
}

export interface PollingAdapter {
  source: ActivitySource
  poll(): Promise<ActivityEvent[]>
  isAvailable(): Promise<boolean>
  /** Stable hash of the adapter's effective config. Used to detect config changes. */
  configHash(): string | null
}

export interface PollState {
  id: string
  source: ActivitySource
  last_poll_ts: number
  last_success_ts: number | null
  consecutive_failures: number
  config_hash: string | null
}
