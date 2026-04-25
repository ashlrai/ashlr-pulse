-- 0003_pat_and_tokens_saved.sql
--
-- 1. personal_access_token — PATs the Rust agent and the ashlr-plugin
--    use to ingest OTLP. Hashed at rest (SHA-256). Scoped to one user;
--    grants no read access, only ingest. Revocation is a soft delete via
--    revoked_at so we keep the audit trail.
--
-- 2. activity_event.tokens_saved — captured by the ashlr-plugin emitter
--    (Step 5 of the plan). Nullable: only the plugin source populates it.

CREATE TABLE IF NOT EXISTS personal_access_token (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  hashed_token  TEXT NOT NULL UNIQUE,                 -- SHA-256(token)
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pat_user_active_idx
  ON personal_access_token (user_id) WHERE revoked_at IS NULL;

ALTER TABLE activity_event
  ADD COLUMN IF NOT EXISTS tokens_saved INT;
