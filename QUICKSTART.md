# Pulse v0.1 · quickstart

One-user dogfood loop: spin up Postgres, apply migrations, run the server, point your Claude Code OTel exporter at it, open `/`.

```bash
# 1. Start Postgres
docker compose up -d postgres

# 2. Install server deps and apply the schema
cd server
bun install
cp .env.example .env.local
bun run migrate

# 3. Run the dashboard server
bun run dev                                    # http://localhost:3000

# 4. Point Claude Code at the OTLP endpoint (new shell)
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:3000/api/otlp/v1/traces
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
claude  # or any command that uses Claude Code

# 5. Reload http://localhost:3000 — you should see event counts per source/model.
```

## What's in v0.1

- `db/migrations/0001_activity_event.sql` — `user` / `org` / `membership` / `activity_event` tables mirroring `ARCHITECTURE.md`.
- `server/src/app/api/otlp/v1/traces/route.ts` — OTLP/HTTP-JSON ingest. Maps GenAI-shaped spans to rows.
- `server/src/app/page.tsx` — the "today" view, grouped by source × model.
- `server/src/cli/migrate.ts` — applies the SQL files in order; tracks state in `schema_migrations`.

## What's NOT in v0.1

- Auth (hardcoded `PULSE_DEV_USER` env; real auth is v0.2).
- Peer-share model (v0.2).
- Portfolio view (v0.3).
- Rust agent (lives in `agent/` — stub only for v0.1).
- Plugin-side emitter (Week 3 of the sprint — plugin PR to emit OTel spans here).

## Verifying without Claude Code

```bash
curl -X POST http://localhost:3000/api/otlp/v1/traces \
  -H 'content-type: application/json' \
  -H 'x-ashlr-user: mason' \
  -d @research/example-span.json
```

See `research/example-span.json` for a minimal GenAI span that the mapper accepts.
