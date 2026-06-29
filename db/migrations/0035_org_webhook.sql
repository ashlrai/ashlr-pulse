-- 0035_org_webhook.sql
--
-- Fleet Activity + Health Scorecard Webhook Sink configuration columns on org.
--
-- Allows orgs (Pro+) to register an external HTTPS endpoint (Slack, PagerDuty,
-- email relay, etc.) that receives a signed daily fleet scorecard POST when
-- configured events fire. The cron job /api/cron/fleet-scorecard-webhook
-- evaluates thresholds at 02:30 UTC and fires to webhook_url when any
-- subscribed event condition is met.
--
-- Columns:
--   webhook_url     — the HTTPS endpoint to POST to. NULL = disabled.
--   webhook_secret  — optional 32+ char random secret for HMAC-SHA256 signing.
--                     When set, the POST carries an `x-pulse-signature` header:
--                     "sha256=<hex(HMAC-SHA256(secret, body))>" so the receiver
--                     can verify authenticity. NULL = unsigned.
--   webhook_events  — array of event slugs that should trigger a fire.
--                     Default: the two primary alert conditions.
--                     Valid slugs: 'fleet_quality_alert', 'budget_exceeded',
--                     'stale_review', 'agent_down'.
--
-- Privacy floor: the webhook payload carries ONLY metadata (counts, costs,
-- enums, thresholds, gate statuses). Never prompts, code, completions, or
-- diff metadata.

ALTER TABLE org
  ADD COLUMN IF NOT EXISTS webhook_url     TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS webhook_secret  TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS webhook_events  TEXT[]      NOT NULL
    DEFAULT ARRAY['fleet_quality_alert', 'budget_exceeded']::text[];
