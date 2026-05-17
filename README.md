# PAL -- Personal Agent Liaison

A terminal UI that helps humans coordinate with AI agents on software teams.
Forked from [opencode](https://github.com/anomalyco/opencode).

## Why PAL

When AI agents can implement anything, the human bottleneck shifts from writing code to deciding what to build and coordinating who does what. PAL gives each team member a live, role-aware view of what needs their attention -- filtered through their role and their team's process -- so they spend time on decisions, not on chasing status across Jira, GitHub, and GitLab.

## How It Works

PAL is built on two concepts: **Role** and **Process**.

**Role** -- You create `.opencode/role.md` describing who you are and what you do. This file is personal and gitignored. PAL reads it to understand what matters to you:

```
I'm the Product Owner for Hosted Pulp. I prioritize work, represent
stakeholder needs, and approve problem statements before work begins.
```

```
I'm the Technical Lead. I review specs, approve architecture decisions,
and decide when issues are ready for implementation.
```

```
I'm an SRE. I monitor service health, respond to incidents, and own
the deployment pipeline.
```

**Process** -- Your team writes `.opencode/process.md` (or uses `CONTRIBUTING.md`) describing how the team works -- phases, roles, gates, what "done" looks like. This is committed to the repo. Two real examples:

- **Alcove team**: Milestone-driven GitHub workflow. Phases: problem statement, team agreement, spec, implementation plan, ready-for-dev. Each phase has a clear gate and owner.
- **Pulp team**: Jira-based with PO, TL, and Epic Owner roles. Epics require problem statements and specs before implementation. Monday planning and Wednesday sync ceremonies.

**The flow**: PAL polls your issue trackers every 90 seconds. The **Needs Me** tab shows items grouped by epic/milestone that need your attention, filtered by your role. Select an item and press Enter -- PAL runs a single LLM call that reads your process doc, your role, and the issue details, then launches a triage session that knows exactly what you should do next.

## Quick Start

```bash
# Install (Linux x64/arm64, macOS Apple Silicon)
curl -fsSL https://raw.githubusercontent.com/alcove-ai/pal/main/install.sh | bash

# In your project directory, create your role file (gitignored)
cat > .opencode/role.md << 'EOF'
I'm the Tech Lead. I review specs and approve tasks for implementation.
EOF

# Add a team process doc (committed to repo)
# Either write .opencode/process.md or use your existing CONTRIBUTING.md

# Configure your issue trackers
cat > .opencode/pal.json << 'EOF'
{
  "activityFeed": {
    "github": { "repos": { "tier1": ["org/repo"] } }
  }
}
EOF

# Run
pal
```

Use `pal --upgrade` to check for updates before launching.

## Configuration

| File | Committed? | Purpose |
|------|-----------|---------|
| `.opencode/role.md` | No (gitignored) | Your role on the team |
| `.opencode/process.md` | Yes | Team workflow, phases, and gates |
| `.opencode/pal.json` | Yes | Issue tracker connections, upstream config |
| `.opencode/domains.json` | Yes | Domain health definitions (copy from `domains.example.json`) |
| `upstream.yaml` | Yes | Upstream relevance classification rules |

## Tabs

| Tab | What it shows |
|-----|---------------|
| **Agent** | Chat interface for AI agent sessions |
| **Needs Me** | Items needing your attention, grouped by epic/milestone |
| **Domains** | Health signals per team-owned domain (bug counts, stale PRs, overdue items) |
| **Activity** | Unified feed from Jira, GitHub, and GitLab |
| **Settings** | PAL-specific configuration |

## For Teams

Teams can maintain a shared config repo (or directory) with `process.md`, `pal.json`, and `domains.json`. Each team member clones it into `.opencode/` and adds their own `role.md`. The Pulp team does this -- one `pal.json` configures Jira, GitHub, and GitLab sources for everyone, while each person's role file determines what they see in Needs Me.

Context is enriched with [MemPalace](https://github.com/alcove-ai/mempalace) semantic memory when available, giving the LLM triage call access to past decisions and team knowledge.

## Development

Requires [Bun](https://bun.sh/) 1.3.13+.

```bash
bun install
bun run dev          # run in dev mode
bun turbo typecheck  # typecheck all packages
```

See [AGENTS.md](AGENTS.md) for architecture, conventions, and gotchas.

## License

MIT -- see [LICENSE](LICENSE). Fork lineage recorded in [UPSTREAM.md](UPSTREAM.md).
