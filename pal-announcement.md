**PAL — a terminal dashboard for tracking issues and coordinating work**

I've been building a tool called PAL that gives you a live view of what needs your attention across our GitHub issues and milestones. It reads our [CONTRIBUTING.md](https://github.com/alcove-ai/alcove/blob/main/CONTRIBUTING.md) to understand our development process, and you tell it your role — then it shows you what's relevant to you.

Setup takes about 2 minutes:

```
curl -fsSL https://raw.githubusercontent.com/alcove-ai/pal/main/install.sh | bash
cd ~/devel/alcove
cp .env.example .env
pal
```

On first launch it asks "What's your role?" — just type a sentence like "I'm a developer focused on the CLI and onboarding" and press Enter. That's it.

What you get:
- **Needs Me** tab — open issues and PRs grouped by milestone, filtered to what's not done
- **Activity** tab — unified feed of everything happening in the repo
- Press **Enter** on any item to start an AI triage session that knows our process and your role
- **Left/Right arrows** to collapse/expand milestones
- **Tab** to cycle through views

The process that drives PAL is our [CONTRIBUTING.md](https://github.com/alcove-ai/alcove/blob/main/CONTRIBUTING.md) — if you want to shape how we plan and coordinate work, that's the document to collaborate on. PAL reads it directly, so improvements there immediately improve the tool for everyone.

It auto-updates, so once installed you just run `pal` from the alcove directory. Docs: https://github.com/alcove-ai/pal

This is early — feedback welcome. If something breaks or feels wrong, let me know.
