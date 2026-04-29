/**
 * stripe.ts — server-only Stripe client + helpers.
 *
 * Env vars (set on Railway, never logged):
 *   STRIPE_SECRET_KEY         — sk_live_… or sk_test_…
 *   STRIPE_WEBHOOK_SECRET     — whsec_… (for signature verify)
 *   STRIPE_PRICE_ID_PRO       — price_… (per-seat pricing for Pro)
 *   STRIPE_PRICE_ID_TEAM      — price_… (per-seat pricing for Team, optional)
 *   STRIPE_PORTAL_RETURN_URL  — where the customer goes after the portal
 *
 * The client is lazily constructed so dev environments without Stripe
 * configured don't crash on import. Code that needs Stripe should call
 * `getStripe()` and handle the null case (typically by returning a
 * "billing not configured" error to the user).
 */

import Stripe from "stripe";

let _client: Stripe | null = null;

export function getStripe(): Stripe | null {
  if (_client) return _client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  // Don't pin apiVersion — let the SDK use its default for the
  // installed major. Pinning surfaces a TS error every time the SDK
  // bumps its supported list, and we have no business overriding it.
  _client = new Stripe(key, { typescript: true });
  return _client;
}

export interface PriceConfig {
  pro:  string | null;
  team: string | null;
}

export function getPrices(): PriceConfig {
  return {
    pro:  process.env.STRIPE_PRICE_ID_PRO ?? null,
    team: process.env.STRIPE_PRICE_ID_TEAM ?? null,
  };
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID_PRO);
}
