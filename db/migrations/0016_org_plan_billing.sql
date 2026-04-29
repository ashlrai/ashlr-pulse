-- 0016_org_plan_billing.sql
--
-- Add billing state to org. Pulse is going multi-tenant with seat-based
-- pricing ($10/dev/mo Pro tier, free tier capped at 1 user / 1 project /
-- 7d retention). Billing is per-org, not per-user — every user belongs
-- to at least one org via the existing membership table.
--
-- Plan field is the source of truth for feature gates. Stripe webhook
-- updates it on subscription lifecycle events; we never use the Stripe
-- API as a synchronous read in the request path.
--
-- Columns are nullable for backwards compatibility with orgs created
-- before this migration. NULL stripe_customer_id means "free tier, no
-- Stripe customer minted yet"; the billing flow lazily creates one on
-- first checkout.

ALTER TABLE org
  ADD COLUMN IF NOT EXISTS plan                 TEXT        NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'pro', 'team')),
  ADD COLUMN IF NOT EXISTS plan_seats           INTEGER     NOT NULL DEFAULT 1
    CHECK (plan_seats >= 0),
  ADD COLUMN IF NOT EXISTS stripe_customer_id   TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  -- Subscription lifecycle: 'active' | 'trialing' | 'past_due' |
  -- 'canceled' | 'incomplete' | NULL (no subscription).
  ADD COLUMN IF NOT EXISTS subscription_status  TEXT,
  -- When the current paid period ends (UTC). NULL when on free tier.
  ADD COLUMN IF NOT EXISTS current_period_end   TIMESTAMPTZ,
  -- When the trial ends, if any.
  ADD COLUMN IF NOT EXISTS trial_ends_at        TIMESTAMPTZ;

-- Webhook lookups by stripe customer id.
CREATE UNIQUE INDEX IF NOT EXISTS org_stripe_customer_idx
  ON org (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS org_stripe_subscription_idx
  ON org (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

-- Audit: every webhook event we process gets a row. Idempotency key is
-- the event.id so we can safely replay (Stripe explicitly retries).
CREATE TABLE IF NOT EXISTS stripe_event_log (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  org_id      UUID REFERENCES org(id) ON DELETE SET NULL,
  payload     JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed   BOOLEAN NOT NULL DEFAULT FALSE,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS stripe_event_log_org_idx
  ON stripe_event_log (org_id, received_at DESC);
