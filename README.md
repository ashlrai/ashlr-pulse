# Ashlr Pulse

> **The shared mission control for agentic-engineering teams.**
> What you're building, what your cofounder is building, what the agents are doing —
> across every repo, with visibility you actually control.

## The core idea

Modern founding teams don't work like 2019. A two-founder AI startup now ships code
across fifteen repos, mixes custom client engagements with SaaS products, and uses
Claude Code / Cursor / Copilot / aider as primary tools rather than occasional
assists. The information shape has inverted: **you don't need a manager seeing
everyone's activity — you need peers with configurable windows into each other's
work.**

Ashlr Pulse is that shared window.

- **For you**: an incredible personal dashboard. Every repo you touched today,
  every agent session, every commit, every token, grouped by product or
  engagement. What happened yesterday. What's moving this week.
- **For your team**: a *configurable* peer-to-peer visibility layer. You and your
  cofounder each decide what you share with whom. Not surveillance — consent.
- **Evolves into**: the project/team-org/productivity tool built from the ground
  up for teams where agents do most of the code.

## Who it's for

**Now**: founding teams and small AI-native engineering orgs (2–20 people) who are
living the agentic-engineering reality — many repos, many projects, heavy AI tool
usage, and a real need to stay in sync without burning cycles on status meetings.

**Later**: larger agentic teams and the engineering leaders at companies
transitioning their orgs to the agent-heavy model.

Explicitly **not** for: traditional enterprise eng-leader "velocity tracking"
buyers. Those orgs will use Swarmia/LinearB until agentic engineering eats them.

## The three levels of the product

### 1. Personal — your own dashboard that actually feels great

- Every repo you touched today, grouped by product / engagement / misc
- Every agent session — Claude Code, Cursor, Copilot, aider — unified
- AI cost by project so you can answer "what did this customer engagement cost me
  in tokens"
- Daily + weekly + monthly views, with the same trends/correlations thinking
  cotidie is using
- Offline-first: runs locally, agent pushes to your own data store

### 2. Shared — configurable visibility with teammates

The defining feature. Each user controls:

- **Who sees what**: per-person, per-scope rules. "My cofounder sees everything
  in the `client-*` repos; my cofounder sees only weekly aggregates from my
  personal side projects."
- **What granularity**: real-time / daily / weekly / monthly. Different for
  different viewers.
- **What data**: commits + repo names (baseline), AI tool usage, token cost,
  time-of-day patterns, language breakdown — each toggleable.
- **What's never shared**: prompts, completions, code contents. Ever. No opt-in,
  no paid tier. Hard-coded.

Default: you see yourself, nobody else. Sharing is explicit, bidirectional, and
revocable.

### 3. Team — portfolio view across products and engagements

With 25 repos split across multiple SaaS products and custom client engagements,
the interesting question is rarely "what did Alice do today" — it's "which
product is shipping and which is stalling?"

- Group repos into **projects** (SaaS, client engagement, internal tool, etc.)
- Per-project health: commits/week, active contributors, AI share of code,
  time since last deploy
- Engagement billing signal: tokens × hours by repo, exported to CSV for
  invoicing client work
- "Attention map" — where the team's agentic effort is landing this week,
  vs. where you said it should land

## Why this exists now

Three shifts that make it buildable and timely:

1. **Claude Code ships with native OpenTelemetry export.** Drop an OTLP collector
   in and you capture every tool call, every token, every session — zero
   instrumentation code. Cursor and Copilot followed with public admin APIs.
   The data surface exists.
2. **Agentic engineering is the default for new companies.** Every AI-native
   startup founded after ~2024 treats Claude Code / Cursor / aider as the
   primary development surface. Tools built for 2019 (WakaTime, Swarmia) don't
   model this world.
3. **AI cost is now a first-class line item**, not a curiosity. Teams spending
   $2–$10k/month on AI tools need to answer "was this worth it per engagement,
   per product."

## The evolution arc

```
v0.1  Personal dashboard              → dogfood for Mason
v0.2  Shared visibility (peer pairs)  → dogfood with cofounder
v0.3  Project grouping across 25 repos → dogfood the portfolio view
v0.4  Team org (3-20 users)           → opens cloud SaaS
v0.5  Async standup + weekly recap    → AI writes the digest from real data
v1.0  Outcome correlation layer       → AI spend → shipping velocity
v1.5+ Full PM layer                   → roadmap + changelog + tickets, native to agent workflows
```

Each phase is a useful product on its own. Each unlocks the next.

## Why "Ashlr Pulse" specifically

- **Ashlr** is the brand — same family as AshlrAI's other products.
- **Pulse** communicates: live, ambient, something you glance at, not something
  you report to. Not dashboard-as-surveillance; dashboard-as-shared-heartbeat.

## What's in this folder

- `README.md` — this file
- `ARCHITECTURE.md` — data model, stack, OSS leverage
- `COMPETITIVE.md` — landscape + our defensible line
- `ROADMAP.md` — phased plan from dogfood to PM suite
- `PERSONAS.md` — who this is for, in plain language
- `research/` — raw research briefs (landscape, OSS foundations, AI data surfaces)
