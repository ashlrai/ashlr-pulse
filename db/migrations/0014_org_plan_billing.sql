-- 0014_org_plan_billing.sql
--
-- Adds billing / plan columns to the org table.
--
-- plan                — which tier the org is on. Updated by the Stripe
--                       webhook handler; never written in the request path.
-- plan_seats          — number of paid seats (unused for free). Stored so
--                       we can enforce per-seat pricing later without extra
--                       Stripe API calls.
-- stripe_customer_id  — Stripe customer object. Created lazily on first
--                       checkout attempt.
-- stripe_subscription_id — the active Stripe subscription. NULL for free.
-- subscription_status — mirrors Stripe's subscription.status field.
--                       We revert to free limits on 'past_due'/'canceled'/
--                       'incomplete' so users can't get paid features by
--                       ignoring failed payments.
-- current_period_end  — when the current billing period ends. Shown in the
--                       billing UI; not used for entitlement logic.
-- trial_ends_at       — when the trial ends (if applicable). NULL if not
--                       trialing. Shown in the billing UI.
--
-- All columns are nullable so existing orgs (pre-billing) migrate cleanly
-- with plan='free' (the DEFAULT).

ALTER TABLE org
  ADD COLUMN IF NOT EXISTS plan                   TEXT        NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'pro', 'team')),
  ADD COLUMN IF NOT EXISTS plan_seats             INT         NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT        UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT        UNIQUE,
  ADD COLUMN IF NOT EXISTS subscription_status    TEXT
    CHECK (subscription_status IN ('active','trialing','past_due','canceled','incomplete')),
  ADD COLUMN IF NOT EXISTS current_period_end     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_ends_at          TIMESTAMPTZ;

-- Index for webhook fast-path: look up org by Stripe customer ID.
CREATE INDEX IF NOT EXISTS idx_org_stripe_customer
  ON org (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
