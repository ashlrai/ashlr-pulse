-- 0034_peer_share_daily_aggregate.sql
--
-- Materialized daily peer-share aggregate for /share page performance.
--
-- The /share page currently previews "what activity did I share to each peer"
-- by scanning raw activity_event O(N) on every page load — 3–5 s for active
-- users. This table caches the pre-rolled per-(owner, viewer, day) window so
-- the /share page loads in <100 ms via an O(30 rows × N peers) index seek.
--
-- The cron job /api/cron/peer-share-refresh runs nightly at 02:00 UTC and
-- upserts one row per (owner_id, viewer_id, date) for the last 30 calendar
-- days (only pairs that have an active, non-revoked peer_share grant).
--
-- Schema: one row per (owner_id, viewer_id, date) with token/cost sums
-- broken down by source and model so the /share page can render a per-model
-- breakdown without hitting activity_event again.
--
-- Retention: rows older than 30 days are pruned on each cron run to keep the
-- table bounded (the /share date-range picker only offers last-30-days).
--
-- Privacy floor: metadata only (counts, costs, enums). No prompts,
-- completions, code, diffs, or raw OTel spans. Identical guarantee to
-- fleet_daily_aggregate.

CREATE TABLE IF NOT EXISTS peer_share_daily_aggregate (
  owner_id        UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  viewer_id       UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  date            DATE        NOT NULL, -- UTC calendar date

  -- Aggregated from activity_event for this (owner, viewer, day).
  -- Source and model are stored as text; NULL means mixed/unknown.
  source          TEXT        NOT NULL DEFAULT '',
  model           TEXT        NOT NULL DEFAULT '',

  tokens_input    BIGINT      NOT NULL DEFAULT 0,
  tokens_output   BIGINT      NOT NULL DEFAULT 0,
  cost_millicents BIGINT      NOT NULL DEFAULT 0,
  event_count     INT         NOT NULL DEFAULT 0,

  -- Bookkeeping.
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (owner_id, viewer_id, date, source, model)
);

-- Hot path: /share page scans by owner for the last 30 days.
CREATE INDEX IF NOT EXISTS peer_share_daily_agg_owner_date_idx
  ON peer_share_daily_aggregate (owner_id, date DESC);

-- Retention sweep: quickly find rows outside the retention window.
CREATE INDEX IF NOT EXISTS peer_share_daily_agg_date_idx
  ON peer_share_daily_aggregate (date);
