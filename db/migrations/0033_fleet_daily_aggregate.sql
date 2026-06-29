-- 0033_fleet_daily_aggregate.sql
--
-- Materialized daily fleet aggregate for dashboard rollup performance.
--
-- computeFleetMetrics() currently fans out 12 concurrent queries against
-- activity_event (potentially millions of rows) on every /oversight page
-- render and weekly digest pass. For windows >= 7 days this is the dominant
-- read load. This table caches the pre-rolled 30-day window per org per day
-- so those reads become O(30 rows) index seeks instead of full scans.
--
-- The cron job /api/cron/fleet-daily runs once at 01:00 UTC and upserts one
-- row per active org for yesterday's calendar date (UTC). The lib helper
-- refreshFleetAggregates() recomputes a date range on demand (back-fill,
-- admin resync). computeFleetMetrics() reads from this table when days >= 7.
--
-- Retention: rows older than 90 days are pruned by the cron job to keep the
-- table bounded. 90 days ≫ the 30-day dashboard window and comfortably covers
-- the weekly digest's rolling comparison.
--
-- Privacy floor: analytics metadata only — counts, rates, USD costs,
-- agent/repo counts. No user code, prompts, completions, or diffs.

CREATE TABLE IF NOT EXISTS fleet_daily_aggregate (
  org_id         UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  date           DATE        NOT NULL,          -- UTC calendar date (exclusive end = date+1)

  -- Productivity totals for this org on this UTC day.
  proposals      INT         NOT NULL DEFAULT 0,
  applied        INT         NOT NULL DEFAULT 0,
  rejected       INT         NOT NULL DEFAULT 0,
  cost_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,

  -- Snapshot values sampled at compute time.
  active_agents  INT         NOT NULL DEFAULT 0,
  repos_touched  INT         NOT NULL DEFAULT 0,

  -- Bookkeeping.
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (org_id, date)
);

-- Hot path for computeFleetMetrics range scans.
CREATE INDEX IF NOT EXISTS fleet_daily_aggregate_org_date_idx
  ON fleet_daily_aggregate (org_id, date DESC);

-- Retention sweep: quickly find rows outside the 90-day window.
CREATE INDEX IF NOT EXISTS fleet_daily_aggregate_date_idx
  ON fleet_daily_aggregate (date);
