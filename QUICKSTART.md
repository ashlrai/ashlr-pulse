# Ashlr Pulse · Quickstart

## 1. Start Postgres

```bash
docker compose up -d postgres
```

This starts Postgres on **host port 55432** (mapped to container port 5432). The
non-standard host port avoids conflicts with any local Postgres instance you may
already be running. The mapping lives in `docker-compose.yml` and is intentional —
do not change it for local dev.

Your `DATABASE_URL` for local dev:

```
postgres://pulse:pulse@localhost:55432/pulse
```

## 2. Install dependencies and apply migrations

```bash
cd server
bun install
cp .env.example .env.local   # fill in the values below
bun run migrate
```

Minimum `.env.local` values:

```
DATABASE_URL=postgres://pulse:pulse@localhost:55432/pulse
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_ANON_KEY=<anon-key>
```

## 3. Run the dashboard

```bash
bun run dev    # http://localhost:3000
```

## 4. Sign in via magic link

Navigate to `http://localhost:3000/login`. Enter your email address and click
**Send magic link**. Supabase Auth emails you a one-time link; clicking it sets
your session cookie and redirects to `/`.

## 5. Mint a PAT (personal access token)

PATs are required for programmatic ingest in production. To create one:

```bash
bun run src/cli/mint-pat.ts <user_uuid> <token-name>
```

Example:

```
$ bun run src/cli/mint-pat.ts 018f3c2a-dead-beef-0000-000000000001 "my-laptop"

Token: pat_abc123xyz...  (store this — we cannot show it again)
ID:    018f3c2a-aaaa-bbbb-cccc-000000000042
Name:  my-laptop
```

The raw token is shown exactly once. Store it in your password manager or `.env.local`.

## 6. Ingest auth paths

There are two auth paths for `POST /api/otlp/v1/traces`:

**Production — Bearer PAT:**

```bash
curl -X POST http://localhost:3000/api/otlp/v1/traces \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer pat_abc123xyz...' \
  -d @research/example-span.json
```

**Development — x-ashlr-user header (no PAT needed):**

```bash
curl -X POST http://localhost:3000/api/otlp/v1/traces \
  -H 'content-type: application/json' \
  -H 'x-ashlr-user: mason' \
  -d @research/example-span.json
```

The `x-ashlr-user` header is accepted only when `NODE_ENV=development` (the default
for `bun run dev`). Set `PULSE_DEV_USER` in `.env.local` to the username to trust.
In production, only Bearer PATs are accepted.

## 7. Point Claude Code at the OTLP endpoint

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:3000/api/otlp/v1/traces
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer pat_abc123xyz..."
claude   # or any agentic command
```

Reload `http://localhost:3000` — you should see event counts per source and model.

## 8. Share with a peer

Navigate to `http://localhost:3000/share`. Choose a peer email, select the repos
or scope to share, set the granularity (real-time / daily / weekly), and toggle
which data classes to include (commits, tokens, time, tool calls). Your peer
receives an invite email. You can preview exactly what they see before sending,
and revoke access at any time from the same page.

## What's running in v0.2

- `db/migrations/0001_activity_event.sql` — `user` / `org` / `membership` / `activity_event` tables
- `db/migrations/0002_peer_share.sql` — `peer_share` table and server-side auth layer
- `server/src/app/api/otlp/v1/traces/route.ts` — OTLP/HTTP-JSON ingest with PAT + dev-header auth
- `server/src/app/page.tsx` — today view grouped by source × model
- `server/src/app/share/page.tsx` — peer-share configuration and visibility preview
- `server/src/app/login/page.tsx` — magic-link login via Supabase Auth
- `server/src/cli/migrate.ts` — forward-only migrations tracked in `schema_migrations`
- `server/src/cli/mint-pat.ts` — PAT issuance CLI

See `research/example-span.json` for a minimal GenAI span the mapper accepts.
