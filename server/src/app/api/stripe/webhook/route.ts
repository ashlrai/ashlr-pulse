/**
 * POST /api/stripe/webhook — Stripe subscription lifecycle.
 *
 * Stripe sends signed events for every subscription change. We:
 *   1. Verify signature with STRIPE_WEBHOOK_SECRET (never trust the body).
 *   2. Look up org by stripe_customer_id.
 *   3. Update org plan / seats / status / period_end / trial_ends_at
 *      via setBillingState.
 *   4. Log the event in stripe_event_log for audit; idempotent on event.id.
 *
 * Privacy: Stripe payloads include customer email + last4 + name. We
 * persist the full payload in stripe_event_log because it's our audit
 * trail; the table is admin-only and never surfaced through the
 * dashboard. No PII leaks into normal logs (only event ids + types).
 */

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { getStripe } from "@/lib/stripe";
import {
  getOrgByStripeCustomer, setBillingState,
  type OrgPlan, type SubscriptionStatus,
} from "@/lib/org-db";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const stripe = getStripe();
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !whsec) {
    return NextResponse.json({ error: "billing not configured" }, { status: 503 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "missing signature" }, { status: 400 });
  }

  // Stripe needs the raw bytes to verify. NextResponse turns body into
  // utf-8 string by default which is fine here — Stripe's verifier
  // accepts either string or Buffer.
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, whsec);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn({ msg: "stripe webhook: signature verification failed", err: m });
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  // Idempotency: log first, mark processed at the end. Replays are no-ops.
  const db = sql();
  const [existing] = await db<{ event_id: string; processed: boolean }[]>`
    SELECT event_id, processed FROM stripe_event_log WHERE event_id = ${event.id}
  `;
  if (existing?.processed) {
    return NextResponse.json({ ok: true, replayed: true });
  }
  if (!existing) {
    await db`
      INSERT INTO stripe_event_log (event_id, event_type, payload)
      VALUES (${event.id}, ${event.type}, ${JSON.stringify(event)}::jsonb)
      ON CONFLICT (event_id) DO NOTHING
    `;
  }

  try {
    await processEvent(event);
    await db`
      UPDATE stripe_event_log
      SET processed = TRUE
      WHERE event_id = ${event.id}
    `;
    log.info({ msg: "stripe webhook: processed", event_id: event.id, event_type: event.type });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await db`
      UPDATE stripe_event_log
      SET error = ${m}
      WHERE event_id = ${event.id}
    `;
    log.error({ msg: "stripe webhook: handler threw", event_id: event.id, err: m });
    // 5xx so Stripe retries.
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

async function processEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.trial_will_end": {
      const sub = event.data.object as Stripe.Subscription;
      await applySubscription(sub);
      return;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await applyCanceled(sub);
      return;
    }
    case "invoice.payment_failed": {
      // Mark past_due so plan-gate downgrades immediately.
      const inv = event.data.object as Stripe.Invoice;
      const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
      if (!customerId) return;
      const org = await getOrgByStripeCustomer(customerId);
      if (!org || !org.stripe_subscription_id) return;
      await setBillingState(org.id, {
        plan: org.plan,
        plan_seats: org.plan_seats,
        stripe_subscription_id: org.stripe_subscription_id,
        subscription_status: "past_due",
        current_period_end: org.current_period_end ? new Date(org.current_period_end) : null,
        trial_ends_at: org.trial_ends_at ? new Date(org.trial_ends_at) : null,
      });
      return;
    }
    default:
      // Ignore unhandled event types — we explicitly opt in.
      return;
  }
}

async function applySubscription(sub: Stripe.Subscription): Promise<void> {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (!customerId) return;
  const org = await getOrgByStripeCustomer(customerId);
  if (!org) {
    log.warn({ msg: "stripe webhook: subscription with unknown customer", customer_id: customerId });
    return;
  }

  const plan: OrgPlan = inferPlanFromSubscription(sub);
  const item = sub.items?.data?.[0];
  const seats = item?.quantity ?? 1;
  const status = mapStripeStatus(sub.status);

  // current_period_end may live on the item in newer Stripe API versions.
  const itemAny = item as unknown as { current_period_end?: number } | undefined;
  const periodEndUnix = itemAny?.current_period_end;
  const periodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;

  const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;

  await setBillingState(org.id, {
    plan,
    plan_seats: seats,
    stripe_subscription_id: sub.id,
    subscription_status: status,
    current_period_end: periodEnd,
    trial_ends_at: trialEnd,
  });
}

async function applyCanceled(sub: Stripe.Subscription): Promise<void> {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (!customerId) return;
  const org = await getOrgByStripeCustomer(customerId);
  if (!org) return;
  await setBillingState(org.id, {
    plan: "free",
    plan_seats: 1,
    stripe_subscription_id: null,
    subscription_status: "canceled",
    current_period_end: null,
    trial_ends_at: null,
  });
}

/**
 * Stripe's Subscription.Status enum is wider than ours
 * (incomplete_expired, paused, unpaid). Collapse the rare states onto
 * the closest meaningful one for plan-gating purposes.
 */
function mapStripeStatus(s: Stripe.Subscription.Status): SubscriptionStatus {
  switch (s) {
    case "active":
    case "trialing":
    case "past_due":
    case "canceled":
    case "incomplete":
      return s;
    case "incomplete_expired":
      return "canceled";
    case "paused":
    case "unpaid":
      return "past_due";
    default:
      return "canceled";
  }
}

/**
 * Map a Stripe subscription's first line-item price.id → our plan tier.
 * Falls back to subscription metadata (set during checkout).
 */
function inferPlanFromSubscription(sub: Stripe.Subscription): OrgPlan {
  const meta = (sub.metadata?.plan ?? "").toLowerCase();
  if (meta === "team") return "team";
  if (meta === "pro")  return "pro";

  const priceId = sub.items?.data?.[0]?.price?.id;
  if (priceId && process.env.STRIPE_PRICE_ID_TEAM === priceId) return "team";
  if (priceId && process.env.STRIPE_PRICE_ID_PRO  === priceId) return "pro";
  return "pro";
}
