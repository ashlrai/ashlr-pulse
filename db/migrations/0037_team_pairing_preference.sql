-- 0037_team_pairing_preference.sql
--
-- Stores each user's preferred pairing hours so the /settings/team-sync
-- page can persist the drag-selected grid state and the velocity-zones
-- API can return it alongside zone recommendations.
--
-- Schema:
--   org_id       — the organisation the pairing preference belongs to.
--   user_id      — the user who set their preference.
--   preferred_hours — JSON array of "HH:00" strings, e.g. ["10:00","11:00","14:00"].
--   updated_at   — last write timestamp.
--
-- One row per (org_id, user_id). UPSERT on conflict replaces preferred_hours.
--
-- Privacy floor: only hour labels (no individual events) are stored.

CREATE TABLE IF NOT EXISTS team_pairing_preference (
  org_id          UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

  -- JSON array of preferred UTC hour strings, e.g. '["10:00","11:00","14:00"]'.
  preferred_hours TEXT[]      NOT NULL DEFAULT '{}',

  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (org_id, user_id)
);

-- Lookup by org to retrieve all member preferences in one query.
CREATE INDEX IF NOT EXISTS team_pairing_pref_org_idx
  ON team_pairing_preference (org_id);
