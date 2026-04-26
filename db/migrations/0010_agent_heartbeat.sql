-- 0010_agent_heartbeat.sql
--
-- Per-PAT liveness ping. Without this the dashboard has no way to
-- distinguish "the agent is up but quiet" from "the agent crashed
-- four hours ago and Mason is making decisions on stale data."
--
-- Keyed on the PAT the agent uses to authenticate. A user with N
-- agents (laptop + work-mac + cmux-on-server) gets N rows here, each
-- with its own last_heartbeat_at — the dashboard aggregates to "most
-- recent across all my agents" with an optional drill-down.
--
-- pat_hash mirrors personal_access_token.hashed_token so we can JOIN
-- when we want the human-readable name. We DON'T FK because:
--   1. The PAT might be revoked while heartbeat history is still
--      useful for "when did this agent last check in?"
--   2. Avoiding the FK lets us upsert from the heartbeat path without
--      a prior PAT-row read.

CREATE TABLE IF NOT EXISTS agent_heartbeat (
  pat_hash         TEXT        PRIMARY KEY,
  user_id          UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  agent_label      TEXT,                                    -- "macbook-pro" / "cmux-prod" — optional, useful in the badge
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  agent_version    TEXT,                                    -- e.g. "0.3.0" — for "you're behind, upgrade" UX later
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_heartbeat_user_recent_idx
  ON agent_heartbeat (user_id, last_heartbeat_at DESC);
