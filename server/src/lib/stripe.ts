/**
 * stripe.ts — singleton Stripe client + webhook secret reader.
 *
 * Centralizes the API version so SDK type changes land in one place. The
 * client is lazily constructed so import-time code paths (tests, migrations)
 * don't crash when STRIPE_SECRET_KEY is unset.
 */

import Stripe from "stripe";

let _client: Stripe | null = null;

/** Stripe API version pinned across all callers — bump in one place. */
export const STRIPE_API_VERSION = "2026-04-22.dahlia" as const;

export function stripe(): Stripe {
  if (_client) return _client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  _client = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
  return _client;
}

export function stripeWebhookSecret(): string {
  const s = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s) throw new Error("STRIPE_WEBHOOK_SECRET not set");
  return s;
}

/** Test-only — reset the cached client so tests can swap STRIPE_SECRET_KEY. */
export function _resetStripeClientForTests(): void {
  _client = null;
}
