/**
 * webhook-db.ts — read/write webhook configuration on org.
 *
 * Stores the webhook endpoint URL, optional HMAC signing secret, and event
 * filter list for the fleet scorecard webhook sink introduced in migration 0035.
 *
 * Privacy floor: this module only persists/reads configuration metadata.
 * The webhook payload itself (built in fleet-scorecard-webhook/route.ts)
 * carries only counts, costs, enums, and thresholds — never prompts, code,
 * completions, or diff metadata.
 */

import { sql } from "./db";

/** All event slugs the webhook system understands. */
export const WEBHOOK_EVENT_SLUGS = [
  "fleet_quality_alert",
  "budget_exceeded",
  "stale_review",
  "agent_down",
] as const;

export type WebhookEventSlug = (typeof WEBHOOK_EVENT_SLUGS)[number];

export interface OrgWebhookConfig {
  webhook_url: string | null;
  webhook_secret: string | null;
  webhook_events: WebhookEventSlug[];
}

/**
 * Read webhook configuration for an org. Returns nulls/defaults when unset.
 */
export async function getOrgWebhookConfig(
  orgId: string,
): Promise<OrgWebhookConfig> {
  const db = sql();
  const [row] = await db<
    {
      webhook_url: string | null;
      webhook_secret: string | null;
      webhook_events: string[] | null;
    }[]
  >`
    SELECT webhook_url, webhook_secret, webhook_events
    FROM org
    WHERE id = ${orgId}::uuid
  `;
  return {
    webhook_url: row?.webhook_url ?? null,
    webhook_secret: row?.webhook_secret ?? null,
    webhook_events: (row?.webhook_events ?? [
      "fleet_quality_alert",
      "budget_exceeded",
    ]) as WebhookEventSlug[],
  };
}

/**
 * Persist webhook configuration for an org. Validates the URL is HTTPS and
 * the event slugs are known. Passing null for webhook_url disables the sink.
 *
 * The secret is stored as-is — callers are responsible for generating a
 * cryptographically strong value (>=32 random bytes, base64 or hex).
 */
export async function setOrgWebhookConfig(
  orgId: string,
  config: Partial<OrgWebhookConfig>,
): Promise<void> {
  const db = sql();

  if (config.webhook_url !== undefined) {
    if (config.webhook_url !== null) {
      let parsed: URL;
      try {
        parsed = new URL(config.webhook_url);
      } catch {
        throw new Error("webhook_url must be a valid URL");
      }
      if (parsed.protocol !== "https:") {
        throw new Error("webhook_url must use HTTPS");
      }
    }
    await db`
      UPDATE org SET webhook_url = ${config.webhook_url} WHERE id = ${orgId}::uuid
    `;
  }

  if (config.webhook_secret !== undefined) {
    await db`
      UPDATE org SET webhook_secret = ${config.webhook_secret} WHERE id = ${orgId}::uuid
    `;
  }

  if (config.webhook_events !== undefined) {
    const valid = new Set<string>(WEBHOOK_EVENT_SLUGS);
    const filtered = (config.webhook_events ?? []).filter((e) => valid.has(e));
    await db`
      UPDATE org SET webhook_events = ${db.array(filtered)} WHERE id = ${orgId}::uuid
    `;
  }
}

/**
 * Return all orgs that have a webhook_url configured (non-null).
 * Used by the cron sweep to find orgs to notify.
 *
 * Security: this list deliberately omits webhook_secret. Holding every org's
 * signing secret in memory for the duration of the sweep is an unnecessary
 * credential-exposure surface. Callers fetch the secret on-demand per-org via
 * getOrgWebhookSecret() right before HMAC signing.
 */
export async function listOrgsWithWebhook(): Promise<
  Array<{ org_id: string; webhook_url: string; webhook_events: WebhookEventSlug[] }>
> {
  const db = sql();
  const rows = await db<
    {
      org_id: string;
      webhook_url: string;
      webhook_events: string[] | null;
    }[]
  >`
    SELECT id::text AS org_id,
           webhook_url,
           COALESCE(webhook_events, ARRAY['fleet_quality_alert', 'budget_exceeded']::text[]) AS webhook_events
    FROM org
    WHERE webhook_url IS NOT NULL
  `;
  return rows.map((r) => ({
    org_id: r.org_id,
    webhook_url: r.webhook_url,
    webhook_events: (r.webhook_events ?? []) as WebhookEventSlug[],
  }));
}

/**
 * Fetch a single org's webhook signing secret on-demand. Returns null when the
 * org has no secret configured. Kept narrow so the secret only lives in memory
 * for the brief window around HMAC signing of a delivery.
 */
export async function getOrgWebhookSecret(
  orgId: string,
): Promise<string | null> {
  const db = sql();
  const [row] = await db<{ webhook_secret: string | null }[]>`
    SELECT webhook_secret FROM org WHERE id = ${orgId}::uuid
  `;
  return row?.webhook_secret ?? null;
}
