# Ashlr Pulse

> **The shared mission control for agentic-engineering teams.**
> What you're building, what your cofounder is building, what the agents are doing —
> across every repo, with visibility you actually control.

Ashlr Pulse gives agentic-engineering teams configurable peer-visibility into each
other's work — commits, AI tool usage, and token cost — with a hard privacy floor
that never stores prompts, completions, or code. It is built on OpenTelemetry GenAI
semantic conventions, so nothing about the data model is proprietary.

## Status

**v0.2 in progress** — single-user dashboard and cofounder peer-share is live;
multi-tenant cloud is v0.4. See [ROADMAP.md](ROADMAP.md) for the full arc.

## What's running

- **OTLP ingest** at `POST /api/otlp/v1/traces` — accepts GenAI-shaped OTel spans
- **Today dashboard** at `/` — repos × models × token cost, grouped by source
- **Peer-share** at `/share` — configure what your cofounder sees and preview it
- **Login** at `/login` — magic-link via Supabase Auth
- **PAT mint** via `bun run src/cli/mint-pat.ts` — issue personal access tokens for
  programmatic ingest

## Run it locally

```bash
docker compose up -d postgres   # Postgres on host port 55432
cd server && bun install
cp .env.example .env.local      # fill in SUPABASE_URL, SUPABASE_ANON_KEY, DATABASE_URL
bun run migrate && bun run dev  # http://localhost:3000
```

See [QUICKSTART.md](QUICKSTART.md) for full setup, auth, and ingest instructions.

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
| [ARCHITECTURE.md](ARCHITECTURE.md) | Data model, OTel schema, stack, deployment shapes |
| [PERSONAS.md](PERSONAS.md) | Who this is for |
| [ROADMAP.md](ROADMAP.md) | Phased plan from dogfood to PM suite |
| [COMPETITIVE.md](COMPETITIVE.md) | Landscape and our defensible line |
| [QUICKSTART.md](QUICKSTART.md) | Local setup, auth, ingest, and smoke tests |

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
