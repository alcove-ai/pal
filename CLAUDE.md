# Claude Code -- project context

This workspace uses **AGENTS.md** as the canonical project context. Read it first.

## Before making changes

1. Read `AGENTS.md` for architecture, conventions, gotchas, and workflow.
2. Skim `UPSTREAM.md` for fork lineage (forked from anomalyco/opencode).
3. Prefer small, reviewable steps; ask for constraints before starting.

## Working agreements

- Propose a short plan for non-trivial work; then implement.
- After edits, suggest **tests** or **verification** commands (e.g. `bun turbo typecheck`).
- For commits: use conventional commit style (`feat:`, `fix:`, `docs:`, etc.).
- **Do NOT bump versions or cut releases** unless explicitly asked. Pushes to main do not publish.
- To release: bump version in `packages/opencode/package.json`, commit, then `make release`.

## Tech stack (quick reference)

TypeScript, Bun 1.3.13, Effect-TS, SolidJS + @opentui/solid (TUI), SQLite + Drizzle ORM, Vercel AI SDK, MCP

## Key config files

| File | Purpose |
|------|---------|
| `domains.example.json` | Domain health configuration template (copy to `.opencode/domains.json`) |
| `upstream.yaml` | Upstream relevance classification rules (must-act/review/watch/noise) |
| `turbo.json` | Turborepo task configuration |
| `bunfig.toml` | Bun package manager settings |
