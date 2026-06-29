-- 0043_peer_share_weekly_agg.sql
--
-- Weekly aggregate layer for peer-share week-over-week trend dashboards.
--
-- Motivation: close BACKLOG #4 (weekly recap email foundation) and enable
-- trend-aware cost forecasting (v0.5 AI standup). Rolls up
-- peer_share_hourly_aggregate into ISO-week buckets so the /compare
-- week-over-week tab can surface WoW deltas without scanning raw events.
--
-- Schema: one row per (owner_id, viewer_id, week_start_iso, field).
--   week_start_iso — TEXT "YYYY-MM-DD", Monday 00:00 UTC (ISO-8601 week start).
--   field          — one of the SHAREABLE_FIELDS aggregated at weekly granularity.
--   value          — BIGINT sum across all hourly rows in the week.
--
-- Privacy floor: identical to peer_share_hourly_aggregate — metadata only.
-- No prompts, completions, code, diffs, or raw OTel spans.
--
-- Refresh: Monday 00:05 UTC cron via /api/cron/peer-share-weekly-agg.
--
-- Retention: rows are never pruned automatically (weekly summaries are small
-- and valuable for trend analysis). A future migration can add pruning.

CREATE TABLE IF NOT EXISTS peer_share_weekly_aggregate (
  id              BIGSERIAL   PRIMARY KEY,
  owner_id        UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  viewer_id       UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

  -- ISO-8601 week start — Monday 00:00 UTC as "YYYY-MM-DD".
  week_start_iso  TEXT        NOT NULL,

  -- One row per aggregated field (cost_millicents, tokens_input, etc.).
  field           TEXT        NOT NULL,
  value           BIGINT      NOT NULL DEFAULT 0,

  -- Bookkeeping.
  upserted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (owner_id, viewer_id, week_start_iso, field)
);

-- Hot path: WoW dashboard queries by (viewer_id, week_start_iso) to load
-- both current and prior week for all grants the subscriber holds.
CREATE INDEX IF NOT EXISTS peer_share_weekly_agg_viewer_week_idx
  ON peer_share_weekly_aggregate (viewer_id, week_start_iso DESC);

-- Owner sweep: list all weekly rows for a given owner (admin/debug).
CREATE INDEX IF NOT EXISTS peer_share_weekly_agg_owner_idx
  ON peer_share_weekly_aggregate (owner_id, week_start_iso DESC);
