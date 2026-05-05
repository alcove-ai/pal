# PAL — Personal Agent Liaison

A terminal-based dashboard for human-agent team coordination.
Forked from [opencode](https://github.com/anomalyco/opencode).

## Install

```bash
curl -fsSL https://gitlab.cee.redhat.com/hosted-pulp/pal/-/raw/main/install.sh | bash
```

Installs a single binary to `~/.local/bin/pal`.

## What it does

PAL wraps an AI agent session and adds five tabs:

| Tab | Purpose |
|-----|---------|
| Agent | Chat interface (inherited from opencode) |
| Needs Me | Items classified as needing your attention |
| Domains | Domain health dashboard |
| Activity | Unified activity feed (Jira, GitHub, GitLab) |
| Settings | PAL-specific configuration |

## Local development

Requires [Bun](https://bun.sh/) 1.3.13+.

```bash
bun install
bun run dev
```

## Build

```bash
bun turbo typecheck          # typecheck all packages
cd packages/opencode && bun run build   # cross-compile binaries
```

## Architecture

See [AGENTS.md](AGENTS.md) for full project context, architecture, conventions,
and gotchas.

## License

MIT — see [LICENSE](LICENSE).

Fork lineage recorded in [UPSTREAM.md](UPSTREAM.md).
