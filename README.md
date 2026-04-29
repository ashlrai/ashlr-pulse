# Ashlr Pulse

> **The shared mission control for agentic-engineering teams.**
> What you're building, what your cofounder is building, what the agents are doing —
> across every repo, with visibility you actually control.

Ashlr Pulse gives agentic-engineering teams configurable peer-visibility into each
other's work — commits, AI tool usage, and token cost — with a hard privacy floor
that never stores prompts, completions, or code. It is built on OpenTelemetry GenAI
semantic conventions, so nothing about the data model is proprietary.

## Get started in 60 seconds

Pulse is built for teams whose primary tool is Claude Code (or Codex, Cursor,
Aider). The setup story is too — drop these two commands in front of your AI
coding assistant and it'll do the rest:

```bash
curl -fsSL https://raw.githubusercontent.com/ashlrai/ashlr-pulse/main/agent/install.sh | sh
pulse-agent onboard --url https://pulse.ashlr.ai
```

The unified `onboard` command runs six idempotent steps end-to-end:
server-reach → PAT mint (browser-mediated approval) → repo auto-discovery →
shell hook install → background service → GitHub connect. Each step prints a
structured progress line so AI agents driving the CLI can follow along, and
emits explicit "human action required" handoff blocks for the few moments
that need a passkey or browser approval. See **[AGENTS.md](AGENTS.md)** for
the canonical AI-driveable instructions, and [DEPLOY.md](DEPLOY.md) for
hosting your own.

## Status

**v0.2 in progress** — single-user dashboard, cofounder peer-share, daily
digest, project rollups, AI-first onboarding all live. Multi-tenant cloud is
v0.4. See [ROADMAP.md](ROADMAP.md) for the full arc.

## What's running

- **OTLP ingest** at `POST /api/otlp/v1/traces` — accepts GenAI-shaped OTel spans
- **Today dashboard** at `/app` — by source × model × project × repo, with
  agent-uptime badge + missed-repos warning + cost rollups
- **Peer-share + invite links** at `/share` — configure what your cofounder
  sees, generate one-shot invite URLs that auto-suggest peer-share defaults
- **GitHub OAuth + magic-link sign-in** at `/login`
- **pulse-agent** — local Rust binary; tails Claude Code sessions (cmux-friendly),
  optional shell hook for terminal AI CLIs (claude, codex, aider, sgpt, …),
  and git. CLI subcommands: `run`, `init`, `onboard`, `doctor`, `login`,
  `backfill`. See [agent/README.md](agent/README.md).
- **Daily digest** — opt-in morning email summarizing yesterday's activity
  (your own + peers, filtered through peer-share). Toggle at `/settings`.
  Sends via SendGrid.

## Run it locally

```bash
docker compose up -d postgres   # Postgres on host port 55432
cd server && bun install
cp .env.example .env.local      # fill in SUPABASE_URL, SUPABASE_ANON_KEY, DATABASE_URL
bun run migrate && bun run dev  # http://localhost:3000
```

See [QUICKSTART.md](QUICKSTART.md) for full setup, [DEPLOY.md](DEPLOY.md) for
hosting your own, and [AGENTS.md](AGENTS.md) for the AI-agent-driveable
contract.

### Wiring secrets to production

The canonical path uses [Phantom](https://phantom.ashlr.ai) so the agent
never handles secret values:

```bash
# 1. Seal secrets into the vault from a TTY prompt (values never enter the transcript)
phantom init --env-file server/.env.local

# 2. Push prod-required keys to Railway in one step
phantom sync --platform railway   # reads .phantom.toml at repo root
```

`server/scripts/wire-stripe-to-railway.sh` automates this for the three
Stripe keys specifically — run it after any key rotation.

**Fallback (no Phantom installed):** paste secrets directly into the
Railway dashboard at railway.app → your project → Variables. Do not use
`railway variables set KEY=value` — that puts the value in shell history.

## Privacy floor

Ashlr Pulse **never stores**: prompts, completions, user code, file contents,
stdout/stderr, screenshots, or keystrokes. These fields are excluded at the ingest
layer and cannot be enabled by any configuration or paid tier. The hard floor is
enforced at the server level — `fields` on `peer_share` is enum-restricted to
exclude `prompts`, `completions`, and `raw_otel_span`.
(See [ARCHITECTURE.md](ARCHITECTURE.md) lines 91 and 212.)

## Docs

| File | Contents |
|---|---|
| **[AGENTS.md](AGENTS.md)** | **Canonical AI-agent instructions** — read first when an agent is working in or with this repo |
| [DEPLOY.md](DEPLOY.md) | End-to-end self-hosting walkthrough (Railway + SendGrid + Supabase + GitHub OAuth) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Data model, OTel schema, stack, deployment shapes |
| [PERSONAS.md](PERSONAS.md) | Who this is for |
| [ROADMAP.md](ROADMAP.md) | Phased plan from dogfood to PM suite |
| [COMPETITIVE.md](COMPETITIVE.md) | Landscape and our defensible line |
| [QUICKSTART.md](QUICKSTART.md) | Local setup, auth, ingest, and smoke tests |
| [agent/README.md](agent/README.md) | `pulse-agent` install + run + config |
| [agent/CHANGELOG.md](agent/CHANGELOG.md) | Agent release notes |

## The core idea

Modern founding teams don't work like 2019. A two-founder AI startup ships code
across fifteen repos, mixes client engagements with SaaS products, and uses Claude
Code / Cursor / Copilot / aider as primary tools rather than occasional assists.
**You don't need a manager seeing everyone's activity — you need peers with
configurable windows into each other's work.**

Ashlr Pulse is that shared window.

- **For you**: every repo you touched today, every agent session, every token,
  grouped by product or engagement.
- **For your team**: configurable peer-to-peer visibility — you and your cofounder
  each decide what you share with whom. Not surveillance — consent.
- **Evolves into**: the project/team-org/productivity tool built from the ground up
  for teams where agents do most of the code.

## License

MIT — see [LICENSE](LICENSE).
