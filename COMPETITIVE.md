# Competitive landscape

Distilled from deeper research briefs in `research/`. TL;DR at the top.

## TL;DR

- **Saturated**: individual editor-time tracking, DORA/SPACE team metrics, git-based velocity, single-AI-tool admin dashboards.
- **Unmet**: cross-tool AI visibility, terminal/CLI agent observability, AI-cost → delivery-outcome correlation, privacy-first team observability.
- **Our defensible line**: "one dashboard across every AI tool and terminal, local-first, aggregates-only."

## Who we overlap with (and why we're different)

| Player | What they do | Why we're not them |
|---|---|---|
| **WakaTime** | Editor time tracking for individuals, lightweight teams | Editors only. No AI awareness. No terminal. We accept their protocol and extend. |
| **ActivityWatch** | Local-first activity tracking, OSS | Solo devs, no team story, no AI. Great pattern; we borrow it. |
| **Cursor Admin API** | Usage metrics for Cursor users | Cursor only. Doesn't see Copilot, Claude Code, terminal. |
| **GitHub Copilot Metrics** | Acceptance rate, adoption, DAU for Copilot | Copilot only. Same siloing problem. |
| **Windsurf / Tabnine / Cody** | Per-tool admin dashboards | Same pattern. Teams want cross-tool. |
| **Swarmia / LinearB / Haystack / Jellyfish** | DORA/SPACE team metrics from git/PR data | AI-blind. We feed them, not replace them. |
| **GitClear** | AI-generated code detection from commit signatures | Narrowly focused on git. We ingest git *and* tool APIs *and* OTel spans. |
| **Langfuse / Helicone / Phoenix** | LLM-app observability | App-level, not dev-workflow level. We self-host Langfuse inside Pulse. |
| **Rize.io** | System-level dev activity (apps, URLs) | No AI, no team. |

## The killer gap

A typical AI-heavy engineering team in 2026 uses:
- Cursor (one dashboard)
- GitHub Copilot (another dashboard)
- Claude Code CLI (no dashboard)
- Codeium or Windsurf on some machines (yet another dashboard)
- aider or sgpt in terminal (no dashboard)

**Five dashboards, zero aggregation.** An engineering leader asking "are we getting
value from our $20k/mo AI spend?" has to sum five spreadsheets by hand. Nobody is
solving this. Every AI tool vendor has incentive NOT to solve it (they want you in
their own funnel).

This is the Swarmia-for-AI-tools move. Swarmia won the "aggregate your engineering
signals across GitHub + Jira + Linear + Slack" game. Pulse wins "aggregate your AI
signals across Cursor + Copilot + Claude + Windsurf + Tabnine."

## Why now

Three shifts that make this buildable:

1. **OpenTelemetry GenAI semantic conventions** became an official CNCF standard in
   2024/25. Claude Code already exports to it natively. Others will follow. The
   integration surface is standardizing exactly when we need it to.
2. **Every AI-code-assist vendor shipped an admin API** in the last 18 months
   (Cursor in 2024, Copilot in 2024, Windsurf in 2025, Tabnine in 2024). The
   primitives are in place.
3. **AI spend is a real line item.** A 50-dev team on Cursor ($20/seat) + Copilot
   ($20/seat) = $24k/year *each*. Leaders are asking whether it's justified and
   have no answer.

## Moat

**Short-term**: first-mover advantage on cross-tool aggregation + OTel-native
ingestion. We're early on the OTel GenAI conventions train.

**Medium-term**: the dataset itself. A team feeding Pulse for six months accumulates
per-dev / per-repo / per-tool usage history that's painful to recreate. Switching
cost grows with time, without being a lock-in trap.

**Long-term**: the correlation layer. "Teams that use Claude Code >30% of the time
on greenfield work ship 40% faster" — that kind of cross-org benchmark is only
possible at scale, and it compounds.

## Risks

- **An incumbent builds cross-tool aggregation themselves.** Most likely candidate:
  Swarmia or LinearB extending into AI. Our edge is being AI-native, not
  AI-bolted-on.
- **Cursor / Copilot / Anthropic launch cross-vendor dashboards.** Unlikely — they
  compete with each other. A neutral third party is actually better positioned.
- **Privacy backlash.** Devs could reject any observability tool on principle. Our
  counter: local-first agent, aggregates-only, no prompt/code storage, open source
  code.
- **OSS core hurts commercial upside.** We keep enterprise features (SSO, audit
  logs, advanced correlation) in the paid tier. Same playbook as PostHog, Supabase,
  Langfuse.

## Positioning statement (draft)

> Ashlr Pulse is the engineering-intelligence platform for teams where AI writes a
> meaningful share of the code. It unifies visibility across every AI tool, every
> editor, and every terminal — without bossware-grade surveillance. If your team
> has more than one AI subscription, you need Pulse.
