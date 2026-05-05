-- 0018_dedup_content_only.sql
--
-- Production check after 0017 still showed 2-4× duplicates in the
-- activity feed (same ts, same tokens, same cost, same repo, but the
-- dedup_key cleanup didn't merge them). Diagnosis: cmux instances
-- each have their OWN session_id (Claude Code mints one per shell),
-- so adding session_id to the dedup formula in 0017 over-discriminated
-- — every duplicate had a different session_id and the unique index
-- couldn't fire.
--
-- The right invariant for cmux/twin-emission dedup is CONTENT, not
-- session. Two emissions of the same logical assistant turn share:
--   - timestamp truncated to a second
--   - model
--   - all token columns (input, output, reasoning, cache_read,
--     cache_5m_write, cache_1h_write, legacy cache_write)
--   - repo
--   - source
-- That's enough specificity to prevent false positives across
-- genuinely distinct sessions that happen to coincide on input/output
-- — distinct sessions will diverge on at least the cache pattern.
--
-- This migration:
--   1. Recomputes dedup_key with the new content-only formula
--      (session_id REMOVED, all token columns ADDED).
--   2. Re-runs the duplicate-collapse DELETE.
--
-- Formula must match server/src/lib/otel-genai.ts makeDedupKey().
-- Universal partial unique from 0017 (uq_activity_event_dedup) stays
-- as is — it covers the new dedup_key automatically.

UPDATE activity_event
SET dedup_key = LEFT(encode(digest(
  user_id::text                                                      || '|' ||
  to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')          || '|' ||
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
