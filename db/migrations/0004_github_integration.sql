-- 0004_github_integration.sql
--
-- GitHub data plane. Stores per-user GitHub identity + access token,
-- the set of repos the user has chosen to track, and a normalized event
-- stream for commits / PRs / reviews / issues that flows into the same
-- activity_event table the dashboard already renders.
--
-- Privacy: GitHub access tokens are stored encrypted-at-rest in Postgres
-- via pgcrypto. The encryption key (PULSE_TOKEN_ENC_KEY env, 32 bytes
-- hex) is loaded into the server process; tokens are decrypted on demand
-- and never logged. Revoked GitHub access → token validation fails on
-- next sync → row marked stale, surfaced to user as "reconnect".
--
-- Note: pgcrypto extension was already enabled in 0001 (gen_random_uuid).

-- ---------------------------------------------------------------------------
-- github_account: one row per user × github identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS github_account (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

  github_user_id      BIGINT NOT NULL,            -- GitHub's stable numeric id
  github_login        TEXT   NOT NULL,
  avatar_url          TEXT,
  scopes              TEXT[] NOT NULL,            -- e.g. {'repo','read:user','read:org'}

  -- Token storage. We accept a `bytea` ciphertext; the server encrypts
  -- with pgp_sym_encrypt(key, PULSE_TOKEN_ENC_KEY) at insert time.
  access_token_enc    BYTEA NOT NULL,
  -- GitHub OAuth tokens currently have no expiry, but record refresh
  -- if/when GitHub starts issuing them so we don't have to re-migrate.
  refresh_token_enc   BYTEA,
  token_expires_at    TIMESTAMPTZ,

  -- Sync bookkeeping.
  last_synced_at      TIMESTAMPTZ,
  sync_error          TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, github_user_id)
);

CREATE INDEX IF NOT EXISTS github_account_user_idx ON github_account (user_id);
CREATE INDEX IF NOT EXISTS github_account_login_idx ON github_account (github_login);

-- ---------------------------------------------------------------------------
-- github_repo: repos the user has opted into syncing
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS github_repo (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES github_account(id) ON DELETE CASCADE,

  github_repo_id      BIGINT NOT NULL,            -- GitHub's stable numeric id
  full_name           TEXT NOT NULL,              -- "owner/repo"
  default_branch      TEXT,
  is_private          BOOLEAN,
  is_fork             BOOLEAN,

  -- Watermarks per data source: ISO timestamp of the last event we
  -- pulled. Cursor pagination uses these to avoid re-fetching everything.
  commits_synced_until TIMESTAMPTZ,
  prs_synced_until     TIMESTAMPTZ,
  issues_synced_until  TIMESTAMPTZ,

  -- Optional binding to a project_repo row so dashboards can group.
  -- Soft FK by repo_name only — project_repo doesn't have a UUID PK.
  -- (project_repo (project_id, repo_name) PK is composite.)

  enabled             BOOLEAN NOT NULL DEFAULT TRUE,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (account_id, github_repo_id)
);

CREATE INDEX IF NOT EXISTS github_repo_account_idx ON github_repo (account_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS github_repo_full_name_idx ON github_repo (full_name);

-- ---------------------------------------------------------------------------
-- github_event: lightweight event ledger.
-- ---------------------------------------------------------------------------
-- We DON'T fold GitHub events into activity_event because the existing
-- shape is GenAI-token-centric and adding nullable PR/issue columns
-- there would muddy the schema. Instead, github_event is its own table,
-- and the dashboard query layer UNIONs them at read time.
--
-- Kinds: 'commit' | 'pr_opened' | 'pr_merged' | 'pr_closed' |
--        'pr_review' | 'pr_review_comment' | 'issue_opened' | 'issue_closed'

CREATE TABLE IF NOT EXISTS github_event (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES github_account(id) ON DELETE CASCADE,
  repo_id           UUID NOT NULL REFERENCES github_repo(id) ON DELETE CASCADE,

  kind              TEXT NOT NULL,
  ts                TIMESTAMPTZ NOT NULL,         -- event time (commit ts, pr created/merged, etc.)

  -- The actor (commit author, PR author, reviewer, etc.). For self vs
  -- cofounder vs agent we just record the github login; the dashboard
  -- pivots on this.
  actor_login       TEXT NOT NULL,

  -- Stable id per kind: commit SHA, PR number, review id.
  external_id       TEXT NOT NULL,

  -- Lightweight metadata; no diff bodies, no PR descriptions, no review
  -- comment text. Privacy floor extends here — we capture *that* an
  -- event happened, not its prose. Counts (additions/deletions/files)
  -- and small enums (state, draft) are fine.
  branch            TEXT,
  pr_number         INT,
  pr_state          TEXT,
  pr_is_draft       BOOLEAN,
  additions         INT,
  deletions         INT,
  changed_files     INT,
  message_first_line TEXT,                        -- commit subject; never the body

  raw               JSONB,                        -- redacted blob for debugging

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (repo_id, kind, external_id)
);

CREATE INDEX IF NOT EXISTS github_event_account_ts_idx ON github_event (account_id, ts DESC);
CREATE INDEX IF NOT EXISTS github_event_repo_ts_idx    ON github_event (repo_id, ts DESC);
CREATE INDEX IF NOT EXISTS github_event_actor_ts_idx   ON github_event (actor_login, ts DESC);
CREATE INDEX IF NOT EXISTS github_event_kind_ts_idx    ON github_event (kind, ts DESC);
