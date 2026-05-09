-- 0024_privacy_pat_scopes_stripe_idempotency.sql
--
-- Privacy/security hardening:
--   1. Stop retaining raw OTLP spans. The column remains for backwards
--      compatibility with old code paths/migrations, but all existing
--      values are cleared and new ingest no longer writes it.
--   2. Add explicit PAT scopes. Existing tokens receive the default agent
--      scopes: ingest + heartbeat. Invite creation requires a separately
--      minted invite:create scope.
--   3. Track processed Stripe webhook event IDs so future billing side
--      effects can be guarded by a durable idempotency key.

UPDATE activity_event
   SET raw_otel_span = NULL
 WHERE raw_otel_span IS NOT NULL;

ALTER TABLE personal_access_token
  ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT ARRAY['ingest','heartbeat']::text[];

UPDATE personal_access_token
   SET scopes = ARRAY['ingest','heartbeat']::text[]
 WHERE scopes IS NULL OR array_length(scopes, 1) IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'personal_access_token_scopes_known'
  ) THEN
    ALTER TABLE personal_access_token
      ADD CONSTRAINT personal_access_token_scopes_known
      CHECK (scopes <@ ARRAY['ingest','heartbeat','invite:create']::text[]);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS stripe_webhook_event (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
