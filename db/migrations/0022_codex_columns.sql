-- 0022_codex_columns.sql
--
-- Codex CLI as a first-class source. Captures per-turn telemetry from the
-- rollout JSONL files at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
--
-- The activity_event.source enum gains 'codex' (the column is TEXT, not a
-- PostgreSQL ENUM, so this is a documentation change here and a code-side
-- update in server/src/lib/otel-genai.ts + dashboard-view-db.ts).
--
-- Codex exposes a few attributes that Claude Code does not, and we
-- surface them as nullable columns so they can be queried + filtered
-- without unpacking raw_otel_span:
--
--   codex_plan_type            'prolite' | 'pro' | 'plus' | 'team' | 'enterprise' | 'api' | NULL
--                              Reported by Codex in token_count events. Used to
--                              auto-default the per-source subscription toggle
--                              (see migration 0023).
--   codex_originator           'codex-tui' | 'codex-exec' | NULL
--                              Which Codex frontend produced the session.
--   codex_parent_thread_id     UUID-as-text or NULL
--                              Set when this session was spawned as a
--                              subagent by another Codex thread. Lets us
--                              roll up subagent cost into parent threads.
--   codex_cli_version          Semver string e.g. '0.129.0'.
--   codex_context_window       INT — model_context_window from token_count.
--   codex_rate_limit_primary_pct   INT — used_percent in 5-min window.
--   codex_rate_limit_secondary_pct INT — used_percent in 7-day window.
--   codex_sandbox_policy       'workspace' | 'danger-full-access' | …
--                              Codex sandboxing posture per turn.
--   codex_approval_policy      'never' | 'untrusted' | 'on-request' | …
--   codex_effort               'low' | 'medium' | 'high' | NULL
--                              Reasoning-effort dial set on the Codex turn.
--
-- All columns are nullable + idempotent ADDs.
--
-- Privacy floor reaffirmed: NONE of these columns carry prompts,
-- completions, code, file contents, or tool-call arguments. They are all
-- structured metadata.

ALTER TABLE activity_event
  ADD COLUMN IF NOT EXISTS codex_plan_type            TEXT,
  ADD COLUMN IF NOT EXISTS codex_originator           TEXT,
  ADD COLUMN IF NOT EXISTS codex_parent_thread_id     TEXT,
  ADD COLUMN IF NOT EXISTS codex_cli_version          TEXT,
  ADD COLUMN IF NOT EXISTS codex_context_window       INT,
  ADD COLUMN IF NOT EXISTS codex_rate_limit_primary_pct   INT,
  ADD COLUMN IF NOT EXISTS codex_rate_limit_secondary_pct INT,
  ADD COLUMN IF NOT EXISTS codex_sandbox_policy       TEXT,
  ADD COLUMN IF NOT EXISTS codex_approval_policy      TEXT,
  ADD COLUMN IF NOT EXISTS codex_effort               TEXT;

COMMENT ON COLUMN activity_event.codex_plan_type IS
  'Codex plan reported in rate_limits.plan_type: prolite|pro|plus|team|enterprise|api. Powers the per-source subscription default in 0023.';

COMMENT ON COLUMN activity_event.codex_parent_thread_id IS
  'Set when this Codex session was spawned as a subagent. References another activity_event.session_id in the same user.';

-- Helpful index for the per-source subscription auto-default lookup
-- (latest plan_type per user, scoped to codex events only).
CREATE INDEX IF NOT EXISTS activity_event_codex_plan_type_idx
  ON activity_event (user_id, ts DESC)
  WHERE source = 'codex' AND codex_plan_type IS NOT NULL;
