/**
 * POST /api/stripe/portal — Stripe Billing Portal session.
 *
 * Returns a URL the user redirects to for managing payment method,
 * invoices, plan changes, and cancellation. Stripe owns the portal UI;
 * we only need to mint a session that lands the user back at /settings/billing.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser, isOrgAdmin } from "@/lib/org-db";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "billing not configured" }, { status: 503 });
  }
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const org = await primaryOrgForUser(me.id);
  if (!org || !org.stripe_customer_id) {
    return NextResponse.json({ error: "no Stripe customer for this org" }, { status: 404 });
  }
  if (!(await isOrgAdmin(org.id, me.id))) {
    return NextResponse.json({ error: "admin role required" }, { status: 403 });
  }

  const stripe = getStripe();
  if (!stripe) return NextResponse.json({ error: "stripe unavailable" }, { status: 503 });

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://pulse.ashlr.ai").replace(/\/$/, "");
  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    return_url: `${appUrl}/settings/billing`,
  });

  return NextResponse.json({ url: session.url });
}
