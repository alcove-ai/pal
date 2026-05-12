# PAL — Personal Agent Liaison

A terminal-based dashboard for human-agent team coordination.
Forked from [opencode](https://github.com/anomalyco/opencode).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/pal/main/install.sh | bash
```

That's it. A single binary lands in `~/.local/bin/pal`. PAL auto-updates
on every launch — no need to re-run the installer.

To install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/pal/main/install.sh | bash -s v0.2.0
```

### Prerequisites

- Linux (x64 or arm64) or macOS (Apple Silicon)
- `~/.local/bin` on your `PATH` (the installer will tell you if it's not)
- An AI provider API key configured in `~/.opencode/config.json` (PAL prompts on first run)

### Uninstall

```bash
rm ~/.local/bin/pal
```

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
bun turbo typecheck                      # typecheck all packages
cd packages/opencode && bun run build    # cross-compile binaries
```

## Architecture

See [AGENTS.md](AGENTS.md) for full project context, architecture, conventions,
and gotchas.

## License

MIT — see [LICENSE](LICENSE).

Fork lineage recorded in [UPSTREAM.md](UPSTREAM.md).
