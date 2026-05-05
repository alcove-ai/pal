export type ActivitySource = "jira" | "github" | "gitlab"

export type ActivityEventType =
  | "issue_created"
  | "status_changed"
  | "assigned"
  | "commented"
  | "priority_changed"
  | "blocked"
  | "field_updated"

export interface ActivityEvent {
  id: string
  source: ActivitySource
  source_id: string
  event_type: ActivityEventType
  title: string
  summary: string | null
  actor: string | null
  timestamp: number
  url: string | null
  metadata: Record<string, unknown> | null
  is_read: number
  created_at: number
}

export interface PollingAdapter {
  source: ActivitySource
  poll(): Promise<ActivityEvent[]>
  isAvailable(): Promise<boolean>
}

export interface PollState {
  id: string
  source: ActivitySource
  last_poll_ts: number
  last_success_ts: number | null
  consecutive_failures: number
}
