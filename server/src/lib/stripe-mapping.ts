/**
 * stripe-mapping.ts — pure translation helpers between Stripe types and
 * Pulse's billing schema.
 *
 * Extracted from the webhook route so the mapping logic is unit-testable
 * without spinning up Stripe + the DB. The route file glues these to the
 * I/O.
 */

import type Stripe from "stripe";
import type { SubscriptionStatus } from "./org-db";

/**
 * Map Stripe's broader subscription.status enum to Pulse's narrower
 * SubscriptionStatus. Decisions baked in here:
 *
 *   - `unpaid` → past_due — same gating; "past_due that's been past_due
 *     for a while" doesn't deserve a separate state in our schema
 *   - `incomplete_expired` → canceled — unrecoverable, same downstream
 *     behavior as canceled
 *   - `paused` → canceled — no entitlement during pause; users can resume
 *     via the Stripe portal which fires a fresh subscription.updated
 *   - unknown → incomplete — fail safe (no paid features) without
 *     erroring on a future Stripe enum addition
 */
export function mapSubscriptionStatus(s: Stripe.Subscription.Status): SubscriptionStatus {
  switch (s) {
    case "active":              return "active";
    case "trialing":            return "trialing";
    case "past_due":            return "past_due";
    case "unpaid":              return "past_due";
    case "canceled":            return "canceled";
    case "incomplete":          return "incomplete";
    case "incomplete_expired":  return "canceled";
    case "paused":              return "canceled";
    default:                    return "incomplete";
  }
}

/**
 * Read the current period end from a SubscriptionItem. In Stripe API
 * versions ≥ 2024 this lives on the item (was top-level on the
 * Subscription pre-2024). Returns null when missing rather than throwing
 * so a malformed event from the test fixtures doesn't 500 the webhook.
 */
export function itemPeriodEnd(item: Stripe.SubscriptionItem): Date | null {
  const ts = item.current_period_end ?? null;
  return ts ? new Date(ts * 1000) : null;
}

/** Extract the Stripe customer ID from a Subscription's `customer` field
 *  which is either a string id or an expanded Customer object. */
export function customerIdOf(sub: Stripe.Subscription): string {
  return typeof sub.customer === "string" ? sub.customer : sub.customer.id;
}

/** Same for Checkout.Session — its customer can also be expanded or null. */
export function customerIdOfSession(session: Stripe.Checkout.Session): string | null {
  if (!session.customer) return null;
  return typeof session.customer === "string" ? session.customer : session.customer.id;
}
