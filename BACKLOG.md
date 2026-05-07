# BACKLOG.md — what's left to make Pulse complete & elite

Living punch list of work that hasn't shipped yet. Distinct from
`ROADMAP.md`, which is the strategic version-by-version plan; this file
is the tactical "open this branch, you have everything you need to
ship" backlog. Anyone (including a fresh AI agent) should be able to
pick up any item below cold from another machine.

Last reviewed: 2026-05-06 (post-deploy of `fb46dec`).

---

## Already shipped recently — context for the backlog

The last few sessions landed:

- **Plan-gate enforcement**: peer-share API gate (was silently bypassed),
  `/api/ask` plan-gate + 30/hr rate limit (was an unbounded Claude
  spend vector), `pulse-agent invite <email>` CLI subcommand wired to a
  new PAT-authed `/api/agent/invite` route (was missing despite being
  promised in `AGENTS.md`).
- **Self-observability**: `lib/metrics.ts` exposes counters + cron
  tick ring through `/api/healthz` and a new `/admin/health` page.
- **Cost accuracy**: full Anthropic rate sheet (Opus 4.7/4.6/4.5 → 3,
  Sonnet 4.6 → 3.5, Haiku 4.5 → 3) plus a `normalizeModel()` that
  resolves dated/legacy API IDs (`claude-3-5-haiku-20241022` →
  `claude-haiku-3-5`, `claude-opus-4-20250514` → `claude-opus-4`).
  One-time backfill of `cost_millicents` for the ~32% of historical
  rows that ingested before that column existed (migration 0021).
- **Subscription mode**: `org.billing_mode` column + settings toggle so
  Claude Code Pro/Max/Team users see a "rate-card · 24h" label and
  banner instead of being told their flat-rate plan cost $518/day.
- **Per-source filter** on `/app` (claude_code / cursor / copilot /
  shell / git / wakatime / ashlr_plugin) with URL persistence. Fixed
  a latent peer-share scope-filter param-numbering bug along the way.
- **Project detail page** at `/projects/[id]`: 14d cost trajectory,
  top repos, model breakdown.
- **Privacy assurance** at `/privacy/assurance`: live FORBIDDEN_FIELDS
  + SHAREABLE_FIELDS + a JSON sample of the most recent stored row.
- **Digest highlights**: composition-based anomaly callouts at the
  top of the daily email.
- **UX cleanup**: empty states for `/projects` (zero unassigned) and
  `/settings/tokens` (zero PATs); textMute contrast bumped to WCAG
  AA at small text; global `<code>` background fix that was rendering
  repo names as white-on-white.
- **Stripe webhook**: `revalidatePath` for plan-gated pages on
  subscription transitions.
- **Dashboard refactor**: extracted `ProjectRollupTable`, `ActivityFeed`,
  and shared format helpers into `app/_components/`.

Total tests now: **370 server pass / 0 fail · 41 agent pass / 0 fail**.

---

## Tier 1 — Fills the core "mission-control" promise

### 1. Cursor + Copilot ingesters
- **Why**: schema reserves `source ∈ {cursor, copilot, wakatime}` but no
  agent code emits those. Pulse is effectively Claude-only today, even
  though `ROADMAP.md` v0.2 / v0.3 promises cross-tool visibility.
- **Where**: new `agent/src/cursor.rs` (Cursor Admin API poller; needs
  the org's Cursor admin token via `~/.config/pulse/config.toml`) and
  `agent/src/copilot.rs` (GitHub Copilot Metrics API; needs the same
  GitHub OAuth token Pulse already holds for commit ingest).
- **Server adapter**: `server/src/lib/otel-genai.ts` already maps the
  `source` enum; agent modules just need to emit OTLP/JSON spans with
  `ashlr.source = "cursor"` or `"copilot"`.
- **Effort**: M per integration. Cursor first — Copilot has the harder
  org-admin bootstrap.
- **Validation**: integration test against a fixture API response.
- [ ] Cursor poller
- [ ] Copilot poller
- [ ] WakaTime heartbeat ingest endpoint (no agent code; just a server
      route at `/api/ingest/wakatime` that translates WakaTime's heartbeat
      protocol to an `activity_event` insert)

### 2. Engagement / billing CSV export
- **Why**: ROADMAP v0.3 calls this out by name. Today it doesn't exist.
  Critical for the "invoice the client for AI-assisted work" motion.
- **Where**: new `server/src/app/billing/export/page.tsx` (date range +
  project picker form), new `server/src/app/api/billing/export/route.ts`
  (CSV generator), new `server/src/lib/billing-export.ts` (the
  hours+tokens aggregation).
- **Hours calculation**: wall-clock between first and last span per
  day per repo, capped at 8h. Surface the cap in a tooltip.
- **Plan-gate**: Pro+ only via `requirePlan(org, "pro")`.
- **Effort**: S–M. Mostly SQL + CSV serialization.
- [ ] Form page + CSV download
- [ ] Plan-gate test
- [ ] CSV format unit test

### 3. Filter dashboard by repo / model / date range
- **Why**: `/app` only filters by window + source today. "Show me
  client-x for last week on Opus 4.6" requires three filters that don't
  exist.
- **Where**: extend `LoadOpts` in `server/src/lib/dashboard-data.ts` to
  accept `repoFilter?`, `modelFilter?`, `sinceISO?` / `untilISO?`. Add
  the corresponding `($N::text IS NULL OR repo_name = $N)` clauses to
  the SQL with the same fixed-slot bind layout we already use.
- **UI**: search box (autocomplete from the user's recent repos), model
  dropdown populated from the data, date-range picker.
- **URL persistence**: encode in query params so the user can bookmark.
- **Effort**: S. The SQL change is mechanical; the autocomplete is the
  most variable piece.
- [ ] Repo filter
- [ ] Model filter
- [ ] Date-range filter
- [ ] URL params + bookmarkable state

### 4. Weekly recap email
- **Why**: daily digest is shipped; weekly recap is the higher-signal
  "what changed on this team" view ROADMAP v0.5 references.
- **Where**: add `digest_frequency: 'daily' | 'weekly' | 'both'` column
  on user. Update `lib/digest.ts` to accept a frequency parameter; add
  a Monday 9am-local cron that calls `buildDigest` with `weekly`.
- **Content**: WoW deltas (cost / tokens / events), top 3 anomalies,
  forecast through end-of-month using existing `lib/forecast.ts`.
- **Effort**: M.
- [ ] Schema migration
- [ ] Frequency-aware buildDigest
- [ ] Weekly cron route
- [ ] Settings UI toggle

---

## Tier 2 — Closes audit punch list & operational gaps

### 5. Saved views + side-by-side compare
- `dashboard_view` table exists; UI to manage views is half-done.
  Add "this week vs last week" delta-% card view.
- Files: `server/src/app/app/page.tsx` (add view picker + compare mode),
  `server/src/lib/dashboard-view-db.ts` (already has `listViews`; add
  `compareViews`).
- [ ] Create / list / delete saved views
- [ ] Compare mode (`?view=A&compare=B`)
- [ ] Delta % rendering on stat cards

### 6. Insights page (`/insights`)
- `lib/cost-insights.ts` already generates recommendations; today they
  render as dead-end cards on `/app`. Add a dedicated page with history
  + dismiss/act buttons that round-trip to a new `cost_insight_action`
  table for follow-up tracking.
- [ ] /insights page
- [ ] cost_insight_action table
- [ ] Dismiss + act actions

### 7. Session deep-dive (`/sessions/[id]`)
- Spans already carry `claude.session.id`. Group by it, render a
  per-session cost timeline + tool-call breakdown.
- Files: new `server/src/app/sessions/page.tsx` (filterable list),
  `server/src/app/sessions/[id]/page.tsx` (detail).
- [ ] List page
- [ ] Detail page
- [ ] Index on session_id (likely already covered by dedup index)

### 8. Peer-share "shared with me" panel
- Today peer access works via `?as=<peer_id>` but discoverability is
  poor. Add a small panel on `/app` listing active grants given to the
  current user with one-click switch.
- File: `server/src/app/app/page.tsx`. Add a `loadGrantsToViewer`
  helper if it doesn't already exist in `peer-share-db.ts`.

### 9. Mobile responsive layouts
- Stat strip + charts overflow at <800px. Audit-flagged.
- Files: `server/src/app/layout.tsx` global media-query CSS;
  `server/src/components/charts/*` ResponsiveContainer wrappers.
- [ ] Stat strip stacks below 600px
- [ ] Chart container fluid width
- [ ] Mobile nav

### 10. Stripe webhook event-id idempotency
- Today we rely on full-row UPDATEs being idempotent. Belt-and-suspenders:
  add a `stripe_event` table that records `event_id` with `INSERT … ON
  CONFLICT DO NOTHING` so a replay storm doesn't re-fire side effects
  (revalidatePath, future Slack pings, etc.).
- File: `server/src/app/api/stripe/webhook/route.ts`. New migration.
- **Effort**: S.

---

## Tier 3 — Privacy / lifecycle / ops

### 11. "Delete all my data" + JSONL export
- `/privacy/assurance` mentions but doesn't ship the buttons.
  - Delete: cascading DELETE across `activity_event`, `peer_share`,
    `pat`, `github_*`, etc. for the user. Soft-delete the user row.
  - Export: streaming JSONL of the user's full activity (only
    SHAREABLE_FIELDS — never prompts/completions/raw_otel_span).
- Files: new `server/src/app/api/privacy/{delete,export}/route.ts`.
- **Effort**: S–M.

### 12. Retention enforcement automation
- Free-tier limit is 7d; today the cutoff is enforced at *read* time
  (`retentionCutoff()`) but the rows still exist.
- Add a nightly cron that `DELETE`s rows past the user's plan retention.
- Files: `server/src/app/api/cron/retention/route.ts`,
  `server/src/lib/cron.ts` registration.

### 13. Railway auto-deploy fix
- `AGENTS.md` documents auto-deploy is broken. Manual `railway up` is
  the workaround we used 4× this week. Either:
  - Rebuild the GHA workflow (Railway's CLI in Actions), OR
  - Switch to Railway's native GitHub integration in the dashboard.
- **Effort**: S–M depending on what exactly broke.

### 14. Self-observability — alerting
- `/admin/health` surfaces metrics; nothing pages anyone when ingest
  stalls. Add a "if `ingest.last_span_ts > 60min ago AND user has agent
  configured` then email admin" cron.
- File: `server/src/app/api/cron/ingest-watchdog/route.ts`.

### 15. Agent test coverage finish
- `auth.rs` + `config.rs` + `invite.rs` got tests. Still untested:
  `git.rs`, `state.rs`, `heartbeat.rs`, `orchestrator.rs`,
  `shell_install.rs`, `service_install.rs`.
- Each is M-effort because they require `tokio` runtime + fixture
  repos / files. Lowest-priority of the operational items.

---

## Tier 4 — Data-quality follow-ups specific to the prod database

### 16. Rename `<synthetic>` model rows
- 46 rows have `model = '<synthetic>'`, all from Mar–May 2026, no
  recent ingests. Looks like a legacy backfill artifact (the literal
  string isn't emitted by current agent code).
- Recommendation: `UPDATE activity_event SET model = NULL WHERE model
  = '<synthetic>'` so future GROUP BYs aren't misleading. They can't
  be priced regardless.

### 17. Rotate the postgres proxy password
- The DB password was echoed via `railway variables --kv` in a session
  transcript. The DB is only reachable through Railway's TCP proxy and
  the password rotates cheaply.
- Action: Railway → postgres service → variables → regenerate
  `POSTGRES_PASSWORD`. Re-link via `setBillingState` not affected.

---

## How to pick this up from another machine

```sh
git clone https://github.com/ashlrai/ashlr-pulse.git
cd ashlr-pulse
cd server && bun install && bun run typecheck && bun test
# Pick an item above. Each is self-contained — no item depends on
# another being done first, except:
#   - #4 (weekly recap) is easier after #5 (saved views) for the
#     "this week vs last week" rendering.
#   - #2 (CSV export) and #3 (filter) share the LoadOpts SQL plumbing.

# Per AGENTS.md:
#   - main is the active branch; don't push to master.
#   - Migrations apply automatically on Railway boot via
#     server/scripts/entrypoint.sh — every migration is IF NOT EXISTS.
#   - Privacy floor (peer-share-guard.ts) is non-negotiable.
#   - Bun, not npm. cargo for the agent. tsc for typecheck.
```

When you're done, tick the relevant `[ ]` boxes in this file and
include the changes in your commit so the backlog stays accurate.
