/**
 * POST /api/billing/checkout — start a Stripe Checkout session for upgrade.
 *
 * Auth: Supabase session + org admin/owner role (billing changes are not
 * delegated to non-admins).
 *
 * Body:
 *   { plan: 'pro' | 'team', interval: 'monthly' | 'annual' }
 *
 * Returns: { url } — the hosted Stripe Checkout URL to redirect the user to.
 *
 * Side effects:
 *   - Lazily creates a Stripe Customer for the org if one doesn't exist yet,
 *     storing the customer_id on org so the webhook can find us.
 *   - Stamps subscription_data.metadata.org_id and session.metadata.org_id
 *     so the webhook + checkout.session.completed both have the back-ref.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser, isOrgAdmin, linkStripeCustomer } from "@/lib/org-db";
import { stripe } from "@/lib/stripe";
import { priceIdFor } from "@/lib/billing-config";

export const runtime = "nodejs";

const Body = z.object({
  plan: z.enum(["pro", "team"]),
  interval: z.enum(["monthly", "annual"]),
});

export async function POST(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let parsed;
  try {
    parsed = Body.parse(await req.json().catch(() => ({})));
  } catch (err) {
    return NextResponse.json(
      { error: "invalid body", detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  const org = await primaryOrgForUser(me.id);
  if (!org) return NextResponse.json({ error: "no org" }, { status: 404 });

  if (!(await isOrgAdmin(org.id, me.id))) {
    return NextResponse.json({ error: "admin required for billing actions" }, { status: 403 });
  }

  const priceId = priceIdFor({ plan: parsed.plan, interval: parsed.interval });
  if (!priceId) {
    return NextResponse.json(
      { error: `${parsed.plan}/${parsed.interval} not configured` },
      { status: 400 },
    );
  }

  const s = stripe();

  // Reuse existing Stripe customer or create one. Email + metadata are stored
  // on the customer so support can find an org from the Stripe dashboard.
  let customerId = org.stripe_customer_id;
  if (!customerId) {
    const customer = await s.customers.create({
      email: me.email,
      name: org.name,
      metadata: { org_id: org.id, pulse_user_id: me.id },
    });
    customerId = customer.id;
    await linkStripeCustomer(org.id, customerId);
  }

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;

  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/billing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/billing?canceled=1`,
    allow_promotion_codes: true,
    // Stamp org_id on both the session and the resulting subscription so
    // either webhook (checkout.session.completed OR customer.subscription.*)
    // can find the org without a customer-id reverse lookup.
    metadata: { org_id: org.id },
    subscription_data: {
      metadata: { org_id: org.id },
    },
  });

  if (!session.url) {
    return NextResponse.json({ error: "stripe returned no checkout url" }, { status: 502 });
  }

  return NextResponse.json({ url: session.url });
}
