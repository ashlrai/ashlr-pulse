-- 0001_activity_event.sql
--
-- Core event table for Ashlr Pulse v0.1.
-- Schema shape copied verbatim from ARCHITECTURE.md so the doc and the SQL
-- stay in sync. Aligns with OpenTelemetry GenAI semantic conventions so we
-- can receive OTLP spans directly and map each GenAI span to one row.
--
-- Hard exclusion list (NEVER stored): prompts, completions, user code,
-- file contents, stdout/stderr. Enforced by column absence.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Identity (scaffolded now so later phases don't need a schema rebuild).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "user" (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL UNIQUE,
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS org (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS membership (
  user_id    UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  org_id     UUID NOT NULL REFERENCES org(id)    ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, org_id)
);

-- ---------------------------------------------------------------------------
-- Activity events — the central table.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS activity_event (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  ts                 TIMESTAMPTZ  NOT NULL,
  user_id            TEXT         NOT NULL,
  session_id         TEXT,

  -- where it came from
  source             TEXT         NOT NULL,    -- 'claude_code' | 'cursor' | 'copilot' | 'wakatime' | 'git' | 'shell'
  provider           TEXT,                     -- 'anthropic' | 'openai' | 'google' etc.
  model              TEXT,                     -- 'claude-opus-4-7' | 'gpt-4o' etc.

  -- when / how long
  duration_ms        INT,

  -- token accounting (nullable — not all sources supply)
  tokens_input       INT,
  tokens_output      INT,
  tokens_cache_read  INT,
  tokens_cache_write INT,

  -- tool-call shape (counts only, not contents)
  tool_calls_count   INT,
  tool_calls_types   TEXT[],                   -- ['bash', 'read', 'edit']

  -- acceptance (where applicable)
  accepted_count     INT,
  rejected_count     INT,

  -- context (hashed; never raw paths stored longer than necessary)
  project_hash       TEXT,                     -- sha256(cwd)
  repo_name          TEXT,                     -- 'AshlrAI/cotidie' if cwd is a git repo
  git_branch         TEXT,                     -- OK to store
  language           TEXT,                     -- 'typescript' | 'python' etc.

  -- cost (computed server-side from tokens × model price table at read time)
  cost_usd_cents     INT,

  raw_otel_span      JSONB                     -- optional, full OTel span for debugging
);

CREATE INDEX IF NOT EXISTS activity_event_user_ts_idx   ON activity_event (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS activity_event_repo_ts_idx   ON activity_event (repo_name, ts DESC);
CREATE INDEX IF NOT EXISTS activity_event_source_ts_idx ON activity_event (source, ts DESC);
