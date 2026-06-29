-- 0038_digest_frequency.sql
--
-- Add digest_frequency to the org table so teams can choose between daily,
-- weekly, or both digest cadences. Defaults to 'daily' for full backward
-- compatibility — existing orgs see no change until they opt into weekly.
--
-- Values:
--   'daily'   — send every morning at 9am local (existing behaviour)
--   'weekly'  — send Monday morning at 9am local only
--   'both'    — send both daily AND weekly digests
--
-- The column lives on org (not user) because digest cadence is a team-level
-- setting: it controls which cron fires, and teams typically want a
-- consistent rhythm across members.

ALTER TABLE org
  ADD COLUMN IF NOT EXISTS digest_frequency TEXT NOT NULL DEFAULT 'daily'
    CHECK (digest_frequency IN ('daily', 'weekly', 'both'));

COMMENT ON COLUMN org.digest_frequency IS
  'Digest cadence: daily | weekly | both. Default daily (backward-compatible).';

-- Separate idempotency guard for the weekly cron so daily and weekly sends
-- don't clobber each other's "already sent this period" checks.
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS last_weekly_digest_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS user_weekly_digest_sent_idx
  ON "user" (last_weekly_digest_sent_at NULLS FIRST);
