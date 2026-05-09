-- 0023_per_source_subscription.sql
--
-- Per-source subscription toggle. Distinct from billing_mode (added in
-- 0020) which is org-level + Anthropic-specific and only affects the
-- BANNER on the dashboard. This new column changes what actually appears
-- in headline cost totals.
--
-- Schema:
--   org.source_subscription_modes JSONB DEFAULT '{}'
--
-- Shape:
--   {
--     "claude_code": "subscription" | "api_priced",
--     "codex":       "subscription" | "api_priced",
--     "cursor":      "subscription" | "api_priced",
--     ...
--   }
--
-- Semantics:
--   A source flagged "subscription" has its cost_millicents EXCLUDED from
--   headline cost totals (today / yesterday / this-week stat cards, cost
--   trajectory, monthly forecast). The rate-card cost is still rendered
--   per-source in charts so the "what would this cost on API rates"
--   narrative is preserved — the distinction is between rate-card cost
--   (always shown per-source) and effective cost (subscription = $0).
--
-- Default:
--   {} = nothing flagged. The dashboard falls back to the legacy
--   billing_mode (org-wide) for backwards compatibility.
--   For Codex specifically, the OTLP ingest path auto-fills this map
--   to {"codex": "subscription"} on the first Codex span where
--   codex_plan_type ∈ ('prolite','pro','plus','team','enterprise') AND
--   the user hasn't set a codex preference yet — see
--   server/src/app/api/otlp/v1/traces/route.ts.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE org
  ADD COLUMN IF NOT EXISTS source_subscription_modes JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN org.source_subscription_modes IS
  'Per-source subscription mode. Keys are activity_event.source values; values are "subscription" or "api_priced". Subscription-flagged sources are excluded from headline cost totals but still rendered per-source in transparency charts.';

-- Add the optional monthly_budget_usd column here too — it's a small
-- enough surface that it doesn't need its own migration. Used by the
-- /forecast budget burn-down chart.
ALTER TABLE org
  ADD COLUMN IF NOT EXISTS monthly_budget_usd NUMERIC(10, 2);

COMMENT ON COLUMN org.monthly_budget_usd IS
  'User-defined monthly budget in dollars. Used by /forecast burn-down chart to project overage. NULL = no budget set.';
