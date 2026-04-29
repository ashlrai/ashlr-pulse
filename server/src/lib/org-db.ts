/**
 * org-db.ts — read/write org metadata + billing state.
 *
 * The plan field is the source of truth for feature gates (lib/plan-gate).
 * Stripe webhook handlers update plan/subscription_status/current_period_end
 * via setBillingState; the request-path code never calls Stripe API
 * synchronously to determine entitlement.
 */

import { sql } from "./db";

export type OrgPlan = "free" | "pro" | "team";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "incomplete";

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  plan: OrgPlan;
  plan_seats: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  created_at: string;
}

export async function getOrgById(orgId: string): Promise<OrgRow | null> {
  const db = sql();
  const [row] = await db<OrgRow[]>`
    SELECT id::text AS id, name, slug, plan, plan_seats,
           stripe_customer_id, stripe_subscription_id,
           subscription_status,
           current_period_end::text AS current_period_end,
           trial_ends_at::text      AS trial_ends_at,
           created_at::text         AS created_at
    FROM org WHERE id = ${orgId}::uuid
  `;
  return row ?? null;
}

export async function getOrgByStripeCustomer(customerId: string): Promise<OrgRow | null> {
  const db = sql();
  const [row] = await db<OrgRow[]>`
    SELECT id::text AS id, name, slug, plan, plan_seats,
           stripe_customer_id, stripe_subscription_id,
           subscription_status,
           current_period_end::text AS current_period_end,
           trial_ends_at::text      AS trial_ends_at,
           created_at::text         AS created_at
    FROM org WHERE stripe_customer_id = ${customerId}
  `;
  return row ?? null;
}

/**
 * Primary org for a user — the first one they're a member of, by created_at.
 * Almost everyone has exactly one org today; the schema is plural-ready.
 */
export async function primaryOrgForUser(userId: string): Promise<OrgRow | null> {
  const db = sql();
  const [row] = await db<OrgRow[]>`
    SELECT o.id::text AS id, o.name, o.slug, o.plan, o.plan_seats,
           o.stripe_customer_id, o.stripe_subscription_id,
           o.subscription_status,
           o.current_period_end::text AS current_period_end,
           o.trial_ends_at::text      AS trial_ends_at,
           o.created_at::text         AS created_at
    FROM org o
    JOIN membership m ON m.org_id = o.id
    WHERE m.user_id = ${userId}::uuid
    ORDER BY o.created_at ASC
    LIMIT 1
  `;
  return row ?? null;
}

export async function setStripeCustomerId(orgId: string, customerId: string): Promise<void> {
  const db = sql();
  await db`
    UPDATE org SET stripe_customer_id = ${customerId}
    WHERE id = ${orgId}::uuid
  `;
}

export interface BillingStateUpdate {
  plan: OrgPlan;
  plan_seats: number;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus | null;
  current_period_end: Date | null;
  trial_ends_at: Date | null;
}

export async function setBillingState(orgId: string, u: BillingStateUpdate): Promise<void> {
  const db = sql();
  await db`
    UPDATE org SET
      plan                   = ${u.plan},
      plan_seats             = ${u.plan_seats},
      stripe_subscription_id = ${u.stripe_subscription_id},
      subscription_status    = ${u.subscription_status},
      current_period_end     = ${u.current_period_end ? u.current_period_end.toISOString() : null},
      trial_ends_at          = ${u.trial_ends_at ? u.trial_ends_at.toISOString() : null}
    WHERE id = ${orgId}::uuid
  `;
}

export async function countMembers(orgId: string): Promise<number> {
  const db = sql();
  const [row] = await db<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM membership WHERE org_id = ${orgId}::uuid
  `;
  return row?.n ?? 0;
}

export async function countProjects(orgId: string): Promise<number> {
  const db = sql();
  const [row] = await db<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM project WHERE org_id = ${orgId}::uuid
  `;
  return row?.n ?? 0;
}

/** Is the user an owner/admin of this org? Used for billing actions. */
export async function isOrgAdmin(orgId: string, userId: string): Promise<boolean> {
  const db = sql();
  const [row] = await db<{ role: string }[]>`
    SELECT role FROM membership
    WHERE org_id = ${orgId}::uuid AND user_id = ${userId}::uuid
  `;
  return row?.role === "owner" || row?.role === "admin";
}
