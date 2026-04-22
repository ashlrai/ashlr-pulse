# Ashlr Pulse

> **Team visibility for the AI-native engineering org.**
> One dashboard across every AI tool, every editor, every terminal — with privacy teams actually trust.

Ashlr Pulse is an engineering-intelligence product for teams where a non-trivial
share of code now flows through AI agents (Claude Code, Cursor, Copilot, Windsurf, aider, etc.).
It solves a problem no incumbent does:

**Teams using multiple AI tools have no single place to answer:**
- Who on my team is actually using AI, and how effectively?
- What did we spend across all of these tools, and what did we get for it?
- Is our AI investment correlated with faster cycle time, lower bug rate, more merged PRs?
- When someone is "coding," how much is AI-driven vs. hand-written?

## Positioning

> **WakaTime, but for the AI era — and for teams, not individuals.**

- WakaTime: editor time for solo devs.
- Copilot / Cursor dashboards: their tool's usage, only.
- Swarmia / LinearB: delivery metrics, AI blind.
- **Ashlr Pulse: every AI tool + every editor + every terminal, unified, for teams.**

## The novel wedge (pick one, we picked this)

**Cross-tool AI attribution, terminal-first, privacy-first.**

Why this and not the alternatives:
- *Cross-tool AI attribution* — immediate "aha" in a demo. Aggregate what today's tools silo.
- *Terminal-first* — nobody is tracking CLI agents well. Claude Code already exports to
  OpenTelemetry natively; we're the first to catch that signal.
- *Privacy-first* — devs are allergic to bossware. Local-first agent emits *aggregates only*
  (tokens, duration, acceptance rate, tool-call counts) to the server. Never prompts,
  never code.

## Why this exists now

Three things that were not true 18 months ago:

1. **Claude Code ships with built-in OTel export.** `OTEL_EXPORTER_OTLP_ENDPOINT=...` gives
   us free instrumentation for every tool call, model used, token count, and session
   duration. Same is landing across the ecosystem (MCP OTel instrumentation exists).
2. **AI tools are now a meaningful line item.** Teams are spending $20–$50/dev/mo on
   Cursor/Copilot/Windsurf/Claude, and nobody can answer "was it worth it?"
3. **Multi-tool reality.** Teams don't standardize on one AI tool anymore. A typical
   engineer uses Cursor for IDE, Claude Code for agent work, Copilot inline, and
   aider in a terminal for refactors. Five dashboards, zero aggregation.

## What we will NOT build

- Per-editor plugins (we accept the WakaTime heartbeat protocol and inherit 600+ plugins free).
- A new LLM observability platform (we self-host Langfuse and map into it).
- A bossware-flavored timer. No keystroke logging, no screenshots, no prompts stored.
- A "better Swarmia" — we don't re-litigate DORA. We emit metrics that *feed into* Swarmia/LinearB.

## Scope for v0.1 (4 weeks, solo)

1. **OTel collector** that accepts:
   - Claude Code's native OTel export
   - WakaTime heartbeat protocol (any existing IDE plugin)
   - Cursor Admin API poller
   - GitHub Copilot Metrics API poller
2. **Unified "activity event" schema** in Postgres (no prompt/code storage, ever).
3. **Self-host-able dashboard** (Next.js) showing per-developer + per-team views:
   - Minutes coded by tool / editor / terminal
   - AI tokens + cost per day, per project, per user
   - Acceptance rate by tool
   - AI-generated code share (via git signature detection, GitClear-style)
4. **One-command install** for the local agent (Docker Compose or `brew install ashlr-pulse`).
5. **Docs**: privacy promise, architecture diagram, integration guides for each AI tool.

## Relationship to AshlrAI

Ashlr Pulse is a second product under the AshlrAI umbrella — not a spin-off, not a pivot.
It reinforces the AshlrAI thesis: *"engineering orgs will be shaped by how they use AI,
and they need tools built for that reality."* Customers of Ashlr's other products are
the same buyers for Pulse.

## What's in this folder

- `README.md` — this file
- `ARCHITECTURE.md` — data model, stack, OSS leverage, deployment shape
- `COMPETITIVE.md` — landscape, whitespace, positioning
- `ROADMAP.md` — phased plan
- `research/` — raw findings from the initial landscape/tech/AI-data research
