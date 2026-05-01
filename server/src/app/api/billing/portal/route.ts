/**
 * POST /api/billing/portal — open the Stripe Customer Portal.
 *
 * Auth: Supabase session + org admin/owner role.
 *
 * Returns: { url } — hosted Stripe portal URL where the user can update
 * payment method, switch plans, view invoices, or cancel.
 *
 * The org must already have a stripe_customer_id (set by the first
 * checkout). If not, returns 409 — front-end should hide the "Manage
 * subscription" button on free orgs and show "Upgrade" instead.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser, isOrgAdmin } from "@/lib/org-db";
import { stripe } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const org = await primaryOrgForUser(me.id);
  if (!org) return NextResponse.json({ error: "no org" }, { status: 404 });

  if (!(await isOrgAdmin(org.id, me.id))) {
    return NextResponse.json({ error: "admin required for billing actions" }, { status: 403 });
  }

  if (!org.stripe_customer_id) {
    return NextResponse.json(
      { error: "no stripe customer — start a checkout first" },
      { status: 409 },
    );
  }

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;

  const session = await stripe().billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    return_url: `${origin}/billing`,
  });

  return NextResponse.json({ url: session.url });
}
