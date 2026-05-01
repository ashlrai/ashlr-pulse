/**
 * billing-config.ts — Stripe price ID ↔ plan mapping.
 *
 * Pulse sells two paid tiers (pro, team) on two intervals (monthly, annual).
 * Each combination has a distinct Stripe price ID, configured via env:
 *
 *   STRIPE_PRICE_PRO_MONTHLY    — e.g. price_1Pq…
 *   STRIPE_PRICE_PRO_ANNUAL
 *   STRIPE_PRICE_TEAM_MONTHLY
 *   STRIPE_PRICE_TEAM_ANNUAL
 *
 * Annual is optional — if a price env var is unset the corresponding option
 * disappears from the UI rather than 500ing.
 *
 * The price → plan reverse lookup is the load-bearing piece for the webhook:
 * when Stripe says "subscription has price X," we need to know whether X is
 * pro or team without round-tripping to the Stripe API.
 */

export type BillingPlan = "pro" | "team";
export type BillingInterval = "monthly" | "annual";

export interface PriceRef {
  plan: BillingPlan;
  interval: BillingInterval;
}

const ENV_KEYS: ReadonlyArray<{ key: string; ref: PriceRef }> = [
  { key: "STRIPE_PRICE_PRO_MONTHLY",  ref: { plan: "pro",  interval: "monthly" } },
  { key: "STRIPE_PRICE_PRO_ANNUAL",   ref: { plan: "pro",  interval: "annual"  } },
  { key: "STRIPE_PRICE_TEAM_MONTHLY", ref: { plan: "team", interval: "monthly" } },
  { key: "STRIPE_PRICE_TEAM_ANNUAL",  ref: { plan: "team", interval: "annual"  } },
] as const;

/** Returns the configured Stripe price ID for a given plan/interval. */
export function priceIdFor(ref: PriceRef): string | null {
  const entry = ENV_KEYS.find(e => e.ref.plan === ref.plan && e.ref.interval === ref.interval);
  if (!entry) return null;
  return process.env[entry.key] ?? null;
}

/**
 * Reverse lookup — given a Stripe price ID (from a subscription event), return
 * the corresponding plan tier. Returns null for unknown prices so the webhook
 * can log + skip rather than mis-classify.
 */
export function planFromPriceId(priceId: string): BillingPlan | null {
  for (const { key, ref } of ENV_KEYS) {
    if (process.env[key] === priceId) return ref.plan;
  }
  return null;
}

/** All configured (price-id-set) options — used to render the upgrade UI. */
export function configuredPrices(): Array<PriceRef & { priceId: string }> {
  const out: Array<PriceRef & { priceId: string }> = [];
  for (const { key, ref } of ENV_KEYS) {
    const priceId = process.env[key];
    if (priceId) out.push({ ...ref, priceId });
  }
  return out;
}
