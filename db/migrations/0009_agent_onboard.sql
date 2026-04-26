-- 0009_agent_onboard.sql
--
-- Browser-mediated agent onboarding. Replaces the awkward
-- `bun run mint-pat.ts <user_uuid> <name>` flow that required ssh access
-- to the server. New flow:
--
--   1. `pulse-agent init --url https://pulse.ashlr.ai` generates an
--      8-char code, POSTs it to /api/agent-onboard/start, prints a URL.
--   2. User visits URL in browser, signs in if needed, clicks "Approve".
--      /api/agent-onboard/approve flips the row's status to 'approved'
--      and records the user_id.
--   3. Agent polls /api/agent-onboard/poll every 2s. On 'approved', the
--      poll endpoint mints a fresh PAT for the user and returns it,
--      then deletes the row. The token is NEVER persisted on disk —
--      it only lives in the HTTP response.
--
-- Codes expire after 5 minutes. The cron sweep in lib/cron.ts will
-- prune expired rows opportunistically; a small partial index makes
-- "what's expired" cheap.

CREATE TABLE IF NOT EXISTS agent_onboard_code (
  code         TEXT        PRIMARY KEY,    -- 8 chars from a 26-char Crockford-ish alphabet
  expires_at   TIMESTAMPTZ NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved')),
  -- Set when status = 'approved'. ON DELETE CASCADE so revoking a user
  -- nukes any in-flight onboarding.
  user_id      UUID        REFERENCES "user"(id) ON DELETE CASCADE,
  -- Free-text label the agent supplies — e.g. "macbook-pro" — so the
  -- PAT name is meaningful in the user's PAT list.
  agent_label  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A user_id MUST be set when status moves to approved.
  CHECK (status = 'pending' OR user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS agent_onboard_code_expires_idx
  ON agent_onboard_code (expires_at)
  WHERE status = 'pending';
