# Competitive landscape

Sharpened for the actual ICP: agentic-engineering founding pairs and small teams.

## TL;DR

We do NOT compete with Swarmia / LinearB / Jellyfish. They sell to traditional
VP Engs measuring DORA; we sell to AI-native co-founders measuring "what are we
shipping together."

We compete with **GitHub notifications + Slack + gut feel** — the free, messy,
ad-hoc toolkit every cofounder pair uses today. Our job is to make that
portfolio view so useful that they stop improvising.

## Who we *actually* replace

| What they use today | Why it's broken at 25 repos |
|---|---|
| GitHub mobile app / notification stream | Per-PR, per-comment; no portfolio shape |
| "What are you working on?" Slack DMs | Reactive, lossy, tiring |
| Weekly founders call | Too sparse; too much recall work |
| GitHub org contributions graph | Aggregates everything into one grid; not project-aware |
| Spreadsheet of client hours | Manual; nobody maintains it |

Our win: collapse all five into a single dashboard they open every morning.

## Who we *could be confused with* (and why we're different)

| Player | What they do | Why we're not them |
|---|---|---|
| **Swarmia / LinearB / Haystack / Jellyfish** | DORA + SPACE for mid-market eng orgs | Wrong buyer (VP Eng), wrong process model (sprint/ship-to-prod), AI-blind |
| **Cursor Admin API / Copilot Metrics** | Per-tool usage dashboards | Single-tool, single-purpose, no cross-tool aggregation |
| **Linear / Shortcut / Jira** | Ticketing and sprint management | Tickets are aspirational; we show what actually got done |
| **Basecamp / Height / Notion** | PM suites | Not engineering-data-native; can't see repos/agents |
| **WakaTime / ActivityWatch** | Personal time tracking | Solo-use, no shared-visibility model, no AI awareness |
| **GitClear** | AI-generated code detection from commit signatures | Narrow; no agent-session data, no peer visibility |
| **Langfuse / Helicone / Phoenix** | LLM-app observability | App-level, not dev-workflow level; self-host inside Pulse |

## The defining feature: configurable peer visibility

Every existing observability product is asymmetric: managers see everything,
ICs see themselves. Pulse inverts this.

- **Default**: you see your own data. Nobody else sees anything.
- **Sharing is peer-to-peer, explicit, and revocable.** "Give Sam real-time view
  of my `client-*` repos and weekly-aggregate-only of `ashlr-stack`."
- **Different scopes can share different granularity.** Real-time with a
  cofounder, weekly with a contractor, opt-in aggregated-only with an advisor.
- **Hard privacy floor**: prompt content and code content are never shared,
  never stored in the shared layer. Not a toggle.

This is the feature Swarmia can't add without rebuilding their data model. It's
the feature WakaTime can't add because they have no concept of team. It's the
feature that makes Pulse feel like "a tool for peers" not "a tool for being
watched."

## Moat sources, in priority order

1. **Being first on cross-tool AI-agent aggregation for small teams.** Every
   incumbent is tool-specific or mid-market-oriented; the 2–20-person
   agentic-engineering team is the gap.
2. **Configurable-visibility data model.** Hardwired into our schema from day
   one. Anyone copying us has to rebuild their permissions layer.
3. **OpenTelemetry GenAI-native.** As AI tool vendors standardize on OTel
   (Claude Code already did; others will), Pulse gets integration for free
   while incumbents scramble.
4. **Dataset compounding.** A year of portfolio-level agentic-engineering data
   per team is hard to reconstruct after the fact; switching cost grows
   without lock-in tactics.
5. **AshlrAI distribution.** The same founders buying AshlrAI's other products
   are the same people who'd use Pulse. Shared brand, shared go-to-market.

## Risks

- **The incumbents add "AI mode."** Swarmia/LinearB are already nibbling at AI
  metrics. Mitigation: they're stuck in their VP-Eng/DORA posture; pivoting
  to peer-visibility means breaking their existing buyer.
- **Cursor / Anthropic / GitHub build the cross-tool view themselves.**
  Unlikely — each has anti-incentives to unify with competitors. A neutral
  third party is structurally better positioned.
- **Small teams don't want *any* observability tool.** This is the real risk.
  We mitigate by making the personal dashboard genuinely great (cotidie-level
  polish), so adoption starts with "I want this for me" not "I'm being told
  to use this."
- **OSS core cannibalizes cloud revenue.** Managed it with Langfuse/PostHog/
  Supabase playbook: enterprise/collaboration features in the paid tier; OSS
  gets the individual + small-team flow.

## Positioning statement (draft)

> **Ashlr Pulse is the shared mission control for agentic-engineering teams.**
> Glance once in the morning and know what you and your cofounder shipped,
> which product is accelerating, and what the agents cost you. Peer-visibility
> by default, configurable by you, no bossware ever.
