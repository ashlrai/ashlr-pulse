/**
 * plan-gate.ts — feature entitlement utility.
 *
 * Every plan-gated code path calls one of these helpers. The plan field
 * on org is the source of truth (Stripe webhook updates it). We never
 * call Stripe synchronously in the request path.
 *
 * Free-tier limits codified here so changing them is a one-place edit:
 *   - max_members        = 1     (solo only; cofounder bumps you to Pro)
 *   - max_projects       = 1     (single project)
 *   - retention_days     = 7     (older spans return empty from queries)
 *   - peer_share_enabled = false (no granting)
 *   - ai_features        = false (no briefing, no standup, no anomaly LLM)
 *   - digest_enabled     = true  (daily summary still works for solo flow)
 *
 * Pro/Team unlock everything.
 */

export interface PlanLimits {
  max_members: number;
  max_projects: number;
  retention_days: number;
  peer_share_enabled: boolean;
  ai_features: boolean;
  digest_enabled: boolean;
}

export interface OrgPlanRef {
  plan: "free" | "pro" | "team";
  subscription_status: "active" | "trialing" | "past_due" | "canceled" | "incomplete" | null;
}

/**
 * How the org pays Anthropic, independent of their Pulse plan tier.
 *   - api          — pay-as-you-go API; rate-card cost = real bill.
 *   - pro/max-*    — Claude Code subscription; in-quota cache + reasonable
 *                    input/output usage is included in the flat plan price.
 *                    Rate-card cost shown in Pulse is hypothetical.
 *   - team         — Anthropic Team plan; usage-based per-seat.
 *   - unknown      — user hasn't said yet; treat as api but flag in UI.
 */
export type BillingMode = "api" | "pro" | "max-100" | "max-200" | "team" | "unknown";

/**
 * Approximate monthly cap (in dollars of rate-card-equivalent cost) for
 * Claude Code subscription tiers. Lets the dashboard render
 * "X% of monthly cap used" without pretending to know exact Anthropic-
 * internal token quotas.
 *
 * These values come from Anthropic's published "≈ N× Pro usage" claims
 * (Pro ≈ $20 of API usage, Max-100 ≈ 5× = $100, Max-200 ≈ 20× = $400 of
 * API equivalence). Used only as a denominator for percent-of-cap display;
 * the user can override in /settings if their experience differs.
 */
export const BILLING_MODE_MONTHLY_CAP_USD: Record<BillingMode, number | null> = {
  api: null,
  pro: 100,         // ~5× the $20 plan price (Anthropic claims "~$100 of API usage")
  "max-100": 500,
  "max-200": 2000,
  team: null,       // usage-based; no fixed cap
  unknown: null,
};

export function isSubscriptionMode(m: BillingMode | null | undefined): boolean {
  return m === "pro" || m === "max-100" || m === "max-200";
}

export const FREE_LIMITS: PlanLimits = {
  max_members: 1,
  max_projects: 1,
  retention_days: 7,
  peer_share_enabled: false,
  ai_features: false,
  digest_enabled: true,
};

export const PRO_LIMITS: PlanLimits = {
  max_members: Number.POSITIVE_INFINITY,
  max_projects: Number.POSITIVE_INFINITY,
  retention_days: 90,
  peer_share_enabled: true,
  ai_features: true,
  digest_enabled: true,
};

export const TEAM_LIMITS: PlanLimits = {
  ...PRO_LIMITS,
  retention_days: 365,
};

/**
 * Resolve the effective PlanLimits for an org. Past-due / canceled /
 * incomplete subscriptions revert to free — we don't ship paid features
 * for nonpayment. Trialing users get full Pro limits.
 */
export function limitsFor(org: OrgPlanRef): PlanLimits {
  const okStatuses = new Set(["active", "trialing", null]);
  const ok = okStatuses.has(org.subscription_status);
  if (!ok) return FREE_LIMITS;

  switch (org.plan) {
    case "team": return TEAM_LIMITS;
    case "pro":  return PRO_LIMITS;
    case "free":
    default:     return FREE_LIMITS;
  }
}

export class PlanGateError extends Error {
  status: 402 | 403;
  constructor(message: string, status: 402 | 403 = 402) {
    super(message);
    this.status = status;
    this.name = "PlanGateError";
  }
}

/**
 * Throw a 402 (Payment Required) if the org isn't on at least the
 * specified plan tier. Use at the top of API routes for paid features.
 */
export function requirePlan(org: OrgPlanRef, minimum: "pro" | "team"): void {
  const tier = org.plan;
  if (minimum === "pro" && tier === "free") {
    throw new PlanGateError("upgrade to Pro to use this feature", 402);
  }
  if (minimum === "team" && tier !== "team") {
    throw new PlanGateError("upgrade to Team to use this feature", 402);
  }
}

/** Cutoff timestamp older than which queries should ignore data. */
export function retentionCutoff(limits: PlanLimits, now: Date = new Date()): Date {
  if (!Number.isFinite(limits.retention_days)) return new Date(0);
  return new Date(now.getTime() - limits.retention_days * 24 * 3600_000);
}
