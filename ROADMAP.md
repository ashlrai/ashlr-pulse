# Roadmap

Rough time estimates assume Mason solo, ~2 hrs/day. Multiply by 2-3 for realistic
calendar time given AshlrAI's other work.

## v0.1 — Personal dogfood (weeks 1–2)

Goal: Mason uses Pulse on his own laptop. Prove the data schema and capture paths.

- [ ] Monorepo scaffold (pnpm workspaces): `agent/`, `server/`, `dashboard/`
- [ ] Rust agent skeleton (or Go — decide after spike): config, OTel collector, local sqlite buffer
- [ ] Claude Code OTel → agent path (`OTEL_EXPORTER_OTLP_ENDPOINT`) end to end, visible in agent's local log
- [ ] Shell preexec/precmd hooks for zsh — capture `{cmd, cwd, duration, exit}` for known AI CLIs (claude, aider, sgpt, q chat)
- [ ] Postgres schema migration (use `activity_event` as specified in ARCHITECTURE.md)
- [ ] Next.js dashboard boilerplate with a "Today" view: minutes by source, tokens today, tool-call timeline
- [ ] One-command local bootstrap: `docker compose up` gives Postgres + server + dashboard

**Success criteria**: Mason can point to the dashboard and see his own Claude Code
sessions broken down by tool call, cost, and project.

## v0.2 — Second developer (weeks 3–4)

Goal: Cody (real human, real company) can install Pulse and see their own data.

- [ ] WakaTime heartbeat endpoint compatibility — verify with VS Code plugin
- [ ] Cursor Admin API poller — pulls per-user daily metrics
- [ ] GitHub Copilot Metrics API poller
- [ ] Per-user + per-project views on dashboard
- [ ] Agent auto-updater
- [ ] Installer: Homebrew tap, `brew install ashlr/pulse/agent`
- [ ] First documentation pass: `docs/getting-started.md`

**Success criteria**: three developers on three different stacks (IDE-heavy, CLI-heavy,
mixed) running Pulse for a week and finding the data accurate.

## v0.3 — Team view (weeks 5–6)

Goal: Pulse answers team questions, not just individual ones.

- [ ] Team/org concept in data model (users belong to orgs, permissions)
- [ ] Team dashboard: aggregated AI usage, top tools, per-user breakdown
- [ ] Daily digest (email / Slack) — "your team did X hours, Y tokens, Z commits yesterday"
- [ ] Cost-per-outcome surface — $X AI spend → Y cycle time delta
- [ ] Privacy UI — dev can see exactly what goes to the server

**Success criteria**: one engineering manager at a 5–20 person team says "this is my
new default dashboard."

## v0.4 — Cloud + billing (weeks 7–9)

Goal: Turn Pulse into a real product you can charge for.

- [ ] Multi-tenant cloud deployment (Fly.io or Railway for v1)
- [ ] Clerk/Supabase Auth
- [ ] Billing: Stripe, $10/dev/mo as a starting guess
- [ ] Marketing site at `pulse.ashlr.ai`
- [ ] Launch: Hacker News, Product Hunt, dev-tool Slack communities

**Success criteria**: 10 paying teams within 60 days of launch.

## v1.0 — Correlation layer (weeks 10+)

Goal: the "outcome correlation" wedge, which is the hardest and most valuable piece.

- [ ] Git ingester with quality signals (PR size, review cycles, revert rate)
- [ ] AI-generated-code attribution via commit signature detection (GitClear approach)
- [ ] "Did heavier AI usage on feature X correlate with more/fewer review cycles?" view
- [ ] Cohort benchmarking (opt-in)
- [ ] Integrations: export to Datadog, Swarmia, Jira, Linear

**Success criteria**: a team can answer "is our AI spend actually moving the needle
on cycle time?" in under 30 seconds on the dashboard.

## Things we might do later (or never)

- Browser extension for ChatGPT/Claude.ai usage in browser
- Custom watcher SDK for teams that want to emit from their own internal tools
- On-prem enterprise tier with SSO + audit
- AI-model fine-tuning with aggregated Pulse data (huge IP minefield; later, or never)
- "Pulse Insights" — a second product that coaches teams on AI adoption patterns

## What we will NOT do, ever

- Keystroke logging
- Screenshot capture
- Storage of prompts or code content in the cloud tier (even opt-in)
- Manager-facing "time away from keyboard" metric
- Ranking devs against each other on a public leaderboard by default
