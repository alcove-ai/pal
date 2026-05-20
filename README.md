# PAL -- Personal Agent Liaison

A terminal UI for human-agent team coordination. PAL polls your issue trackers, surfaces what needs your attention, and launches AI triage sessions so you spend time on decisions, not chasing status across Jira, GitHub, and GitLab.

Built on [opencode](https://github.com/anomalyco/opencode).

## Quick Start

1. **Install** (Linux x64/arm64, macOS Apple Silicon):
   ```bash
   curl -fsSL https://raw.githubusercontent.com/alcove-ai/pal/main/install.sh | bash
   ```

2. **Create your role file** (personal, gitignored):
   ```bash
   mkdir -p .opencode
   cat > .opencode/role.md << 'EOF'
   I'm the Tech Lead. I review specs and approve tasks for implementation.
   EOF
   ```

3. **Add a team process doc** (committed to repo):
   Write `.opencode/process.md` describing your team's workflow -- phases, roles, gates, what "done" looks like. Or use your existing `CONTRIBUTING.md`.

4. **Configure issue trackers**:
   ```bash
   cat > .opencode/pal.json << 'EOF'
   {
     "activityFeed": {
       "github": { "repos": { "tier1": ["org/repo"] } }
     }
   }
   EOF
   ```

5. **Launch**:
   ```bash
   pal
   ```

6. Navigate to the **Needs Me** tab with `Shift+Right`. You should see items from your repo. Use `pal --upgrade` to check for updates.

## Tabs

Navigate between tabs with `Shift+Left` / `Shift+Right`.

| Tab | What it shows |
|-----|---------------|
| **Agent** | Chat interface for AI agent sessions |
| **Needs Me** | Items needing your attention, with urgency scoring and recommendations |
| **Domains** | Health signals per team-owned domain |
| **Activity** | Unified feed from Jira, GitHub, and GitLab |
| **Settings** | PAL-specific configuration |

## Needs Me

### Item Layout

Each analyzed item renders as 3 rows:

```
 ▸ 7· G  2h ago   Fix auth token refresh                    jsmith
          State: Spec approved, waiting for implementation plan
          → Review the implementation plan and approve for dev
```

| Row | Content |
|-----|---------|
| **Title** | Selector + urgency badge + source (`G`=GitHub, `J`=Jira, `L`=GitLab) + time + title + actor |
| **State** | Current status of the item according to your team's process |
| **Action** | What you specifically should do next, given your role |

Items being analyzed show a spinner. Unanalyzed items show 2 rows.

### Urgency Scoring

Background agents score each item 1--10. The score determines the badge and color:

| Score | Color | Badge | Meaning |
|-------|-------|-------|---------|
| 8--10 | Red (bold) | `9!` | Act now -- blocking others or overdue |
| 5--7 | Yellow | `6·` | Needs attention soon |
| 3--4 | Blue | `4·` | Normal priority |
| 1--2 | Dim | `2·` | Low priority, informational |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `j` / `k` | Move selection down / up |
| `Enter` | Launch triage session (LLM chat with full issue context, your role, and process doc) |
| `d` | Dismiss selected item |
| `s` | Toggle sort mode (Priority / Grouped) |
| `←` / `→` | Collapse / expand group |

### Sort Modes

Press `s` to toggle. The current mode shows in the header bar.

**[Grouped]** (default) -- Items organized under milestone/epic headers. Collapsible.

```
 ▼ Milestone: v2.1 Release                           (4)
   9! Fix auth token refresh
   7· Update onboarding flow
   5· Resolve flaky CI test
   3· Add rate limiting
 ▼ PROJ-100: Platform Migration                      (2)
   6· Migrate database adapter
   4· Update deployment scripts
 2· Standalone issue with no parent
```

**[Priority ↓]** -- Flat list sorted by urgency, highest first. No grouping.

```
 9! Fix auth token refresh
 7· Update onboarding flow
 6· Migrate database adapter
 5· Resolve flaky CI test
 4· Update deployment scripts
 3· Add rate limiting
 2· Standalone issue with no parent
```

## Team Setup

Rolling PAL out to a team takes three steps:

### 1. Shared config (committed to repo)

One person creates `.opencode/pal.json` and `.opencode/process.md`. These are committed so the whole team uses the same sources and process definition.

### 2. Personal role files (gitignored)

Each team member creates `.opencode/role.md`. This determines what the Needs Me panel shows them. The same panel shows different items to each person:

**Product Owner:**
```
I'm the Product Owner. I prioritize the backlog, represent stakeholder
needs, and approve problem statements before work begins.
```

**Tech Lead:**
```
I'm the Technical Lead. I review specs, approve architecture decisions,
and decide when issues are ready for implementation.
```

**Developer:**
```
I'm a developer on the backend team. I implement features, fix bugs,
and review pull requests assigned to me.
```

### 3. Gitignore role.md

```
# .gitignore
.opencode/role.md
```

## Configuration

| File | Committed? | Purpose |
|------|-----------|---------|
| `.opencode/role.md` | No (gitignored) | Your role on the team |
| `.opencode/process.md` | Yes | Team workflow, phases, and gates |
| `.opencode/pal.json` | Yes | Issue tracker connections (Jira, GitHub, GitLab) |
| `.opencode/domains.json` | Yes | Domain health definitions (copy from `domains.example.json`) |
| `upstream.yaml` | Yes | Upstream relevance classification rules |

## Database Reset

PAL stores data in SQLite at `~/.local/share/opencode/`. Each project gets its own `.db` file (named by a hash of the project directory path).

**To reset:**
```bash
rm ~/.local/share/opencode/*.db
```

PAL recreates databases on next launch. The first poll cycle (~90 seconds) repopulates everything.

**When to reset:**
- Stale data after changing repos in `pal.json`
- Switching what a project directory points to
- Clearing all dismissed items and cached analysis results

## Development

Requires [Bun](https://bun.sh/) 1.3.13+.

```bash
bun install
bun run dev          # run in dev mode
bun turbo typecheck  # typecheck all packages
```

See [AGENTS.md](AGENTS.md) for architecture, conventions, and gotchas.

## Upstream

PAL is forked from [opencode](https://github.com/anomalyco/opencode). Fork lineage recorded in [UPSTREAM.md](UPSTREAM.md).

## License

MIT -- see [LICENSE](LICENSE).
