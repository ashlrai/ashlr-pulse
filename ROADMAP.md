# Roadmap

Phased from "Mason dogfoods alone" → "founding pair uses it every day" → "early
AI-native teams pay for it" → "full agentic-engineering PM suite." Each phase
is a usable product on its own.

Estimates assume Mason solo, ~2 hrs/day average. Calendar time = 2–3× the raw
estimate given AshlrAI's other work.

---

## v0.1 — Personal dashboard (Mason, alone) — ~2 weeks

**Ship goal**: Mason uses it every day instead of opening GitHub notifications.

- Monorepo scaffold: `agent/`, `server/`, `dashboard/`
- Rust or Go agent with OTel collector, local SQLite buffer
- Claude Code native OTel → agent → dashboard, end to end
- Shell preexec/precmd hooks for zsh — capture `{cmd, cwd, duration, exit}`
  for known AI CLIs (claude, aider, sgpt, q)
- Postgres schema (see `ARCHITECTURE.md`); no prompt/code storage, hardwired
- Next.js dashboard "Today" view: minutes by source, tokens, cost, tool-call
  timeline, per-repo breakdown
- Per-repo grouping into **projects** — manually assigned at first
  (`client-foo`, `saas-bar`, `internal`)
- One-command bootstrap: `docker compose up`
- `brew install ashlrai/pulse/agent`

**Success criteria**: Mason opens Pulse every morning and it reduces his
"what's going on" cognitive load vs GitHub + Slack.

---

## v0.2 — Shared visibility (founding pair) — ~2–3 weeks after v0.1

**Ship goal**: Mason and cofounder use Pulse as their shared dashboard.

- **User accounts + org model** (first time multi-user)
- **Configurable-sharing data model**: per-user, per-peer, per-scope rules.
  Example: Mason → Cofounder: `client-*` realtime, `saas-*` weekly,
  `experiments-*` nothing.
- **"Our team" dashboard view**: pair-oriented layout, peer activity stream,
  shared project portfolio
- **Daily digest**: "here's what Mason shipped yesterday, here's what Cofounder
  shipped" — delivered via Slack DM or email
- _(future)_ WakaTime heartbeat protocol endpoint — cofounder's VS Code plugin works day one. Schema is ready (`activity_event.source = 'wakatime'`); ingester not yet implemented.
- Git commit ingester (via webhook or poll) — fills gaps where only commits are
  the signal
- Auth via Supabase Auth or Clerk

**Success criteria**: Mason and cofounder cancel one weekly sync call because
Pulse replaces its purpose.

---

## v0.3 — Portfolio view (25 repos) — ~3 weeks after v0.2

**Ship goal**: The entire AshlrAI portfolio is legible at a glance.

- **Project-level rollups**: group repos into SaaS products / client engagements
  / internal tools, with drill-down
- **Per-project health cards**: commits/week, active contributors, AI share,
  time since last deploy, token cost this month
- **Attention map**: where the team's effort is actually landing vs. where
  you said it should (pair with a lightweight weekly "intent" note)
- **Engagement billing export**: hours × AI tokens by repo, CSV ready for
  invoicing client work
- _(future)_ Cursor Admin API poller — schema ready (`source = 'cursor'`), poller not yet implemented.
- _(future)_ GitHub Copilot Metrics API poller — schema ready (`source = 'copilot'`), poller not yet implemented.

**Success criteria**: "which client engagement is slipping?" is answerable in
<10 seconds without opening GitHub.

---

## v0.4 — Early team (3–20) + cloud launch — ~4 weeks after v0.3

**Ship goal**: a friend's AI-native startup pays for a cloud seat.

- **Multi-tenant cloud deployment** (Fly / Railway / Render)
- **Team invitation + onboarding flow** — config-share defaults guide new
  hires through what's visible to whom
- **Billing**: Stripe, $10–$15/dev/mo trial pricing
- **Marketing site** at `pulse.ashlr.ai`
- Launch: AshlrAI channels, indie hackers, HN, Product Hunt, dev-tool Slacks
- **Opt-in analytics** for Pulse itself so we learn how teams use Pulse

**Success criteria**: 10 paying teams within 60 days.

---

## v0.5 — Async standup + weekly recap (AI-generated) — ~3 weeks after v0.4

**Ship goal**: replace a standup.

- AI-generated daily standup per person: "yesterday I: … today I plan to: …
  blocked on: …" — inferred from activity + asked for missing pieces
- Weekly recap for the team: human-readable narrative of what moved, what
  didn't, what's new on the attention map
- Pushed to Slack, email, or Pulse inbox

**Success criteria**: a team reports they eliminated a recurring meeting
because of Pulse's async recaps.

---

## v1.0 — Outcome correlation — ~4 weeks after v0.5

**Ship goal**: Pulse answers "was our AI spend worth it?"

- Git quality ingester: PR size, review cycles, revert rate, incident correlation
- AI-generated-code attribution via commit signature detection
- Cohort benchmarking (opt-in; teams compared against anonymized peers)
- Spend-per-outcome surface: $X AI → Y days cycle time delta, Z commits/feature

**Success criteria**: a paying team says "we used Pulse data to justify
continuing/canceling one of our AI tool subscriptions."

---

## v1.5+ — Toward an agentic-engineering PM suite

As Pulse owns the "what actually happened" data, it earns the right to own
"what should happen next."

- Lightweight roadmap (tied to repos and projects, not separate from them)
- Changelog auto-generation from commits + PRs + AI activity
- Ticket layer built on top of actual activity data, not separate aspirational
  goals
- Integration path with Linear / GitHub Projects for teams that already have
  them
- AshlrAI's own agents suggesting "you've been pulled onto three client
  engagements; your SaaS X hasn't seen a commit in two weeks"

Each added layer is only worth building if Pulse's base data is already
trusted — otherwise it's another Linear clone.

---

## Hard nos (today and forever)

- No keystroke logging
- No screenshot capture
- No prompt / code / completion storage at any tier
- No surveillance-mode default where managers see all and ICs see self
- No public leaderboards ranking devs against each other by default
- No "AI acceptance rate ranked between cofounders" — we are not setting
  partners against each other

## Reference: where cotidie fits

cotidie is Mason's personal executive-function system (meds, sleep, meals,
etc.). Pulse is engineering visibility. They sit side by side in AshlrAI's
personal-productivity story but are separate products. Pulse's "coding time"
signal is a plausible input to cotidie's dashboard, and cotidie's
"focus/energy" data could eventually cross-reference into Pulse for
per-developer context — but neither depends on the other.
