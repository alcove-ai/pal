import * as Log from "@opencode-ai/core/util/log"
import type { PollingAdapter, ActivityEvent, ActivityEventType } from "./types"
import { Identifier } from "@/id/id"

const log = Log.create({ service: "activity-feed.github" })

const JIRA_KEY_REGEX = /[A-Z]+-\d+/g

/** Repos where we track all activity */
const DEFAULT_TIER1_REPOS = ["pulp/pulp-service", "pulp/pulpcore"]

/** Repos where we track PRs/issues only */
const DEFAULT_TIER2_REPOS = [
  "pulp/pulp_rpm",
  "pulp/pulp_file",
  "pulp/pulp_certguard",
  "pulp/pulp-cli",
  "pulp/pulp-openapi-generator",
]

/** Repos where we track mentions/review requests only */
const DEFAULT_TIER3_REPOS = ["pulp/pulp_ansible", "pulp/pulp_container", "pulp/pulp_deb", "pulp/pulp_python"]

const BOT_IGNORE_LIST = ["dependabot[bot]", "renovate[bot]", "github-actions[bot]"]

/** Notification reasons we care about */
const TRACKED_REASONS = new Set(["assign", "review_requested", "mention", "comment", "team_mention", "author"])

/** Map GitHub notification reasons to our event types */
const REASON_TO_EVENT_TYPE: Record<string, ActivityEventType> = {
  assign: "assigned",
  review_requested: "review_requested",
  mention: "mentioned",
  team_mention: "mentioned",
  comment: "pr_commented",
  author: "pr_commented",
}

// --- Interfaces for GitHub API responses ---

interface GitHubNotification {
  id: string
  reason: string
  updated_at: string
  subject: {
    title: string
    url: string | null
    latest_comment_url: string | null
    type: string
  }
  repository: {
    full_name: string
    html_url: string
  }
  unread: boolean
}

interface GitHubPR {
  number: number
  title: string
  state: string
  merged_at: string | null
  created_at: string
  updated_at: string
  html_url: string
  head: {
    ref: string
  }
  user: {
    login: string
  }
  requested_reviewers?: Array<{ login: string }>
  draft: boolean
}

interface GitHubReview {
  id: number
  state: string
  submitted_at: string
  user: {
    login: string
  }
  body: string | null
}

interface GitHubSearchResult {
  total_count: number
  items: Array<{
    number: number
    title: string
    state: string
    html_url: string
    created_at: string
    updated_at: string
    user: {
      login: string
    }
    pull_request?: {
      html_url: string
      merged_at: string | null
    }
    repository_url: string
  }>
}

interface GitHubCheckRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  html_url: string
  completed_at: string | null
}

// --- Helpers ---

function parseTimestamp(dateStr: string | null | undefined): number {
  if (!dateStr) return Date.now()
  const ms = Date.parse(dateStr)
  return isNaN(ms) ? Date.now() : ms
}

function extractJiraKeys(text: string | null | undefined): string[] {
  if (!text) return []
  const matches = text.match(JIRA_KEY_REGEX) ?? []
  return [...new Set(matches)]
}

function isBot(login: string | null | undefined): boolean {
  if (!login) return false
  return BOT_IGNORE_LIST.includes(login)
}

function repoTier(
  fullName: string,
  tier1: string[],
  tier2: string[],
  tier3: string[],
): 1 | 2 | 3 | null {
  if (tier1.includes(fullName)) return 1
  if (tier2.includes(fullName)) return 2
  if (tier3.includes(fullName)) return 3
  return null
}

function extractNumberFromUrl(url: string): string | null {
  const match = url.match(/\/(\d+)$/)
  return match ? match[1] : null
}

async function ghExec(args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gh", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      log.debug("gh command failed", { args: args.join(" "), exitCode, stderr: stderr.slice(0, 200) })
      return null
    }
    return stdout.trim()
  } catch (err) {
    log.debug("gh exec error", { args: args.join(" "), error: err })
    return null
  }
}

async function ghApi<T>(path: string): Promise<T | null> {
  const raw = await ghExec(["api", path, "--paginate"])
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    log.debug("failed to parse gh api response", { path, raw: raw.slice(0, 200) })
    return null
  }
}

// --- Adapter ---

export interface GitHubAdapterConfig {
  tier1Repos?: string[]
  tier2Repos?: string[]
  tier3Repos?: string[]
  botIgnoreList?: string[]
  upstreamPollOrg?: string
}

export function createGitHubAdapter(config?: GitHubAdapterConfig): PollingAdapter {
  const tier1 = config?.tier1Repos ?? DEFAULT_TIER1_REPOS
  const tier2 = config?.tier2Repos ?? DEFAULT_TIER2_REPOS
  const tier3 = config?.tier3Repos ?? DEFAULT_TIER3_REPOS
  const bots = new Set(config?.botIgnoreList ?? BOT_IGNORE_LIST)
  const upstreamOrg = config?.upstreamPollOrg ?? "pulp"

  let pollCount = 0

  return {
    source: "github",

    async isAvailable(): Promise<boolean> {
      try {
        const result = await ghExec(["auth", "status"])
        // gh auth status exits 0 when authenticated
        return result !== null
      } catch {
        return false
      }
    },

    async poll(): Promise<ActivityEvent[]> {
      const events: ActivityEvent[] = []
      pollCount++

      // 1. GitHub Notifications
      const notifEvents = await pollNotifications(tier1, tier2, tier3, bots)
      events.push(...notifEvents)

      // 2. PR polling for tier1 repos
      const prEvents = await pollTier1PRs(tier1, bots)
      events.push(...prEvents)

      // 3. Upstream review requests (every 5min ~ every 3rd poll at 90s base)
      if (pollCount % 3 === 1) {
        const upstreamEvents = await pollUpstreamReviewRequests(upstreamOrg, bots)
        events.push(...upstreamEvents)
      }

      return events
    },
  }
}

async function pollNotifications(
  tier1: string[],
  tier2: string[],
  tier3: string[],
  bots: Set<string>,
): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = []

  const notifications = await ghApi<GitHubNotification[]>("/notifications?all=false&per_page=50")
  if (!notifications) return events

  for (const notif of notifications) {
    // Filter by reason
    if (!TRACKED_REASONS.has(notif.reason)) continue

    const repoFullName = notif.repository.full_name
    const tier = repoTier(repoFullName, tier1, tier2, tier3)
    if (tier === null) continue

    // For tier3, only track mentions and review requests
    if (tier === 3 && notif.reason !== "mention" && notif.reason !== "review_requested" && notif.reason !== "team_mention") {
      continue
    }

    // Determine event type based on notification type and reason
    let eventType: ActivityEventType = REASON_TO_EVENT_TYPE[notif.reason] ?? "mentioned"

    // Refine based on subject type
    if (notif.subject.type === "Issue") {
      if (notif.reason === "comment") eventType = "issue_commented"
    }

    const subjectNumber = notif.subject.url ? extractNumberFromUrl(notif.subject.url) : null
    const sourceId = subjectNumber ? `${repoFullName}#${subjectNumber}` : `${repoFullName}#notif-${notif.id}`

    const jiraKeys = extractJiraKeys(notif.subject.title)

    const url =
      notif.subject.type === "PullRequest" && subjectNumber
        ? `https://github.com/${repoFullName}/pull/${subjectNumber}`
        : notif.subject.type === "Issue" && subjectNumber
          ? `https://github.com/${repoFullName}/issues/${subjectNumber}`
          : notif.repository.html_url

    events.push({
      id: Identifier.create("evt", "ascending"),
      source: "github",
      source_id: sourceId,
      event_type: eventType,
      title: notif.subject.title,
      summary: `${notif.reason.replace("_", " ")} on ${repoFullName}`,
      actor: null, // Notifications API doesn't include actor
      timestamp: parseTimestamp(notif.updated_at),
      url,
      metadata: {
        repo: repoFullName,
        tier,
        reason: notif.reason,
        subject_type: notif.subject.type,
        ...(jiraKeys.length > 0 ? { jira_keys: jiraKeys } : {}),
      },
      is_read: 0,
      created_at: Date.now(),
    })
  }

  return events
}

async function pollTier1PRs(tier1: string[], bots: Set<string>): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = []

  for (const repo of tier1) {
    const prs = await ghApi<GitHubPR[]>(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=30`)
    if (!prs) continue

    for (const pr of prs) {
      if (isBot(pr.user.login) || bots.has(pr.user.login)) continue

      const sourceId = `${repo}#${pr.number}`
      const jiraKeys = [...extractJiraKeys(pr.title), ...extractJiraKeys(pr.head.ref)]

      const baseMetadata: Record<string, unknown> = {
        repo,
        tier: 1,
        pr_number: pr.number,
        draft: pr.draft,
        ...(jiraKeys.length > 0 ? { jira_keys: jiraKeys } : {}),
      }

      // Determine event type
      if (pr.merged_at) {
        events.push({
          id: Identifier.create("evt", "ascending"),
          source: "github",
          source_id: sourceId,
          event_type: "pr_merged",
          title: `${repo}#${pr.number}: ${pr.title}`,
          summary: `PR merged`,
          actor: pr.user.login,
          timestamp: parseTimestamp(pr.merged_at),
          url: pr.html_url,
          metadata: baseMetadata,
          is_read: 0,
          created_at: Date.now(),
        })
      } else if (pr.state === "closed") {
        events.push({
          id: Identifier.create("evt", "ascending"),
          source: "github",
          source_id: sourceId,
          event_type: "pr_closed",
          title: `${repo}#${pr.number}: ${pr.title}`,
          summary: `PR closed without merge`,
          actor: pr.user.login,
          timestamp: parseTimestamp(pr.updated_at),
          url: pr.html_url,
          metadata: baseMetadata,
          is_read: 0,
          created_at: Date.now(),
        })
      } else {
        // Open PR
        events.push({
          id: Identifier.create("evt", "ascending"),
          source: "github",
          source_id: sourceId,
          event_type: "pr_opened",
          title: `${repo}#${pr.number}: ${pr.title}`,
          summary: `PR opened by ${pr.user.login}`,
          actor: pr.user.login,
          timestamp: parseTimestamp(pr.created_at),
          url: pr.html_url,
          metadata: baseMetadata,
          is_read: 0,
          created_at: Date.now(),
        })

        // Check for review requests
        if (pr.requested_reviewers && pr.requested_reviewers.length > 0) {
          for (const reviewer of pr.requested_reviewers) {
            events.push({
              id: Identifier.create("evt", "ascending"),
              source: "github",
              source_id: sourceId,
              event_type: "review_requested",
              title: `${repo}#${pr.number}: ${pr.title}`,
              summary: `Review requested from ${reviewer.login}`,
              actor: pr.user.login,
              timestamp: parseTimestamp(pr.updated_at),
              url: pr.html_url,
              metadata: { ...baseMetadata, reviewer: reviewer.login },
              is_read: 0,
              created_at: Date.now(),
            })
          }
        }
      }

      // Check reviews for recently updated PRs (state=open only)
      if (pr.state === "open") {
        const reviews = await ghApi<GitHubReview[]>(`/repos/${repo}/pulls/${pr.number}/reviews?per_page=10`)
        if (reviews) {
          for (const review of reviews) {
            if (isBot(review.user.login) || bots.has(review.user.login)) continue
            if (review.state === "PENDING") continue

            events.push({
              id: Identifier.create("evt", "ascending"),
              source: "github",
              source_id: sourceId,
              event_type: "review_submitted",
              title: `${repo}#${pr.number}: ${pr.title}`,
              summary: `Review ${review.state.toLowerCase()} by ${review.user.login}`,
              actor: review.user.login,
              timestamp: parseTimestamp(review.submitted_at),
              url: pr.html_url,
              metadata: {
                ...baseMetadata,
                review_state: review.state,
                review_id: review.id,
              },
              is_read: 0,
              created_at: Date.now(),
            })
          }
        }

        // Check CI status
        const checkRuns = await ghApi<{ check_runs: GitHubCheckRun[] }>(
          `/repos/${repo}/commits/${pr.head.ref}/check-runs?per_page=20`,
        )
        if (checkRuns?.check_runs) {
          const failedRuns = checkRuns.check_runs.filter(
            (cr) => cr.status === "completed" && cr.conclusion === "failure",
          )
          if (failedRuns.length > 0) {
            const failedNames = failedRuns.map((r) => r.name).join(", ")
            events.push({
              id: Identifier.create("evt", "ascending"),
              source: "github",
              source_id: sourceId,
              event_type: "ci_failed",
              title: `${repo}#${pr.number}: ${pr.title}`,
              summary: `CI failed: ${failedNames}`,
              actor: null,
              timestamp: parseTimestamp(failedRuns[0].completed_at),
              url: failedRuns[0].html_url,
              metadata: {
                ...baseMetadata,
                failed_checks: failedRuns.map((r) => ({ name: r.name, id: r.id })),
              },
              is_read: 0,
              created_at: Date.now(),
            })
          }
        }
      }
    }
  }

  return events
}

async function pollUpstreamReviewRequests(org: string, bots: Set<string>): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = []

  const searchResult = await ghApi<GitHubSearchResult>(
    `/search/issues?q=org:${org}+is:pr+is:open+review-requested:@me&per_page=30`,
  )
  if (!searchResult?.items) return events

  for (const item of searchResult.items) {
    if (isBot(item.user.login) || bots.has(item.user.login)) continue

    // Extract repo from repository_url (https://api.github.com/repos/owner/repo)
    const repoMatch = item.repository_url.match(/\/repos\/(.+)$/)
    const repo = repoMatch ? repoMatch[1] : "unknown"

    const sourceId = `${repo}#${item.number}`
    const jiraKeys = extractJiraKeys(item.title)

    events.push({
      id: Identifier.create("evt", "ascending"),
      source: "github",
      source_id: sourceId,
      event_type: "review_requested",
      title: `${repo}#${item.number}: ${item.title}`,
      summary: `Review requested from you`,
      actor: item.user.login,
      timestamp: parseTimestamp(item.updated_at),
      url: item.html_url,
      metadata: {
        repo,
        upstream: true,
        ...(jiraKeys.length > 0 ? { jira_keys: jiraKeys } : {}),
      },
      is_read: 0,
      created_at: Date.now(),
    })
  }

  return events
}
