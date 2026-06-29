-- 0047_peer_share_model_source_lang_agg.sql
--
-- Cross-dimensional peer-share materialized aggregates.
--
-- Motivation: the /dashboard/team-metrics and /app/heatmap views need
-- cost/token breakdowns sliced by model, source, and language without
-- running slow GROUP BY queries over peer_share_hourly_aggregate on every
-- page load. These three tables cache daily dimensional roll-ups so
-- drill-down filtering is an O(index seek) rather than a full scan.
--
-- Schema: three parallel tables — one per dimension — each holding one row
-- per (share_id, owner_id, viewer_id, bucket_date, dimension_value).
--
--   share_id        — FK to peer_share.id (ON DELETE CASCADE).
--   owner_id        — denormalized from the grant for fast sweeps.
--   viewer_id       — denormalized from the grant for fast sweeps.
--   bucket_date     — UTC calendar date (daily granularity).
--   dimension_value — the model name / source enum / language tag for this row.
--   cost_millicents — total cost in millicents for this (pair, date, dimension).
--   tokens_input    — total input tokens.
--   tokens_output   — total output tokens.
--   event_count     — total event count.
--
-- Refresh: hourly cron /api/cron/peer-share-dimensional-agg runs after
-- peer-share-hourly-agg, reads peer_share_hourly_aggregate, and upserts
-- into these three tables. Idempotent (INSERT … ON CONFLICT DO UPDATE).
--
-- Retention: rows older than 30 days are pruned on each cron run
-- (same retention window as peer_share_daily_aggregate).
--
-- Privacy floor: metadata only — counts, costs, source enums, model names,
-- language tags. No prompts, completions, code, diffs, or raw OTel spans.
-- Identical guarantee to peer_share_daily_aggregate.

-- ── By model ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS peer_share_daily_agg_by_model (
  share_id        UUID        NOT NULL REFERENCES peer_share(id) ON DELETE CASCADE,
  owner_id        UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  viewer_id       UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bucket_date     DATE        NOT NULL,   -- UTC calendar date
  dimension_value TEXT        NOT NULL DEFAULT '',  -- model name, '' = unknown

  cost_millicents BIGINT      NOT NULL DEFAULT 0,
  tokens_input    BIGINT      NOT NULL DEFAULT 0,
  tokens_output   BIGINT      NOT NULL DEFAULT 0,
  event_count     INT         NOT NULL DEFAULT 0,

  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (share_id, bucket_date, dimension_value)
);

-- Hot path: dashboard drill-down by (share_id, bucket_date range, dimension)
CREATE INDEX IF NOT EXISTS peer_share_daily_agg_model_share_date_dim_idx
  ON peer_share_daily_agg_by_model (share_id, bucket_date DESC, dimension_value);

-- Retention sweep
CREATE INDEX IF NOT EXISTS peer_share_daily_agg_model_date_idx
  ON peer_share_daily_agg_by_model (bucket_date);

-- ── By source ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS peer_share_daily_agg_by_source (
  share_id        UUID        NOT NULL REFERENCES peer_share(id) ON DELETE CASCADE,
  owner_id        UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  viewer_id       UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bucket_date     DATE        NOT NULL,
  dimension_value TEXT        NOT NULL DEFAULT '',  -- source enum, '' = unknown

  cost_millicents BIGINT      NOT NULL DEFAULT 0,
  tokens_input    BIGINT      NOT NULL DEFAULT 0,
  tokens_output   BIGINT      NOT NULL DEFAULT 0,
  event_count     INT         NOT NULL DEFAULT 0,

  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (share_id, bucket_date, dimension_value)
);

CREATE INDEX IF NOT EXISTS peer_share_daily_agg_source_share_date_dim_idx
  ON peer_share_daily_agg_by_source (share_id, bucket_date DESC, dimension_value);

CREATE INDEX IF NOT EXISTS peer_share_daily_agg_source_date_idx
  ON peer_share_daily_agg_by_source (bucket_date);

-- ── By language ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS peer_share_daily_agg_by_language (
  share_id        UUID        NOT NULL REFERENCES peer_share(id) ON DELETE CASCADE,
  owner_id        UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  viewer_id       UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bucket_date     DATE        NOT NULL,
  dimension_value TEXT        NOT NULL DEFAULT '',  -- language tag (e.g. "typescript"), '' = unknown

  cost_millicents BIGINT      NOT NULL DEFAULT 0,
  tokens_input    BIGINT      NOT NULL DEFAULT 0,
  tokens_output   BIGINT      NOT NULL DEFAULT 0,
  event_count     INT         NOT NULL DEFAULT 0,

  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (share_id, bucket_date, dimension_value)
);

CREATE INDEX IF NOT EXISTS peer_share_daily_agg_lang_share_date_dim_idx
  ON peer_share_daily_agg_by_language (share_id, bucket_date DESC, dimension_value);

CREATE INDEX IF NOT EXISTS peer_share_daily_agg_lang_date_idx
  ON peer_share_daily_agg_by_language (bucket_date);
