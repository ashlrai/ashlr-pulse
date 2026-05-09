/**
 * POST /api/stripe/webhook — Stripe → Pulse billing state sync.
 *
 * The single writer of org.plan / org.subscription_status / period dates.
 * Request-path code never calls Stripe API to determine entitlement; this
 * route is the source of truth.
 *
 * Security:
 *   - Verifies the Stripe signature on every request via constructEvent.
 *     A bad/missing signature → 400 (Stripe retries are signed too, so a
 *     400 here means an attacker spoofed the URL).
 *   - The body is read with req.text() — Stripe's signature is HMAC of the
 *     exact bytes; req.json() would normalize and break verification.
 *
 * Idempotency:
 *   - We record Stripe event.id before side effects. Duplicate deliveries
 *     return 200 without replaying writes.
 *   - State updates still write full rows so out-of-order distinct events
 *     converge from their own payloads.
 *
 * Events handled:
 *   - customer.subscription.created/updated  → setBillingState (plan, status, dates)
 *   - customer.subscription.deleted          → setBillingState plan=free
 *   - checkout.session.completed             → linkStripeCustomer (defensive,
 *     in case the org wasn't already linked when checkout was created)
 *
 * Other events return 200 immediately so Stripe stops retrying. We log
 * unknown event types but never 500 on them.
 */

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import type Stripe from "stripe";
import { stripe, stripeWebhookSecret } from "@/lib/stripe";
import { planFromPriceId } from "@/lib/billing-config";
import {
  setBillingState,
  linkStripeCustomer,
  getOrgByStripeCustomerId,
  markStripeWebhookEvent,
  unmarkStripeWebhookEvent,
} from "@/lib/org-db";
import {
  mapSubscriptionStatus,
  itemPeriodEnd,
  customerIdOf,
  customerIdOfSession,
} from "@/lib/stripe-mapping";
import { log } from "@/lib/logger";

/**
 * After plan flips we tell Next to drop server-render caches for the
 * pages that bind on plan limits. Server components re-fetch on next
 * request so a downgrade doesn't briefly grant paid features.
 */
function revalidatePlanGatedPages(): void {
  for (const path of ["/billing", "/app", "/share", "/settings"]) {
    try {
      revalidatePath(path);
    } catch (err) {
      log.warn(
        { msg: "stripe webhook: revalidatePath failed", path, err: err instanceof Error ? err.message : String(err) },
      );
    }
  }
}

export const runtime = "nodejs";
// The Stripe signature is HMAC of the raw body — Next must not transform it.
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "missing stripe-signature" }, { status: 400 });
  }

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, sig, stripeWebhookSecret());
  } catch (err) {
    // Constant-message log: do NOT log the body (could echo crafted payloads
    // into our logging pipeline) or the secret. Stripe sends signed retries,
    // so a real failure here means signature mismatch.
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "stripe webhook: signature verify failed");
    return NextResponse.json({ error: "signature verify failed" }, { status: 400 });
  }

  let eventMarked = false;
  try {
    eventMarked = await markStripeWebhookEvent(event.id, event.type);
    if (!eventMarked) {
      log.info({ event_id: event.id, event_type: event.type }, "stripe webhook: duplicate ignored");
      return NextResponse.json({ received: true, duplicate: true });
    }
    await handleEvent(event);
  } catch (err) {
    if (eventMarked) {
      await unmarkStripeWebhookEvent(event.id).catch(() => {});
    }
    // 500 → Stripe will retry with backoff. Log enough to debug but never
    // log secret-bearing fields from the event payload.
    log.error(
      { event_id: event.id, event_type: event.type, err: err instanceof Error ? err.message : String(err) },
      "stripe webhook: handler error",
    );
    return NextResponse.json({ error: "handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function handleEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await handleSubscription(event.data.object as Stripe.Subscription, event.type);
      return;
    case "checkout.session.completed":
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      return;
    default:
      // Unhandled event type — log + 200. Stripe sends 100+ event types and
      // we only care about subscription lifecycle.
      log.debug({ event_type: event.type, event_id: event.id }, "stripe webhook: unhandled event");
      return;
  }
}

async function handleSubscription(
  sub: Stripe.Subscription,
  eventType: string,
): Promise<void> {
  const customerId = customerIdOf(sub);
  const org = await getOrgByStripeCustomerId(customerId);
  if (!org) {
    // Customer exists in Stripe but no Pulse org is linked. Could happen if
    // checkout.session.completed hasn't landed yet, or if a user got created
    // in Stripe outside our checkout flow. Log + skip (Stripe will retry).
    log.warn({ customer_id: customerId, event_type: eventType }, "stripe webhook: no org linked to customer");
    return;
  }

  if (eventType === "customer.subscription.deleted") {
    // Subscription removed entirely — revert to free immediately.
    await setBillingState(org.id, {
      plan: "free",
      plan_seats: 1,
      stripe_subscription_id: null,
      subscription_status: "canceled",
      current_period_end: null,
      trial_ends_at: null,
    });
    revalidatePlanGatedPages();
    return;
  }

  // Map first non-deleted item's price to a plan tier. Pulse subscriptions
  // are single-line — if Stripe sends multiple items we use the first.
  const item = sub.items.data[0];
  if (!item || !item.price) {
    log.warn({ subscription_id: sub.id }, "stripe webhook: subscription has no price");
    return;
  }
  const planTier = planFromPriceId(item.price.id);
  if (!planTier) {
    // Price exists in Stripe but no env var maps to it. Could mean: the env
    // wasn't updated after a price-ID rotation. Don't downgrade the user
    // silently — log loudly and leave the existing plan in place.
    log.error(
      { price_id: item.price.id, subscription_id: sub.id, current_plan: org.plan },
      "stripe webhook: unknown price id — leaving plan unchanged",
    );
    return;
  }

  await setBillingState(org.id, {
    plan: planTier,
    plan_seats: item.quantity ?? 1,
    stripe_subscription_id: sub.id,
    subscription_status: mapSubscriptionStatus(sub.status),
    current_period_end: itemPeriodEnd(item),
    trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
  });
  revalidatePlanGatedPages();
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  // Defensive backstop — checkout/route.ts already linked the customer at
  // session-creation time. If that path was bypassed (e.g., admin creates
  // a session manually), this catches the customer ↔ org link via metadata.
  const orgId = session.metadata?.org_id;
  const customerId = customerIdOfSession(session);
  if (orgId && customerId) {
    await linkStripeCustomer(orgId, customerId);
  }
}
