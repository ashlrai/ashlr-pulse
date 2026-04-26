-- 0008_perf_indexes.sql
--
-- Defensive indexes for queries that the dashboard + digest already issue
-- but that didn't have purpose-built indexes in 0001/0004. At <1M rows
-- these are unnecessary; they start mattering around 1-10M and become
-- critical past that. Adding now is cheaper than waiting for a slow
-- dashboard load to surface the bug.
--
-- All CONCURRENTLY-able in Postgres ≥12, but we run inside a transaction
-- via lib/cli/migrate.ts (sql.begin), so we use plain CREATE INDEX —
-- the tables are small enough today that the brief lock is fine.

-- Cost-by-model dashboard panel: aggregates over (model, ts).
CREATE INDEX IF NOT EXISTS activity_event_model_ts_idx
  ON activity_event (model, ts DESC)
  WHERE model IS NOT NULL;

-- Same shape for provider — used by future provider-comparison views and
-- already by the digest's by-source aggregation when a provider filter
-- is applied through peer-share scope_value.
CREATE INDEX IF NOT EXISTS activity_event_provider_ts_idx
  ON activity_event (provider, ts DESC)
  WHERE provider IS NOT NULL;

-- Repo-level aggregation for digest "by repo" + dashboard repo card.
-- Composite (user_id, repo_name, ts) gives index-only scan path for the
-- "yesterday in MY repos" query.
CREATE INDEX IF NOT EXISTS activity_event_user_repo_ts_idx
  ON activity_event (user_id, repo_name, ts DESC)
  WHERE repo_name IS NOT NULL;

-- Existing 0004 index was on github_repo (account_id) WHERE enabled. The
-- dashboard also filters by account_id+enabled, then joins to events on
-- repo_id; that path is fine. But the cron sync iterates per-account too
-- and benefits from a small composite. (No-op if 0004's exists.)
CREATE INDEX IF NOT EXISTS github_repo_account_enabled_idx
  ON github_repo (account_id, enabled);
