-- 0036_peer_share_hourly_aggregate.sql
--
-- Hourly rolling aggregate layer for peer-share realtime delta streaming.
--
-- Motivation: cofounders want to see each other's current spending trend
-- without waiting 24 h for the daily digest. This table powers the
-- /api/peer-share/subscribe SSE endpoint which streams cost/token/event
-- deltas as they accumulate within each 1-hour bucket.
--
-- Schema: one row per (owner_id, viewer_id, hour_bucket, source, model).
--   hour_bucket — TIMESTAMPTZ truncated to the hour (UTC).
--
-- Retention: last 72 hours (3 days) per active grant. The cron
-- /api/cron/peer-share-hourly trims rows older than HOURLY_RETENTION_HRS
-- on each tick.
--
-- Privacy floor: metadata only — counts, costs, source enums, model names.
-- Identical guarantee to peer_share_daily_aggregate: no prompts,
-- completions, code, diffs, or raw OTel spans.

CREATE TABLE IF NOT EXISTS peer_share_hourly_aggregate (
  owner_id        UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  viewer_id       UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

  -- Truncated to the start of the UTC hour (e.g. 2026-06-29 14:00:00+00).
  hour_bucket     TIMESTAMPTZ NOT NULL,

  -- Dimension breakdown — same as daily layer.
  source          TEXT        NOT NULL DEFAULT '',
  model           TEXT        NOT NULL DEFAULT '',

  tokens_input    BIGINT      NOT NULL DEFAULT 0,
  tokens_output   BIGINT      NOT NULL DEFAULT 0,
  cost_millicents BIGINT      NOT NULL DEFAULT 0,
  event_count     INT         NOT NULL DEFAULT 0,

  -- Bookkeeping.
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (owner_id, viewer_id, hour_bucket, source, model)
);

-- Hot path: SSE subscriber queries by (viewer_id, hour_bucket DESC) to fetch
-- recent deltas for all grants the subscriber holds.
CREATE INDEX IF NOT EXISTS peer_share_hourly_agg_viewer_bucket_idx
  ON peer_share_hourly_aggregate (viewer_id, hour_bucket DESC);

-- Retention sweep: quickly find rows outside the 72-hour window.
CREATE INDEX IF NOT EXISTS peer_share_hourly_agg_bucket_idx
  ON peer_share_hourly_aggregate (hour_bucket);
