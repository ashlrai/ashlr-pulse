-- 0006_user_digest_prefs.sql
--
-- Daily digest preferences. Adds opt-out columns to the user table so the
-- cron in /api/cron/digest can render and send a personalized email each
-- morning. Defaults: opt-in (digest_enabled = TRUE), UTC, no override
-- email (we use the user's auth email).
--
-- digest_tz is an IANA zone (e.g. 'America/Los_Angeles'). The cron ticks
-- every 15 min and converts NOW() to each user's local time to decide
-- whether to fire — see lib/digest.ts.

ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS digest_enabled        BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS digest_tz             TEXT        NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS digest_email          TEXT,
  ADD COLUMN IF NOT EXISTS last_digest_sent_at   TIMESTAMPTZ;

-- Used by the cron sweep: "users who opted in and haven't been sent
-- one in the last 12 hours." Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS user_digest_due_idx
  ON "user" (last_digest_sent_at NULLS FIRST)
  WHERE digest_enabled;
