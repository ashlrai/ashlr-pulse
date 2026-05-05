-- 0019_dedup_hour_bucket.sql
--
-- Production after 0018 deploy still showed duplicates: same content
-- (model, tokens, repo, cost-to-the-cent), spread across 10-40
-- seconds of different timestamps. The 0018 formula bucketed ts to
-- the second, so 3-7 emissions of the same logical assistant turn
-- spread across 30s would all land in distinct dedup_keys.
--
-- Symptom in feed:
--   1.9k / $0.49 / +862.0k cache  · 11s ago
--   1.9k / $0.49 / +862.0k cache  · 36s ago
--   1.9k / $0.49 / +862.0k cache  · 37s ago
-- Cost matches to the cent → underlying token columns are byte-for-
-- byte identical → it's pure timestamp drift between emissions, not
-- two distinct events. The agent (or twin emitters) re-fires the
-- same logical turn over a multi-second window.
--
-- Fix: replace the to-second ts bucket with a to-hour bucket. Two
-- emissions of identical content within the same hour collapse to
-- one row. Two genuinely distinct events that happen to match
-- exactly on tokens are still separated when they cross an hour
-- boundary; within an hour, the residual false-positive risk is
-- bounded (same model + same exact token counts on every column +
-- same repo + same source = an extremely specific match).
--
-- Formula must match server/src/lib/otel-genai.ts makeDedupKey().
--
-- IMPORTANT: drop the unique index from 0017 BEFORE the UPDATE.
-- Coarsening the time bucket merges previously-distinct dedup_keys
-- onto the same value, which would violate the unique constraint
-- mid-UPDATE and abort the migration. We re-create the index after
-- the DELETE collapses the duplicates.

DROP INDEX IF EXISTS uq_activity_event_dedup;

UPDATE activity_event
SET dedup_key = LEFT(encode(digest(
  user_id::text                                                      || '|' ||
  to_char(date_trunc('hour', ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24') || '|' ||
  COALESCE(model, '')                                                || '|' ||
  COALESCE(tokens_input::text,           '0')                        || '|' ||
  COALESCE(tokens_output::text,          '0')                        || '|' ||
  COALESCE(tokens_reasoning::text,       '0')                        || '|' ||
  COALESCE(tokens_cache_read::text,      '0')                        || '|' ||
  COALESCE(tokens_cache_5m_write::text,  '0')                        || '|' ||
  COALESCE(tokens_cache_1h_write::text,  '0')                        || '|' ||
  COALESCE(tokens_cache_write::text,     '0')                        || '|' ||
  COALESCE(repo_name, '')                                            || '|' ||
  source,
  'sha256'
), 'hex'), 32);

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY user_id, dedup_key ORDER BY id) AS rn
  FROM activity_event
  WHERE dedup_key IS NOT NULL
)
DELETE FROM activity_event
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Recreate the universal partial unique now that duplicates are gone.
CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_event_dedup
  ON activity_event (user_id, dedup_key)
  WHERE dedup_key IS NOT NULL;
