# Activity Feed Architecture

The activity feed is a polling-based plugin that aggregates events from three sources into a unified SQLite-backed store.

## Adapters

| Adapter | Source file | What it polls |
|---------|-----------|---------------|
| Jira | `jira-adapter.ts` | Issue updates, comments, status transitions |
| GitHub | `github-adapter.ts` | PRs, issues, reviews, commits |
| GitLab | `gitlab-adapter.ts` | MRs, issues, pipelines |

## Polling behavior

- Base interval: 90 seconds
- Backoff on failure: exponential up to 300 seconds
- Recovery threshold: 3 consecutive successes to reset backoff
- First-run lookback: 24 hours
- Retention: 30 days (pruned in batches of 500)

## Data flow

1. Each adapter implements the `PollingAdapter` interface from `types.ts`
2. The main `ActivityFeed` service (`index.ts`) schedules polls via Effect
3. New events are inserted into the `ActivityEventTable` (Drizzle schema in `activity-feed.sql.ts`)
4. Bus events (`ActivityEventsUpdated`, `ActivityPollStatus`) notify the TUI
5. The upstream relevance classifier is invoked for GitHub/GitLab events to assign a relevance level
6. The Needs Me classifier further filters events to identify items requiring the current user's action

## Agent detection

`agent-detector.ts` identifies whether an event actor is a human or an AI agent (e.g., Dependabot, Renovate). Agent-generated events are tagged so the Needs Me classifier can apply different priority rules.
