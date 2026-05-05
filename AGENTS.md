# AGENTS.md -- PAL canonical project context

## Project objective

PAL (Personal Agent Liaison) is a TUI dashboard for human-agent team coordination.
Forked from [opencode](https://github.com/anomalyco/opencode), PAL extends the
open-source AI coding agent with features purpose-built for a product team:

- Polls Jira, GitHub, and GitLab to surface items requiring human attention
- Tracks domain health across team-owned areas
- Filters upstream open-source activity for deployment relevance
- Enforces a problem-first process (problem statement before solution scope)
- Auto-updates via GitLab Releases

PAL is a **developer tool**, not an operational service. It runs locally on each
team member's workstation.

## Architecture

### TUI tabs

| Tab | Route file | Purpose |
|-----|-----------|---------|
| Agent | `routes/home.tsx` | Chat interface (inherited from opencode) |
| Needs Me | `routes/needs-me.tsx` | Items classified as needing human action |
| Domains | `routes/domains.tsx` | Domain health dashboard |
| Activity | `routes/activity.tsx` | Unified activity feed from all sources |
| Settings | `routes/settings-pal.tsx` | PAL-specific configuration |

### Core subsystems

- **Activity Feed** (`src/activity-feed/`) -- Plugin with 3 polling adapters
  (Jira, GitHub, GitLab). Polls every 90s with exponential backoff on failure.
  Stores events in SQLite with 30-day retention.
- **Needs Me** (`src/needs-me/`) -- Classifier that identifies items requiring
  the current user's attention (assigned issues, review requests, mentions).
- **Domain Health** (`src/domain-health/`) -- Aggregates signals per domain
  (bug counts, overdue items, stale PRs). Domains defined in `domains.json`.
- **Upstream Relevance** (`src/upstream-relevance/`) -- Two-layer classifier:
  Layer 1 is rule-based (keywords/labels/paths from `upstream.yaml`), Layer 2
  uses LLM for ambiguous events (with circuit breaker and daily budget cap).
- **Process Facilitation** (`src/process/`) -- Mechanical assessor that checks
  Jira issues for problem statements and scope. Phases: `needs_problem` ->
  `has_problem` -> `needs_scope` (epics only) -> `ready`. No LLM calls.
- **Auto-update** (`src/installation/pal-update.ts`) -- Checks GitLab Releases
  for newer versions and downloads the platform-appropriate binary.

### Storage

SQLite via Drizzle ORM. Migrations in `packages/opencode/migration/`. Database
is local per user (stored in the opencode data directory).

### Polling

Base interval is 90 seconds. Adapters use exponential backoff on consecutive
failures (max 300s). Poll state is persisted so restarts resume cleanly.

## Repository layout

| Path | Description |
|------|-------------|
| `packages/opencode/src/activity-feed/` | Activity feed plugin + Jira/GitHub/GitLab adapters |
| `packages/opencode/src/needs-me/` | Needs-me classifier and storage |
| `packages/opencode/src/domain-health/` | Domain health signals and config |
| `packages/opencode/src/upstream-relevance/` | Upstream relevance (Layer 1 rules + Layer 2 LLM) |
| `packages/opencode/src/process/` | Process facilitation assessor and epic proposer |
| `packages/opencode/src/cli/cmd/tui/routes/` | TUI tab route components |
| `packages/opencode/src/installation/` | Installer and auto-update logic |
| `packages/opencode/migration/` | Drizzle ORM database migrations |
| `packages/core/` | Shared core utilities (Effect helpers, flags, install) |
| `packages/plugin/` | Plugin framework |
| `packages/sdk/` | SDK for external integrations |
| `packages/script/` | Build and release scripts |
| `domains.example.json` | Domain configuration template |
| `upstream.yaml` | Upstream relevance rules |
| `deployment-context.md` | Deployment context for LLM prompts |
| `install.sh` | Installer script (downloads from GitLab Releases) |

## Tech stack

- **Runtime**: Bun 1.3.13 (specified in `package.json` `packageManager` field)
- **Language**: TypeScript 5.8 (strict mode)
- **Framework**: Effect-TS for service composition and error handling
- **TUI**: SolidJS + @opentui/solid + @opentui/core
- **Database**: SQLite via Drizzle ORM
- **AI**: Vercel AI SDK (`ai` package) for Layer 2 upstream classification
- **Build**: Turborepo for monorepo task orchestration
- **Linting**: oxlint
- **Formatting**: Prettier (no semicolons, 120 char line width)

## Conventions

- Follow existing patterns in the codebase. The project inherits opencode's
  architecture (Effect services, bus events, storage layer).
- Typecheck before pushing: `bun turbo typecheck`
- Run dev mode: `bun run dev`
- Tests live alongside source in `test/` directories. Run per-package, not from root.
- Prettier config: no semicolons, 120 character print width.
- Use Effect-TS patterns for services (Context.Tag, Layer, Effect.gen).

## Gotchas

- **Bun not on PATH by default**: The install script puts the `pal` binary in
  `~/.local/bin`, but `bun` itself may not be on PATH in all shells. The
  pre-push hook calls `bun typecheck`, so ensure bun is available.
- **Husky pre-push hook**: Runs `bun typecheck` on every push. It also
  validates that your local bun version matches `packageManager` in
  `package.json`. If versions differ, the push is rejected.
- **Do not run tests from root**: The root `package.json` has
  `"test": "echo 'do not run tests from root' && exit 1"`. Run tests from
  individual package directories instead.
- **domains.json location**: The domain health system looks for
  `.opencode/domains.json` in the project directory first, then falls back to
  the global config directory. Copy `domains.example.json` to get started.
- **Layer 2 budget**: The LLM-based upstream classifier has a daily soft cap
  (default 200 calls/day) and per-poll limit (default 20). Configured in
  `upstream.yaml` under `layer2:`.
- **Fork lineage**: This is a fork of anomalyco/opencode. See `UPSTREAM.md`
  for the fork point. Upstream changes may need to be merged periodically.
