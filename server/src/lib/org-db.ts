/**
 * org-db.ts — read/write org metadata + billing state.
 *
 * The plan field is the source of truth for feature gates (lib/plan-gate).
 * Stripe webhook handlers update plan/subscription_status/current_period_end
 * via setBillingState; the request-path code never calls Stripe API
 * synchronously to determine entitlement.
 *
 * Orgs are created automatically when a user first signs in (see
 * auth-actions.ts). Almost every user has exactly one org today; the
 * schema is plural-ready for future multi-org support.
 */

import { sql } from "./db";
import type { OrgPlanRef, BillingMode } from "./plan-gate";

export type OrgPlan = "free" | "pro" | "team";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "incomplete";

export type PerSourceMode = "subscription" | "api_priced";

/**
 * Per-source subscription map. See migration 0023.
 *
 * A source flagged "subscription" is EXCLUDED from headline cost totals
 * (stat cards, cost trajectory, forecast). Rate-card cost is still
 * rendered per-source in transparency charts.
 *
 * Codex is auto-defaulted to "subscription" on first Codex span ingest
 * when the agent reports plan_type ∈ {prolite,pro,plus,team,enterprise}.
 */
export type SourceSubscriptionModes = Partial<Record<string, PerSourceMode>>;

export interface OrgRow extends OrgPlanRef {
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
  /** How the org pays Anthropic. See lib/plan-gate#BillingMode. */
  billing_mode: BillingMode;
  /** Per-source subscription overrides. See migration 0023. */
  source_subscription_modes: SourceSubscriptionModes;
  /** Optional monthly budget for /forecast burn-down. NULL = unset. */
  monthly_budget_usd: number | null;
  /** Digest cadence: 'daily' | 'weekly' | 'both'. Default 'daily'. */
  digest_frequency: "daily" | "weekly" | "both";
}

/**
 * Source-set view: which sources should be excluded from headline cost
 * totals. Combines explicit per-source overrides with the legacy org-wide
 * billing_mode (which historically meant "claude_code is on subscription").
 */
export function subscriptionSourcesFor(org: OrgRow | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!org) return out;
  // Explicit per-source overrides take precedence.
  for (const [src, mode] of Object.entries(org.source_subscription_modes ?? {})) {
    if (mode === "subscription") out.add(src);
  }
  // Legacy: claude_code defaults to subscription if billing_mode is a
  // Claude subscription (pro / max-100 / max-200) AND the user hasn't
  // set an explicit override for claude_code.
  if (
    !("claude_code" in (org.source_subscription_modes ?? {})) &&
    (org.billing_mode === "pro" || org.billing_mode === "max-100" || org.billing_mode === "max-200")
  ) {
    out.add("claude_code");
  }
  return out;
}

/**
 * Apply subscription-mode zeroing to a numeric cost-millicents value.
 * Returns 0 if the source is in the subscription set, otherwise the
 * original cost. Used by dashboard-data and digest aggregations.
 */
export function effectiveCostMillicents(
  source: string,
  costMillicents: number | null,
  subscriptionSources: Set<string>,
): number {
  if (subscriptionSources.has(source)) return 0;
  return costMillicents ?? 0;
}

export async function getOrgById(orgId: string): Promise<OrgRow | null> {
  const db = sql();
  const [row] = await db<OrgRow[]>`
    SELECT id::text AS id, name, slug, plan, plan_seats,
           stripe_customer_id, stripe_subscription_id,
           subscription_status,
           current_period_end::text AS current_period_end,
           trial_ends_at::text      AS trial_ends_at,
           created_at::text         AS created_at,
           COALESCE(billing_mode, 'api') AS billing_mode,
           COALESCE(source_subscription_modes, '{}'::jsonb) AS source_subscription_modes,
           monthly_budget_usd::float8 AS monthly_budget_usd,
           COALESCE(digest_frequency, 'daily') AS digest_frequency
    FROM org WHERE id = ${orgId}::uuid
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
           o.created_at::text         AS created_at,
           COALESCE(o.billing_mode, 'api') AS billing_mode,
           COALESCE(o.source_subscription_modes, '{}'::jsonb) AS source_subscription_modes,
           o.monthly_budget_usd::float8 AS monthly_budget_usd,
           COALESCE(o.digest_frequency, 'daily') AS digest_frequency
    FROM org o
    JOIN membership m ON m.org_id = o.id
    WHERE m.user_id = ${userId}::uuid
    ORDER BY o.created_at ASC
    LIMIT 1
  `;
  return row ?? null;
}

/** Count current members (accepted memberships, not pending invites). */
export async function countMembers(orgId: string): Promise<number> {
  const db = sql();
  const [row] = await db<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM membership WHERE org_id = ${orgId}::uuid
  `;
  return row?.n ?? 0;
}

/** Count pending (not yet accepted) invites for an org. */
export async function countPendingInvites(orgOwnerId: string): Promise<number> {
  const db = sql();
  const [row] = await db<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM invite
    WHERE owner_id = ${orgOwnerId}::uuid
      AND accepted_at IS NULL
      AND expires_at > NOW()
  `;
  return row?.n ?? 0;
}

/** Count projects belonging to this org. */
export async function countProjects(orgId: string): Promise<number> {
  const db = sql();
  const [row] = await db<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM project WHERE org_id = ${orgId}::uuid
  `;
  return row?.n ?? 0;
}

/** Is the user an owner/admin of this org? Used for billing actions. */
/**
 * Update an org's billing_mode. Only an admin should call this; the
 * route handler is responsible for authorization. Validates against the
 * BillingMode enum at the SQL CHECK constraint level.
 */
export async function setBillingMode(orgId: string, mode: BillingMode): Promise<void> {
  const db = sql();
  await db`
    UPDATE org
    SET billing_mode = ${mode}::text,
        billing_mode_set_at = now()
    WHERE id = ${orgId}::uuid
  `;
}

/**
 * Set or unset a per-source subscription override. Pass mode=null to
 * remove the key (falls back to default-via-billing_mode for claude, or
 * api_priced for anything else).
 *
 * Validates source against the same enum the OTLP ingest accepts, so
 * arbitrary user input (e.g. via the settings form) can't grow the JSONB
 * with junk keys.
 */
const KNOWN_SOURCES_FOR_SUBSCRIPTION = new Set([
  "claude_code", "codex", "cursor", "copilot", "wakatime", "git", "shell", "ashlr_plugin",
]);

export async function setSourceSubscriptionMode(
  orgId: string,
  source: string,
  mode: PerSourceMode | null,
): Promise<void> {
  if (!KNOWN_SOURCES_FOR_SUBSCRIPTION.has(source)) {
    throw new Error(`unknown source for subscription mode: ${source}`);
  }
  const db = sql();
  if (mode == null) {
    // Remove the key entirely.
    await db`
      UPDATE org
      SET source_subscription_modes = source_subscription_modes - ${source}::text
      WHERE id = ${orgId}::uuid
    `;
    return;
  }
  await db`
    UPDATE org
    SET source_subscription_modes =
      COALESCE(source_subscription_modes, '{}'::jsonb)
        || jsonb_build_object(${source}::text, ${mode}::text)
    WHERE id = ${orgId}::uuid
  `;
}

/**
 * Update a user's monthly budget in dollars. Pass null to clear.
 */
export async function setMonthlyBudgetUsd(
  orgId: string,
  budget: number | null,
): Promise<void> {
  const db = sql();
  await db`
    UPDATE org
    SET monthly_budget_usd = ${budget}
    WHERE id = ${orgId}::uuid
  `;
}

/**
 * Update an org's digest_frequency ('daily' | 'weekly' | 'both').
 * Only an admin should call this; the route handler is responsible for
 * authorization.
 */
export async function setDigestFrequency(
  orgId: string,
  frequency: "daily" | "weekly" | "both",
): Promise<void> {
  const db = sql();
  await db`
    UPDATE org
    SET digest_frequency = ${frequency}::text
    WHERE id = ${orgId}::uuid
  `;
}

/**
 * Codex auto-default: if this is the first Codex span ingested for the
 * org AND the agent reported a subscription-tier plan_type, set
 * source_subscription_modes['codex'] = 'subscription' so the user starts
 * with a sensible default. Idempotent: only sets when key is absent.
 *
 * Called from the OTLP ingest path after row inserts succeed.
 */
const CODEX_SUBSCRIPTION_PLANS = new Set([
  "prolite", "pro", "plus", "team", "enterprise",
]);

export async function maybeAutoDefaultCodexSubscription(
  orgId: string,
  observedPlanType: string | null,
): Promise<void> {
  if (!observedPlanType) return;
  if (!CODEX_SUBSCRIPTION_PLANS.has(observedPlanType)) return;
  const db = sql();
  // Set codex='subscription' only if NOT already present in the JSONB.
  await db`
    UPDATE org
    SET source_subscription_modes =
      COALESCE(source_subscription_modes, '{}'::jsonb)
        || jsonb_build_object('codex', 'subscription')
    WHERE id = ${orgId}::uuid
      AND NOT (COALESCE(source_subscription_modes, '{}'::jsonb) ? 'codex')
  `;
}

export async function isOrgAdmin(orgId: string, userId: string): Promise<boolean> {
  const db = sql();
  const [row] = await db<{ role: string }[]>`
    SELECT role FROM membership
    WHERE org_id = ${orgId}::uuid AND user_id = ${userId}::uuid
  `;
  return row?.role === "owner" || row?.role === "admin";
}

/** Look up an org by its Stripe customer ID — webhook fast path. */
export async function getOrgByStripeCustomerId(
  customerId: string,
): Promise<OrgRow | null> {
  const db = sql();
  const [row] = await db<OrgRow[]>`
    SELECT id::text AS id, name, slug, plan, plan_seats,
           stripe_customer_id, stripe_subscription_id,
           subscription_status,
           current_period_end::text AS current_period_end,
           trial_ends_at::text      AS trial_ends_at,
           created_at::text         AS created_at,
           COALESCE(billing_mode, 'api') AS billing_mode,
           COALESCE(source_subscription_modes, '{}'::jsonb) AS source_subscription_modes,
           monthly_budget_usd::float8 AS monthly_budget_usd,
           COALESCE(digest_frequency, 'daily') AS digest_frequency
    FROM org WHERE stripe_customer_id = ${customerId}
  `;
  return row ?? null;
}

/**
 * Persist the Stripe customer ID on an org. Idempotent — safe to call from
 * the checkout session route and from the customer.created webhook (whichever
 * fires first wins; the other becomes a no-op).
 */
export async function linkStripeCustomer(
  orgId: string,
  customerId: string,
): Promise<void> {
  const db = sql();
  await db`
    UPDATE org
       SET stripe_customer_id = ${customerId}
     WHERE id = ${orgId}::uuid
       AND (stripe_customer_id IS NULL OR stripe_customer_id = ${customerId})
  `;
}

export interface BillingState {
  plan: OrgPlan;
  plan_seats?: number;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus | null;
  current_period_end: Date | null;
  trial_ends_at: Date | null;
}

/**
 * Apply the billing state derived from a Stripe webhook event. Called only
 * from the webhook handler (request-path code never touches these columns).
 *
 * The webhook is the source of truth — never call Stripe API synchronously
 * from a user-facing request to determine entitlement, because Stripe's
 * 99.99% SLA isn't tight enough for the request path.
 */
export async function setBillingState(
  orgId: string,
  state: BillingState,
): Promise<void> {
  const db = sql();
  await db`
    UPDATE org SET
      plan                   = ${state.plan},
      plan_seats             = ${state.plan_seats ?? 1},
      stripe_subscription_id = ${state.stripe_subscription_id},
      subscription_status    = ${state.subscription_status},
      current_period_end     = ${state.current_period_end},
      trial_ends_at          = ${state.trial_ends_at}
    WHERE id = ${orgId}::uuid
  `;
}

/**
 * Durable Stripe webhook idempotency. Returns true only for the first time
 * an event ID is seen; duplicate deliveries should return 200 without
 * replaying side effects.
 */
export async function markStripeWebhookEvent(
  eventId: string,
  eventType: string,
): Promise<boolean> {
  const db = sql();
  const result = await db`
    INSERT INTO stripe_webhook_event (event_id, event_type)
    VALUES (${eventId}, ${eventType})
    ON CONFLICT (event_id) DO NOTHING
  `;
  return result.count === 1;
}

export async function unmarkStripeWebhookEvent(eventId: string): Promise<void> {
  const db = sql();
  await db`DELETE FROM stripe_webhook_event WHERE event_id = ${eventId}`;
}
