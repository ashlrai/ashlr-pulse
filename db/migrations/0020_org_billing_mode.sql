-- 0020_org_billing_mode.sql
--
-- Adds a billing_mode column to org so the dashboard can distinguish
-- between API users (rate-card cost is real) and Claude Code subscription
-- users (in-quota usage is flat-rate; rate-card cost is hypothetical).
--
-- Why this matters:
--   The dashboard always shows API rate-card cost. For a Pro/Max/Team
--   user that number is what they'd pay if they were on API
--   pay-as-you-go — but their real bill is the flat plan price plus
--   anything over the cap. Showing $518/24h for an Opus-heavy day to a
--   user paying $200/mo Max is misleading.
--
-- Modes:
--   - api          (default; existing behavior — rate-card is the bill)
--   - pro          (Claude Code Pro $20/mo — caches included in plan)
--   - max-100      (Claude Code Max $100/mo)
--   - max-200      (Claude Code Max $200/mo)
--   - team         (org plan; usage-based per-seat)
--   - unknown      (user hasn't specified; treat as 'api' but show banner)
--
-- The dashboard renders both numbers in subscription mode:
--   "Rate-card: $518.06"  (what API users would pay)
--   "Plan: $200/mo Max — 12% of monthly cap used (estimated)"
--
-- Safe to re-run: idempotent.

ALTER TABLE org
  ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'api'
    CHECK (billing_mode IN ('api', 'pro', 'max-100', 'max-200', 'team', 'unknown'));

ALTER TABLE org
  ADD COLUMN IF NOT EXISTS billing_mode_set_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN org.billing_mode IS
  'How this org pays Anthropic: api (pay-as-you-go), pro/max-*/team (Claude Code subscription), or unknown. The dashboard shows API rate-card cost but adds a "your real bill is different" banner for non-api modes.';
