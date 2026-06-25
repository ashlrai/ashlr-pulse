-- 0026_fleet_owner.sql
--
-- Per-teammate fleet ownership. Surfaces whose goal/proposal each
-- ashlr-fleet event belongs to, enabling per-owner breakdowns in the
-- Fleet tab's team view and in peer-share-scoped dashboards.
--
-- The OTLP bridge emits spans with ashlr.fleet.owner = <teammate identifier>
-- (display name or email) as of M109. The ingest path maps this attribute
-- onto the new fleet_owner column.
--
-- Fleet-specific attribute stored here:
--
--   fleet_owner  TEXT  — teammate who owns the goal/proposal.
--                        Maps from ashlr.fleet.owner attribute.
--                        NULL for non-fleet sources and for fleet spans
--                        emitted before M109.
--
-- Existing columns already cover the related fleet fields (0025):
--   fleet_event    ← ashlr.fleet.event
--   fleet_outcome  ← ashlr.fleet.outcome
--
-- All columns nullable + idempotent ADDs (no DROP, no ENUM changes).
--
-- Privacy floor reaffirmed: fleet_owner is a display name / email
-- identifier — no prompt content, no code, no completions, no diffs.
-- Structured metadata only. Safe to include in peer-share grants.

ALTER TABLE activity_event
  ADD COLUMN IF NOT EXISTS fleet_owner TEXT;

COMMENT ON COLUMN activity_event.fleet_owner IS
  'Teammate who owns this fleet goal/proposal (display name or email from ashlr.fleet.owner). NULL for non-fleet sources.';

-- Partial index for efficient per-owner fleet queries (Fleet tab team
-- breakdown groups by fleet_owner WHERE source = ''ashlr-fleet'').
CREATE INDEX IF NOT EXISTS activity_event_fleet_owner_idx
  ON activity_event (user_id, fleet_owner, ts DESC)
  WHERE source = 'ashlr-fleet' AND fleet_owner IS NOT NULL;
