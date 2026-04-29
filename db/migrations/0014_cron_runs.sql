-- 0014_cron_runs.sql
--
-- Per-tick telemetry for the in-process scheduler at server/src/lib/cron.ts.
-- Without this row, "is the digest cron actually firing in production?" is
-- unanswerable except by reading Railway logs after the fact — and a
-- silently-stuck cron means no digest emails go out and no one notices
-- until a cofounder asks "did you get yesterday's roundup?"
--
-- Each row is a single completed (or failed) tick. We keep the schema
-- narrow on purpose:
--   - endpoint: which job ran (digest / github-sync / ...)
--   - status: HTTP status returned by the internal POST, or 0 on fetch
--     error (network/timeout before the route was reached)
--   - elapsed_ms: round-trip including auth + work
--   - error: short message when the tick threw; null on success
--
-- This is a write-only firehose for the scheduler — no FKs, no
-- cascades. The dashboard reads the most recent row per endpoint via
-- a covering index. Old rows can be pruned later with a tiny cron
-- (DELETE WHERE created_at < NOW() - INTERVAL '14 days') once volume
-- becomes a concern.

CREATE TABLE IF NOT EXISTS cron_runs (
  id          BIGSERIAL    PRIMARY KEY,
  endpoint    TEXT         NOT NULL,
  status      INTEGER      NOT NULL,
  elapsed_ms  INTEGER      NOT NULL,
  error       TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Covering index for "most recent run per endpoint" — the only read
-- pattern the dashboard footer uses.
CREATE INDEX IF NOT EXISTS cron_runs_endpoint_recent_idx
  ON cron_runs (endpoint, created_at DESC);
