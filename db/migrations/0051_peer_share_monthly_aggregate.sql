-- 0051_peer_share_monthly_aggregate.sql
--
-- Materialized monthly aggregate for peer-share WoW/MoM trend insight.
--
-- Design:
--   One row per (owner_id, viewer_id, month_bucket, source, model).
--   month_bucket is the first moment of the UTC calendar month, stored as
--   TIMESTAMPTZ (e.g. 2026-06-01 00:00:00+00).
--
--   trend_flag is computed at refresh time by an OLS fit over the prior
--   3 completed months:
--     NULL         — fewer than 2 prior months of data (insufficient history)
--     'stable'     — |slope| < 5% of mean monthly cost
--     'trending_up'  — slope > 0 and above the stable threshold
--     'trending_down' — slope < 0 and above the stable threshold
--     'anomaly'    — current month > mean + 2σ of prior 3 months
--       (z-score anomaly takes precedence over directional trend flags)

CREATE TABLE IF NOT EXISTS peer_share_monthly_aggregate (
  id              BIGSERIAL   PRIMARY KEY,
  owner_id        UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  viewer_id       UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  -- First moment of the UTC calendar month, e.g. 2026-06-01T00:00:00Z
  month_bucket    TIMESTAMPTZ NOT NULL,
  source          TEXT        NOT NULL DEFAULT '',
  model           TEXT        NOT NULL DEFAULT '',
  tokens_input    BIGINT      NOT NULL DEFAULT 0,
  tokens_output   BIGINT      NOT NULL DEFAULT 0,
  cost_millicents BIGINT      NOT NULL DEFAULT 0,
  event_count     INT         NOT NULL DEFAULT 0,
  -- OLS-derived trend flag over prior 3 months; NULL = insufficient history
  trend_flag      TEXT        CHECK (
    trend_flag IS NULL OR trend_flag IN (
      'trending_up', 'trending_down', 'stable', 'anomaly'
    )
  ),
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT peer_share_monthly_aggregate_pkey
    UNIQUE (owner_id, viewer_id, month_bucket, source, model)
);

-- Index for the cron refresh and SSE read path
CREATE INDEX IF NOT EXISTS idx_psma_owner_viewer_bucket
  ON peer_share_monthly_aggregate (owner_id, viewer_id, month_bucket DESC);
