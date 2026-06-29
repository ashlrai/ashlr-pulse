-- 0041_fleet_cost_impact.sql
--
-- Support table for fleet cost-impact dashboard (M49).
--
-- peer_share_daily_aggregate already exists (0034) and holds per-owner daily
-- cost aggregates gated by peer_share grants. This migration adds:
--
--   1. A model column to peer_share_daily_aggregate (if not already present)
--      so the fleet-cost-impact lib can compute model preference drift.
--
--   2. An index to speed up the cost-impact org-level aggregation query:
--        WHERE owner_id = ANY(...) AND date >= $cutoff
--
-- Privacy: metadata only — counts, costs, model names. No user content.
--
-- Idempotent: both statements use IF NOT EXISTS / DO NOTHING patterns.

-- 1. Add model column to peer_share_daily_aggregate for model drift queries.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name  = 'peer_share_daily_aggregate'
      AND column_name = 'model'
  ) THEN
    ALTER TABLE peer_share_daily_aggregate
      ADD COLUMN model TEXT NOT NULL DEFAULT '';
  END IF;
END $$;

-- 2. Add tokens_input / tokens_output if missing (for cost/token metric).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name  = 'peer_share_daily_aggregate'
      AND column_name = 'tokens_input'
  ) THEN
    ALTER TABLE peer_share_daily_aggregate
      ADD COLUMN tokens_input  BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN tokens_output BIGINT NOT NULL DEFAULT 0;
  END IF;
END $$;

-- 3. Index for org-member cost-impact queries.
CREATE INDEX IF NOT EXISTS idx_ps_daily_agg_owner_date
  ON peer_share_daily_aggregate (owner_id, date DESC);

-- 4. Index for model drift queries (owner_id + date range + model).
CREATE INDEX IF NOT EXISTS idx_ps_daily_agg_owner_model_date
  ON peer_share_daily_aggregate (owner_id, model, date DESC);
