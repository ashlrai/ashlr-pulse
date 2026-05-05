-- 0015_accuracy_and_dedup.sql
--
-- Wave 1 of the accuracy + AI + viz upgrade. Three orthogonal changes
-- that all touch activity_event:
--
-- 1. tokens_reasoning   — Anthropic extended-thinking models emit
--                         gen_ai.usage.reasoning_tokens; we had no slot
--                         for them so cost was silently underestimated
--                         for any session that used Thinking. Priced
--                         at the model's output rate by default
--                         (server/src/lib/pricing.ts).
--
-- 2. cost cache          — pricing was being recomputed for every row
--                         on every dashboard render (~30k rows × 6
--                         token columns × rate-table lookup). Cache
--                         the answer at ingest in cost_millicents
--                         (millicents avoids rounding drift on
--                         cumulative aggregates). pricing_version
--                         records which rate-table revision produced
--                         the cached value so we can re-price old
--                         rows when rates change. NULL = uncached;
--                         read path falls back to computing on the
--                         fly. New rows always populate.
--
-- 3. dedup_key           — agent retries after a flaky network round
--                         trip already dedupe via (user_id, span_id)
--                         from migration 0007, but cmux instances
--                         emitting the same logical assistant turn
--                         AND the agent JSONL tailer plus an
--                         in-process exporter both firing produced
--                         duplicate rows visible in the activity feed.
--                         Add a content hash (truncated-second ts +
--                         model + tokens + repo + source) so retries
--                         and twin-emission collapse to one row when
--                         span_id is null. Index is PARTIAL so the
--                         common path (span_id present, dedup via
--                         migration 0007's index) is undisturbed.
--
-- Plus six columns for the ashlr-plugin integration (Wave 2). Schema
-- only — emission lives in the plugin repo. Dropped to NULL for any
-- span that doesn't carry the corresponding ashlr.plugin.* attribute
-- (graceful degradation; nothing breaks if the plugin isn't shipped
-- yet).
--
-- Idempotent: every column / index uses IF NOT EXISTS, so rerunning
-- on container boot per server/scripts/entrypoint.sh is safe.

-- 1. Cost accuracy
ALTER TABLE activity_event
  ADD COLUMN IF NOT EXISTS tokens_reasoning  INT,
  ADD COLUMN IF NOT EXISTS cost_millicents   BIGINT,
  ADD COLUMN IF NOT EXISTS pricing_version   INT,
  ADD COLUMN IF NOT EXISTS dedup_key         TEXT,
  -- 2. ashlr-plugin integration
  ADD COLUMN IF NOT EXISTS tokens_saved_breakdown JSONB,
  ADD COLUMN IF NOT EXISTS plugin_features   TEXT[],
  ADD COLUMN IF NOT EXISTS plugin_version    TEXT,
  ADD COLUMN IF NOT EXISTS plugin_genome_hit_rate REAL;

-- 3. Partial unique on dedup_key for rows without a span_id (the
-- common dedupe path uses span_id from 0007). Re-emitted spans with
-- the same logical content now collapse instead of creating a wall
-- of identical rows in the activity feed. We do NOT enforce this on
-- rows with span_id since legitimate near-duplicates may share
-- content but have distinct span_ids (e.g. an agent retrying a
-- request that the server already accepted but the response was lost).
CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_event_dedup_no_span
  ON activity_event (user_id, dedup_key)
  WHERE span_id IS NULL AND dedup_key IS NOT NULL;

-- Index for plugin-impact rollups.
CREATE INDEX IF NOT EXISTS idx_activity_event_plugin_version_ts
  ON activity_event (plugin_version, ts DESC)
  WHERE plugin_version IS NOT NULL;
