-- 0011_invite.sql
--
-- Cofounder / teammate invite-link flow. User A creates an invite,
-- shares the URL out-of-band (Slack, email, etc.). User B opens the
-- URL, signs in via GitHub (creates their own user row), and a
-- peer_share grant is auto-suggested from owner → invitee using the
-- defaults the inviter chose at create time.
--
-- This is the consent-correct way to onboard a second user — User A's
-- AI never touches User B's credentials. User B completes their own
-- sign-in in their own browser session.
--
-- Token shape: 16 chars from a 32-char Crockford-ish alphabet
-- (no 0/1/I/O — same as agent_onboard_code). 32^16 ≈ 1.2e24 → not
-- guessable; treated as a one-shot capability the holder presents.

CREATE TABLE IF NOT EXISTS invite (
  token                 TEXT        PRIMARY KEY,
  owner_id              UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  expires_at            TIMESTAMPTZ NOT NULL,

  -- Optional pre-fill: when the invitee accepts, auto-create a
  -- peer_share grant from owner → invitee using these defaults.
  -- All four are nullable; if any is null we skip auto-grant and let
  -- the inviter set it up manually after.
  suggested_scope_type  TEXT        CHECK (suggested_scope_type IN ('all','project','repo_pattern')),
  suggested_scope_value TEXT,
  suggested_granularity TEXT        CHECK (suggested_granularity IN ('realtime','daily','weekly','monthly')),
  suggested_fields      TEXT[],

  -- Optional human-readable label so the inviter can tell their invites
  -- apart in a list ("for kara cofounder", "for andrew client demo", etc.)
  label                 TEXT,

  -- Set when the invitee opens the accept-invite page AFTER signing in.
  accepted_by           UUID        REFERENCES "user"(id) ON DELETE SET NULL,
  accepted_at           TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Used by the accept page to look up the invite by its token.
CREATE INDEX IF NOT EXISTS invite_owner_idx ON invite (owner_id);
-- Used by a future cleanup job that purges expired un-accepted invites.
CREATE INDEX IF NOT EXISTS invite_expires_unaccepted_idx
  ON invite (expires_at)
  WHERE accepted_at IS NULL;
