/**
 * POST /api/stripe/checkout — start a Stripe Checkout session.
 *
 * Body: { plan: "pro" | "team" }
 * Auth: signed-in user; only org admins can checkout.
 *
 * Mints a Stripe customer for the org if one doesn't exist yet, then
 * returns a Checkout URL the client redirects to. Quantity = current
 * member count (per-seat pricing). The webhook updates org.plan once
 * the subscription completes.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import {
  primaryOrgForUser, isOrgAdmin, setStripeCustomerId, countMembers,
} from "@/lib/org-db";
import { getStripe, getPrices, isStripeConfigured } from "@/lib/stripe";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "billing not configured" }, { status: 503 });
  }
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const org = await primaryOrgForUser(me.id);
  if (!org) return NextResponse.json({ error: "no org" }, { status: 404 });

  if (!(await isOrgAdmin(org.id, me.id))) {
    return NextResponse.json({ error: "admin role required" }, { status: 403 });
  }

  let plan: "pro" | "team" = "pro";
  try {
    const body = (await req.json()) as { plan?: string };
    if (body.plan === "team") plan = "team";
  } catch {
    // Empty body → default to pro.
  }

  const stripe = getStripe();
  if (!stripe) return NextResponse.json({ error: "stripe unavailable" }, { status: 503 });

  const prices = getPrices();
  const priceId = plan === "team" ? prices.team : prices.pro;
  if (!priceId) {
    return NextResponse.json(
      { error: `no Stripe price configured for ${plan}` },
      { status: 503 },
    );
  }

  // Mint customer on first checkout so we have a stable id for the webhook.
  let customerId = org.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: me.email,
      name: org.name,
      metadata: { org_id: org.id },
    });
    customerId = customer.id;
    await setStripeCustomerId(org.id, customerId);
  }

  const seats = Math.max(1, await countMembers(org.id));
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://pulse.ashlr.ai").replace(/\/$/, "");

  // 7-day trial on first Pro checkout — drives conversion without
  // requiring a payment commitment up front. Stripe Checkout handles
  // the card collection during trial.
  const subscriptionData: { metadata: Record<string, string>; trial_period_days?: number } = {
    metadata: { org_id: org.id, plan },
  };
  if (org.subscription_status == null) {
    subscriptionData.trial_period_days = 7;
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: seats }],
    success_url: `${appUrl}/settings/billing?ok=1`,
    cancel_url:  `${appUrl}/pricing?canceled=1`,
    allow_promotion_codes: true,
    automatic_tax: { enabled: false },
    subscription_data: subscriptionData,
    metadata: { org_id: org.id, plan },
  });

  log.info({ msg: "stripe checkout: session created", org_id: org.id, plan, seats });

  return NextResponse.json({ url: session.url });
}
