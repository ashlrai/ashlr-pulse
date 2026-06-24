-- 0025_fleet_columns.sql
--
-- ashlr-fleet as a first-class source. Surfaces autonomous fleet activity
-- (ticks, proposals, merges, declines) from the ashlr-hub fleet control
-- plane inside Pulse alongside Claude Code / Codex telemetry.
--
-- The OTLP bridge emits spans with ashlr.source = "ashlr-fleet", which
-- the ingest path now allows through the ALLOWED_SOURCES gate (code
-- change in server/src/lib/otel-genai.ts).
--
-- Fleet-specific attributes stored here:
--
--   fleet_event    TEXT  — 'tick' | 'proposal' | 'merge' | 'decline'
--                          Maps from ashlr.fleet.event attribute.
--   fleet_outcome  TEXT  — 'pending' | 'applied' | 'rejected' | <tick-reason>
--                          Maps from ashlr.fleet.outcome attribute.
--
-- Existing columns already cover the remaining fleet fields:
--   repo_name      ← ashlr.fleet.repo
--   provider       ← gen_ai.system (engine: codex|claude|builtin|hermes)
--   model          ← gen_ai.system (engine label, or gen_ai.request.model)
--   cost_millicents ← derived from ashlr.fleet.cost_usd * 100000
--   tokens_input / tokens_output ← gen_ai.usage.*
--   dedup_key / span_id          ← existing (user_id, span_id) path
--
-- All columns nullable + idempotent ADDs (no DROP, no ENUM changes).
--
-- Privacy floor reaffirmed: NONE of these columns carry prompts,
-- completions, code, file contents, or diff payloads. Structured
-- metadata only.

ALTER TABLE activity_event
  ADD COLUMN IF NOT EXISTS fleet_event   TEXT,
  ADD COLUMN IF NOT EXISTS fleet_outcome TEXT;

COMMENT ON COLUMN activity_event.fleet_event IS
  'ashlr-fleet event type: tick | proposal | merge | decline. NULL for non-fleet sources.';

COMMENT ON COLUMN activity_event.fleet_outcome IS
  'ashlr-fleet outcome: pending | applied | rejected | <tick-reason>. NULL for non-fleet sources.';

-- Partial index for efficient fleet activity queries (the Fleet tab
-- aggregates WHERE source = ''ashlr-fleet'').
CREATE INDEX IF NOT EXISTS activity_event_fleet_source_idx
  ON activity_event (user_id, ts DESC)
  WHERE source = 'ashlr-fleet';

-- Partial index for fast proposal/merge filtering.
CREATE INDEX IF NOT EXISTS activity_event_fleet_event_idx
  ON activity_event (user_id, fleet_event, ts DESC)
  WHERE source = 'ashlr-fleet' AND fleet_event IS NOT NULL;
