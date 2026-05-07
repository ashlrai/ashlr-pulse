-- 0021_backfill_cost_millicents.sql
--
-- One-time backfill: recompute cost_millicents for any row where it's
-- NULL using the same formula as server/src/lib/pricing.ts costMillicents().
--
-- Why we have NULL rows:
--   Migration 0015 added the cost_millicents column. Rows ingested before
--   that migration ran were never populated (the ingest path computes at
--   write time but the column didn't exist for old rows). The dashboard
--   falls back to live recompute via dashboard-data.ts:resolveMillicents,
--   which works but means every dashboard render does N model-rate lookups
--   that should have been cached at ingest. ~32% of 24h rows in prod are
--   in this state per a 2026-05-05 audit.
--
-- This migration is IDEMPOTENT: only updates rows where cost_millicents
-- IS NULL. Re-running is a no-op.
--
-- Rate table here is a hand-port of pricing.ts:PRICES. If you change
-- pricing.ts, change this file too — but only for new model entries that
-- appear in production data with NULL cost_millicents. Don't backfill
-- already-populated rows; they were costed at ingest time using the
-- rate-card in effect that day.

UPDATE activity_event SET cost_millicents = ROUND((
  -- Opus 4.5 / 4.6 / 4.7 — $5/$25, cache_read 0.50, cache_5m 6.25, cache_1h 10.
  CASE WHEN model IN ('claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5') THEN
    COALESCE(tokens_input, 0)        * 5
    + COALESCE(tokens_output, 0)     * 25
    + COALESCE(tokens_reasoning, 0)  * 25
    + COALESCE(tokens_cache_read, 0) * 0.5
    + (CASE WHEN tokens_cache_5m_write IS NOT NULL AND tokens_cache_5m_write > 0
            THEN tokens_cache_5m_write * 6.25 ELSE 0 END)
    + (CASE WHEN tokens_cache_1h_write IS NOT NULL AND tokens_cache_1h_write > 0
            THEN tokens_cache_1h_write * 10 ELSE 0 END)
    + (CASE WHEN (tokens_cache_5m_write IS NULL OR tokens_cache_5m_write = 0)
              AND (tokens_cache_1h_write IS NULL OR tokens_cache_1h_write = 0)
            THEN COALESCE(tokens_cache_write, 0) * 10 ELSE 0 END)

  -- Legacy Opus 4 / 4.1 — $15/$75 rates.
  WHEN model IN ('claude-opus-4', 'claude-opus-4-1') THEN
    COALESCE(tokens_input, 0)        * 15
    + COALESCE(tokens_output, 0)     * 75
    + COALESCE(tokens_reasoning, 0)  * 75
    + COALESCE(tokens_cache_read, 0) * 1.5
    + (CASE WHEN tokens_cache_5m_write IS NOT NULL AND tokens_cache_5m_write > 0
            THEN tokens_cache_5m_write * 18.75 ELSE 0 END)
    + (CASE WHEN tokens_cache_1h_write IS NOT NULL AND tokens_cache_1h_write > 0
            THEN tokens_cache_1h_write * 30 ELSE 0 END)
    + (CASE WHEN (tokens_cache_5m_write IS NULL OR tokens_cache_5m_write = 0)
              AND (tokens_cache_1h_write IS NULL OR tokens_cache_1h_write = 0)
            THEN COALESCE(tokens_cache_write, 0) * 30 ELSE 0 END)

  -- Sonnet 4.5 / 4.6 — $3/$15.
  WHEN model IN ('claude-sonnet-4-5', 'claude-sonnet-4-6') THEN
    COALESCE(tokens_input, 0)        * 3
    + COALESCE(tokens_output, 0)     * 15
    + COALESCE(tokens_reasoning, 0)  * 15
    + COALESCE(tokens_cache_read, 0) * 0.3
    + (CASE WHEN tokens_cache_5m_write IS NOT NULL AND tokens_cache_5m_write > 0
            THEN tokens_cache_5m_write * 3.75 ELSE 0 END)
    + (CASE WHEN tokens_cache_1h_write IS NOT NULL AND tokens_cache_1h_write > 0
            THEN tokens_cache_1h_write * 6 ELSE 0 END)
    + (CASE WHEN (tokens_cache_5m_write IS NULL OR tokens_cache_5m_write = 0)
              AND (tokens_cache_1h_write IS NULL OR tokens_cache_1h_write = 0)
            THEN COALESCE(tokens_cache_write, 0) * 6 ELSE 0 END)

  -- Haiku 4.5 — $1/$5.
  WHEN model = 'claude-haiku-4-5' THEN
    COALESCE(tokens_input, 0)        * 1
    + COALESCE(tokens_output, 0)     * 5
    + COALESCE(tokens_reasoning, 0)  * 5
    + COALESCE(tokens_cache_read, 0) * 0.1
    + (CASE WHEN tokens_cache_5m_write IS NOT NULL AND tokens_cache_5m_write > 0
            THEN tokens_cache_5m_write * 1.25 ELSE 0 END)
    + (CASE WHEN tokens_cache_1h_write IS NOT NULL AND tokens_cache_1h_write > 0
            THEN tokens_cache_1h_write * 2 ELSE 0 END)
    + (CASE WHEN (tokens_cache_5m_write IS NULL OR tokens_cache_5m_write = 0)
              AND (tokens_cache_1h_write IS NULL OR tokens_cache_1h_write = 0)
            THEN COALESCE(tokens_cache_write, 0) * 2 ELSE 0 END)

  -- Haiku 3.5 — $0.80 / $4.
  WHEN model = 'claude-haiku-3-5' THEN
    COALESCE(tokens_input, 0)        * 0.80
    + COALESCE(tokens_output, 0)     * 4
    + COALESCE(tokens_reasoning, 0)  * 4
    + COALESCE(tokens_cache_read, 0) * 0.08
    + (CASE WHEN tokens_cache_5m_write IS NOT NULL AND tokens_cache_5m_write > 0
            THEN tokens_cache_5m_write * 1 ELSE 0 END)
    + (CASE WHEN tokens_cache_1h_write IS NOT NULL AND tokens_cache_1h_write > 0
            THEN tokens_cache_1h_write * 1.6 ELSE 0 END)
    + (CASE WHEN (tokens_cache_5m_write IS NULL OR tokens_cache_5m_write = 0)
              AND (tokens_cache_1h_write IS NULL OR tokens_cache_1h_write = 0)
            THEN COALESCE(tokens_cache_write, 0) * 1.6 ELSE 0 END)

  -- Haiku 3 — $0.25 / $1.25.
  WHEN model = 'claude-haiku-3' THEN
    COALESCE(tokens_input, 0)        * 0.25
    + COALESCE(tokens_output, 0)     * 1.25
    + COALESCE(tokens_reasoning, 0)  * 1.25
    + COALESCE(tokens_cache_read, 0) * 0.03
    + (CASE WHEN tokens_cache_5m_write IS NOT NULL AND tokens_cache_5m_write > 0
            THEN tokens_cache_5m_write * 0.30 ELSE 0 END)
    + (CASE WHEN tokens_cache_1h_write IS NOT NULL AND tokens_cache_1h_write > 0
            THEN tokens_cache_1h_write * 0.50 ELSE 0 END)
    + (CASE WHEN (tokens_cache_5m_write IS NULL OR tokens_cache_5m_write = 0)
              AND (tokens_cache_1h_write IS NULL OR tokens_cache_1h_write = 0)
            THEN COALESCE(tokens_cache_write, 0) * 0.50 ELSE 0 END)

  -- Sonnet 4 / 3.7 / 3.5 — $3 / $15 (same sheet as Sonnet 4.5/4.6).
  WHEN model IN ('claude-sonnet-4', 'claude-sonnet-3-7', 'claude-sonnet-3-5') THEN
    COALESCE(tokens_input, 0)        * 3
    + COALESCE(tokens_output, 0)     * 15
    + COALESCE(tokens_reasoning, 0)  * 15
    + COALESCE(tokens_cache_read, 0) * 0.3
    + (CASE WHEN tokens_cache_5m_write IS NOT NULL AND tokens_cache_5m_write > 0
            THEN tokens_cache_5m_write * 3.75 ELSE 0 END)
    + (CASE WHEN tokens_cache_1h_write IS NOT NULL AND tokens_cache_1h_write > 0
            THEN tokens_cache_1h_write * 6 ELSE 0 END)
    + (CASE WHEN (tokens_cache_5m_write IS NULL OR tokens_cache_5m_write = 0)
              AND (tokens_cache_1h_write IS NULL OR tokens_cache_1h_write = 0)
            THEN COALESCE(tokens_cache_write, 0) * 6 ELSE 0 END)

  -- Opus 3 — $15 / $75 (deprecated, same as Opus 4 / 4.1).
  WHEN model = 'claude-opus-3' THEN
    COALESCE(tokens_input, 0)        * 15
    + COALESCE(tokens_output, 0)     * 75
    + COALESCE(tokens_reasoning, 0)  * 75
    + COALESCE(tokens_cache_read, 0) * 1.5
    + (CASE WHEN tokens_cache_5m_write IS NOT NULL AND tokens_cache_5m_write > 0
            THEN tokens_cache_5m_write * 18.75 ELSE 0 END)
    + (CASE WHEN tokens_cache_1h_write IS NOT NULL AND tokens_cache_1h_write > 0
            THEN tokens_cache_1h_write * 30 ELSE 0 END)
    + (CASE WHEN (tokens_cache_5m_write IS NULL OR tokens_cache_5m_write = 0)
              AND (tokens_cache_1h_write IS NULL OR tokens_cache_1h_write = 0)
            THEN COALESCE(tokens_cache_write, 0) * 30 ELSE 0 END)

  ELSE NULL  -- unknown model — leave NULL so resolveMillicents falls back at render
  END
) / 10)::bigint
WHERE cost_millicents IS NULL
  AND model IN (
    'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5',
    'claude-opus-4', 'claude-opus-4-1', 'claude-opus-3',
    'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4',
    'claude-sonnet-3-7', 'claude-sonnet-3-5',
    'claude-haiku-4-5', 'claude-haiku-3-5', 'claude-haiku-3'
  );
