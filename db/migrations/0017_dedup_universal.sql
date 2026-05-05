-- 0017_dedup_universal.sql
--
-- Production check at 2026-05-04 showed 24h cost was still ~12× over
-- what billable tokens could possibly justify ($1810 on 6.1M billable
-- against a $25/M ceiling for Opus output → max $152). The Wave 1
-- dedup_key index from 0015 was scoped `WHERE span_id IS NULL`, which
-- only catches retried-without-span-id duplicates. cmux running
-- multiple Claude Code instances against the SAME conversation emits
-- the same logical assistant turn with DIFFERENT span_ids per
-- instance — both unique indexes (0007's span_id, 0015's null-span
-- dedup_key) miss those, so cost was being multiplied by the
-- multiplexer factor.
--
-- This migration:
--
--   1. Drops the null-span-only partial unique from 0015.
--   2. Recomputes dedup_key for every row using a cmux-aware formula
--      that includes claude.session.id (so two cmux instances running
--      the SAME session collapse, but distinct sessions don't).
--   3. Hard-deletes existing duplicates: keeps MIN(id) per
--      (user_id, dedup_key) — the rest were content-identical to the
--      kept row, so we lose nothing the dashboard could differentiate.
--   4. Adds a universal partial unique on dedup_key with no span_id
--      condition, so future ingest dedup catches EVERY duplicate
--      regardless of how the duplicate emitter set span_id.
--
-- Formula must match server/src/lib/otel-genai.ts makeDedupKey(). If
-- you change one, change both — otherwise existing dedup_keys won't
-- collide with newly-ingested ones and the cleanup will be undone by
-- the next stream of duplicate inserts.
--
-- Cost: a single ROW_NUMBER() OVER (PARTITION BY user_id, dedup_key)
-- pass over activity_event. For Pulse at single-digit-million rows
-- this is a few seconds. The DELETE is bounded by the cardinality of
-- the duplicates set (should drop dramatically in production).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Drop the old narrow index. CREATE … IF NOT EXISTS in 0015 means
--    DROP … IF EXISTS is the safe inverse for re-runs.
DROP INDEX IF EXISTS uq_activity_event_dedup_no_span;

-- 2. Recompute dedup_key for every row. Includes session_id so cmux
--    cross-instance dedup is correct without false-positive collapses
--    of distinct logical sessions that happen to share token counts.
--
--    The format string MUST match the JS formula exactly:
--      ts.toISOString().slice(0, 19) → "YYYY-MM-DDTHH:MM:SS"
--    Postgres equivalent: to_char(ts AT TIME ZONE 'UTC',
--                                 'YYYY-MM-DD"T"HH24:MI:SS').
--    Hash truncated to 32 hex chars to match the JS .slice(0, 32).
UPDATE activity_event
SET dedup_key = LEFT(encode(digest(
  user_id::text                                                    || '|' ||
  COALESCE(session_id, '')                                         || '|' ||
  to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')        || '|' ||
  COALESCE(model, '')                                              || '|' ||
  COALESCE(tokens_input::text,  '0')                               || '|' ||
  COALESCE(tokens_output::text, '0')                               || '|' ||
  COALESCE(repo_name, '')                                          || '|' ||
  source,
  'sha256'
), 'hex'), 32);

-- 3. Hard-delete duplicates. Keep MIN(id) so the chronologically-first
--    insert wins; aggregate dashboards then count each logical turn
--    exactly once. Wrapped in CTE so we evaluate ROW_NUMBER() before
--    the DELETE mutates the source set.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY user_id, dedup_key ORDER BY id) AS rn
  FROM activity_event
  WHERE dedup_key IS NOT NULL
)
DELETE FROM activity_event
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 4. Universal partial unique. Now applies to ALL rows with a
--    populated dedup_key — the only gap is rows where dedup_key
--    somehow lands NULL (shouldn't happen post-0015 ingest, but the
--    partial-unique form is defensive).
CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_event_dedup
  ON activity_event (user_id, dedup_key)
  WHERE dedup_key IS NOT NULL;
