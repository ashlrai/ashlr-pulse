/**
 * peer-share-agg.ts — hourly materialisation of peer-share activity into
 * peer_share_hourly_aggregate + signed webhook delivery to subscribing orgs.
 *
 * Called by /api/cron/peer-share-hourly-agg (hourly cron).
 *
 * Responsibilities
 * ----------------
 * 1. For each active (non-revoked) peer_share grant:
 *    a. Aggregate past-hour activity_event rows for the grant owner into
 *       peer_share_hourly_aggregate (INSERT … ON CONFLICT DO UPDATE).
 *    b. If the resulting cost_millicents > 0 for the hour bucket AND the
 *       owner's org has peer_share_webhook_url configured, POST a sanitised
 *       JSON payload signed with HMAC-SHA256(PULSE_CRON_SECRET, body).
 * 2. Return a per-run summary: pairs processed, rows upserted, webhooks sent.
 *
 * Privacy floor (enforced by sanitisePayload)
 * -------------------------------------------
 * • `repo_name` is included in the payload ONLY when "repo_name" appears in
 *   grant.fields.
 * • `model` is included ONLY when "model" appears in grant.fields.
 * • No prompts, completions, code, diffs, or raw OTel spans — ever.
 * • Aggregate numbers only: tokens_input, tokens_output, cost_millicents,
 *   event_count, share_id, owner_id, viewer_id, hour_bucket.
 *
 * Retry
 * -----
 * deliverPeerShareWebhook retries on 5xx up to MAX_RETRIES times with
 * exponential backoff (same pattern as fleet-scorecard-webhook.ts).
 * 4xx responses are not retried (bad URL / wrong auth).
 * Per-pair errors are swallowed so one bad delivery doesn't abort the sweep.
 */

import { createHmac } from "crypto";
import { sql } from "@/lib/db";
import { log } from "@/lib/logger";
import {
  broadcastPeerShareAgg,
  type PeerShareAggEvent,
} from "@/lib/dashboard-sse-broadcast";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_RETRIES = 3;
export const BASE_BACKOFF_MS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One row returned from the active-grants query. */
export interface ActiveGrant {
  share_id: string;
  owner_id: string;
  viewer_id: string;
  fields: string[];
  org_id: string | null;
  peer_share_webhook_url: string | null;
}

/** The sanitised payload posted to the webhook endpoint. */
export interface PeerShareWebhookPayload {
  event: "peer_share_activity";
  share_id: string;
  owner_id: string;
  viewer_id: string;
  hour_bucket: string;
  tokens_input: number;
  tokens_output: number;
  cost_millicents: number;
  event_count: number;
  /** Only present when "model" is in grant.fields */
  model?: string;
  /** Only present when "repo_name" is in grant.fields */
  repo_name?: string;
  triggered_at: string;
}

export type DeliveryResult =
  | { ok: true; status: number; attempt: number }
  | { ok: false; status: number | null; attempt: number; error: string };

// ---------------------------------------------------------------------------
// Active grant loader
// ---------------------------------------------------------------------------

/**
 * Fetch every non-revoked peer_share grant together with the owner's org
 * peer_share_webhook_url (when configured).
 */
export async function listActiveGrants(): Promise<ActiveGrant[]> {
  const db = sql();
  const rows = await db<{
    share_id: string;
    owner_id: string;
    viewer_id: string;
    fields: string[];
    org_id: string | null;
    peer_share_webhook_url: string | null;
  }[]>`
    SELECT
      ps.id::text                       AS share_id,
      ps.owner_id::text                 AS owner_id,
      ps.viewer_id::text                AS viewer_id,
      ps.fields                         AS fields,
      m.org_id::text                    AS org_id,
      o.peer_share_webhook_url          AS peer_share_webhook_url
    FROM peer_share ps
    LEFT JOIN LATERAL (
      SELECT org_id
      FROM   membership
      WHERE  user_id = ps.owner_id
      ORDER  BY created_at ASC
      LIMIT  1
    ) m ON TRUE
    LEFT JOIN org o ON o.id = m.org_id
    WHERE ps.revoked_at IS NULL
  `;

  return rows.map((r) => ({
    share_id: r.share_id,
    owner_id: r.owner_id,
    viewer_id: r.viewer_id,
    fields: Array.isArray(r.fields) ? r.fields : [],
    org_id: r.org_id,
    peer_share_webhook_url: r.peer_share_webhook_url,
  }));
}

// ---------------------------------------------------------------------------
// Past-hour aggregate query
// ---------------------------------------------------------------------------

export interface HourAggRow {
  source: string;
  model: string;
  tokens_input: number;
  tokens_output: number;
  cost_millicents: number;
  event_count: number;
}

/**
 * Aggregate activity_event rows for owner_id in the given hour bucket
 * [bucketStart, bucketStart + 1 h), gated by an active grant for the pair.
 *
 * Returns empty array when no grant exists or is revoked.
 */
export async function aggregatePastHour(
  ownerId: string,
  viewerId: string,
  bucketStart: Date,
): Promise<HourAggRow[]> {
  const db = sql();
  const bucketStartIso = bucketStart.toISOString();
  const bucketEndIso = new Date(bucketStart.getTime() + 3_600_000).toISOString();

  const rows = await db<{
    source: string;
    model: string;
    tokens_input: string | number;
    tokens_output: string | number;
    cost_millicents: string | number;
    event_count: string | number;
  }[]>`
    SELECT
      COALESCE(ae.source, '')                       AS source,
      COALESCE(ae.model,  '')                       AS model,
      COALESCE(SUM(ae.tokens_input),  0)::bigint    AS tokens_input,
      COALESCE(SUM(ae.tokens_output), 0)::bigint    AS tokens_output,
      COALESCE(SUM(ae.cost_millicents), 0)::bigint  AS cost_millicents,
      COUNT(*)::int                                 AS event_count
    FROM activity_event ae
    WHERE ae.user_id = ${ownerId}::uuid
      AND ae.ts >= ${bucketStartIso}::timestamptz
      AND ae.ts <  ${bucketEndIso}::timestamptz
      AND EXISTS (
        SELECT 1 FROM peer_share ps
        WHERE ps.owner_id  = ${ownerId}::uuid
          AND ps.viewer_id = ${viewerId}::uuid
          AND ps.revoked_at IS NULL
      )
    GROUP BY ae.source, ae.model
  `;

  return rows.map((r) => ({
    source: String(r.source ?? ""),
    model: String(r.model ?? ""),
    tokens_input: Number(r.tokens_input ?? 0),
    tokens_output: Number(r.tokens_output ?? 0),
    cost_millicents: Number(r.cost_millicents ?? 0),
    event_count: Number(r.event_count ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Upsert into peer_share_hourly_aggregate
// ---------------------------------------------------------------------------

/**
 * Upsert aggregated rows for one (owner, viewer) pair for the given hour
 * bucket into peer_share_hourly_aggregate.
 *
 * Returns the number of rows upserted.
 */
export async function upsertHourlyAggregate(
  shareId: string,
  ownerId: string,
  viewerId: string,
  bucketStart: Date,
  rows: HourAggRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const db = sql();
  const bucketIso = bucketStart.toISOString();
  let upserted = 0;

  for (const r of rows) {
    await db`
      INSERT INTO peer_share_hourly_aggregate
        (owner_id, viewer_id, hour_bucket, source, model,
         tokens_input, tokens_output, cost_millicents, event_count, computed_at)
      VALUES (
        ${ownerId}::uuid,
        ${viewerId}::uuid,
        ${bucketIso}::timestamptz,
        ${r.source},
        ${r.model},
        ${r.tokens_input},
        ${r.tokens_output},
        ${r.cost_millicents},
        ${r.event_count},
        NOW()
      )
      ON CONFLICT (owner_id, viewer_id, hour_bucket, source, model) DO UPDATE SET
        tokens_input    = EXCLUDED.tokens_input,
        tokens_output   = EXCLUDED.tokens_output,
        cost_millicents = EXCLUDED.cost_millicents,
        event_count     = EXCLUDED.event_count,
        computed_at     = EXCLUDED.computed_at
    `;
    upserted++;
  }

  // Note: share_id is recorded in the payload for webhook consumers but is
  // not a column in peer_share_hourly_aggregate (it joins via owner+viewer).
  // We do not add it to the table to avoid schema drift; callers carry it.
  void shareId; // used in webhook payload only

  return upserted;
}

// ---------------------------------------------------------------------------
// Privacy sanitisation
// ---------------------------------------------------------------------------

/**
 * Build the webhook payload for one (share, hour_bucket, aggregate) triple.
 *
 * Privacy floor:
 *   • model is included ONLY when "model" is in grant.fields.
 *   • repo_name is included ONLY when "repo_name" is in grant.fields.
 *   • No prompts, completions, diffs, file contents, or raw spans — ever.
 *   • Only aggregate counts (tokens, cost, event_count) always flow through.
 */
export function sanitisePayload(
  grant: Pick<ActiveGrant, "share_id" | "owner_id" | "viewer_id" | "fields">,
  bucketIso: string,
  agg: { tokens_input: number; tokens_output: number; cost_millicents: number; event_count: number; model?: string; repo_name?: string },
  triggeredAt: string,
): PeerShareWebhookPayload {
  const payload: PeerShareWebhookPayload = {
    event: "peer_share_activity",
    share_id: grant.share_id,
    owner_id: grant.owner_id,
    viewer_id: grant.viewer_id,
    hour_bucket: bucketIso,
    tokens_input: agg.tokens_input,
    tokens_output: agg.tokens_output,
    cost_millicents: agg.cost_millicents,
    event_count: agg.event_count,
    triggered_at: triggeredAt,
  };

  // Conditionally include model only when grant permits it.
  if (agg.model !== undefined && grant.fields.includes("model")) {
    payload.model = agg.model;
  }

  // Conditionally include repo_name only when grant permits it.
  if (agg.repo_name !== undefined && grant.fields.includes("repo_name")) {
    payload.repo_name = agg.repo_name;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// HMAC signing (same convention as fleet-scorecard-webhook.ts)
// ---------------------------------------------------------------------------

/**
 * Sign a raw body string with HMAC-SHA256.
 * Returns "sha256=<hex>" matching the GitHub webhook signature convention.
 */
export function signWebhookPayload(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// HTTP delivery with exponential backoff retry
// ---------------------------------------------------------------------------

/**
 * POST a PeerShareWebhookPayload to url, optionally HMAC-signed.
 * Retries up to MAX_RETRIES on 5xx; does NOT retry on 4xx.
 *
 * @param url     - Destination endpoint (org.peer_share_webhook_url).
 * @param payload - Sanitised payload (no restricted fields).
 * @param secret  - When provided, adds x-pulse-signature header.
 */
export async function deliverPeerShareWebhook(
  url: string,
  payload: PeerShareWebhookPayload,
  secret: string | null,
): Promise<DeliveryResult> {
  const rawBody = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "ashlr-pulse/1.0 (+https://pulse.ashlr.dev)",
    "x-pulse-event": "peer_share_activity",
  };
  if (secret) {
    headers["x-pulse-signature"] = signWebhookPayload(secret, rawBody);
  }

  let lastError = "";
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });

      lastStatus = resp.status;

      if (resp.ok) {
        return { ok: true, status: resp.status, attempt };
      }

      // 4xx → do not retry (bad URL, wrong auth, disabled endpoint).
      if (resp.status >= 400 && resp.status < 500) {
        return {
          ok: false,
          status: resp.status,
          attempt,
          error: `HTTP ${resp.status} — not retrying (4xx)`,
        };
      }

      // 5xx → retry after backoff.
      lastError = `HTTP ${resp.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastStatus = null;
    }

    if (attempt < MAX_RETRIES) {
      const backoffMs = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      log.warn({
        msg: "peer-share-agg: webhook delivery failed, retrying",
        url,
        attempt,
        backoff_ms: backoffMs,
        error: lastError,
      });
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  return { ok: false, status: lastStatus, attempt: MAX_RETRIES, error: lastError };
}

// ---------------------------------------------------------------------------
// Cron entry point
// ---------------------------------------------------------------------------

export interface PeerShareHourlyAggResult {
  pairs: number;
  rowsUpserted: number;
  webhooksSent: number;
  webhooksFailed: number;
}

/**
 * Main cron body — called by /api/cron/peer-share-hourly-agg.
 *
 * For each active grant:
 *   1. Aggregate past-hour events.
 *   2. Upsert into peer_share_hourly_aggregate.
 *   3. If cost > 0 AND webhook URL is set, POST a sanitised payload.
 */
export async function runPeerShareHourlyAgg(
  overrideSecret?: string,
): Promise<PeerShareHourlyAggResult> {
  const secret = overrideSecret ?? process.env.PULSE_CRON_SECRET ?? null;

  const nowMs = Date.now();
  const bucketStartMs = nowMs - (nowMs % 3_600_000) - 3_600_000; // previous full hour
  const bucketStart = new Date(bucketStartMs);
  const triggeredAt = new Date().toISOString();

  const grants = await listActiveGrants();

  let rowsUpserted = 0;
  let webhooksSent = 0;
  let webhooksFailed = 0;

  for (const grant of grants) {
    try {
      const aggRows = await aggregatePastHour(grant.owner_id, grant.viewer_id, bucketStart);
      rowsUpserted += await upsertHourlyAggregate(
        grant.share_id,
        grant.owner_id,
        grant.viewer_id,
        bucketStart,
        aggRows,
      );

      // Only send webhook when there was actual activity this hour.
      const totalCost = aggRows.reduce((s, r) => s + r.cost_millicents, 0);
      if (totalCost > 0 && grant.peer_share_webhook_url) {
        // Roll up across sources/models for the webhook payload.
        const totalTokensIn  = aggRows.reduce((s, r) => s + r.tokens_input, 0);
        const totalTokensOut = aggRows.reduce((s, r) => s + r.tokens_output, 0);
        const totalEvents    = aggRows.reduce((s, r) => s + r.event_count, 0);

        // Privacy: model only if a single model (otherwise omit — could leak cross-model info).
        const uniqueModels = [...new Set(aggRows.map((r) => r.model).filter(Boolean))];
        const singleModel = uniqueModels.length === 1 ? uniqueModels[0] : undefined;

        const payload = sanitisePayload(
          grant,
          bucketStart.toISOString(),
          {
            tokens_input: totalTokensIn,
            tokens_output: totalTokensOut,
            cost_millicents: totalCost,
            event_count: totalEvents,
            model: singleModel,
          },
          triggeredAt,
        );

        const result = await deliverPeerShareWebhook(
          grant.peer_share_webhook_url,
          payload,
          secret,
        );

        if (result.ok) {
          webhooksSent++;
          log.info({
            msg: "peer-share-agg: webhook delivered",
            share_id: grant.share_id,
            status: result.status,
            attempt: result.attempt,
          });
        } else {
          webhooksFailed++;
          log.error({
            msg: "peer-share-agg: webhook delivery failed",
            share_id: grant.share_id,
            status: result.status,
            attempt: result.attempt,
            error: result.error,
          });
        }
      }
    } catch (err) {
      log.error({
        msg: "peer-share-agg: pair threw",
        share_id: grant.share_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    pairs: grants.length,
    rowsUpserted,
    webhooksSent,
    webhooksFailed,
  };
}

// ---------------------------------------------------------------------------
// notifyPeerShareSubscribers — SSE push after aggregate upsert
// ---------------------------------------------------------------------------

/**
 * Fan out a peer-share aggregate update to all live SSE connections for the
 * viewer identified by viewerId.
 *
 * Called immediately after upsertHourlyAggregate (or the daily/weekly
 * equivalents) so dashboard clients subscribed via GET /api/peer-share-subscribe
 * receive a push instead of having to poll.
 *
 * Privacy floor (enforced by PeerShareAggEvent type in dashboard-sse-broadcast):
 *   • by_model / by_source / by_language gated by grantFields.
 *   • No prompts, completions, raw spans, email addresses, or code.
 *   • All values are numeric aggregates or grant-permitted metadata.
 *
 * @param viewerId       The viewer whose SSE connections should receive the event.
 * @param ownerId        The owner whose data was aggregated.
 * @param aggregateType  "hourly" | "daily" | "weekly" — identifies the cron that ran.
 * @param bucketStart    ISO-8601 start of the time bucket.
 * @param totals         Aggregate totals (cost, tokens, event_count).
 * @param grantFields    The grant's SHAREABLE_FIELDS whitelist — gates optional breakdowns.
 * @param breakdowns     Optional per-model/source/language breakdowns.
 * @returns              Number of SSE controllers that received the event.
 */
export function notifyPeerShareSubscribers(
  viewerId: string,
  ownerId: string,
  aggregateType: "hourly" | "daily" | "weekly",
  bucketStart: string,
  totals: {
    cost_millicents: number;
    tokens_input: number;
    tokens_output: number;
    event_count: number;
    duration_ms?: number;
  },
  grantFields: string[],
  breakdowns: {
    by_model?: Record<string, { cost_millicents: number; tokens_input: number; tokens_output: number }>;
    by_source?: Record<string, { cost_millicents: number; tokens_input: number; tokens_output: number }>;
    by_language?: Record<string, { cost_millicents: number; event_count: number }>;
  } = {},
): number {
  const event: PeerShareAggEvent = {
    type: "peer_share_agg",
    ts: new Date().toISOString(),
    aggregate_type: aggregateType,
    owner_id: ownerId,
    viewer_id: viewerId,
    bucket_start: bucketStart,
    cost_millicents: totals.cost_millicents,
    tokens_input: totals.tokens_input,
    tokens_output: totals.tokens_output,
    event_count: totals.event_count,
  };

  // Conditionally include optional fields gated by grant permissions.
  if (totals.duration_ms !== undefined && grantFields.includes("duration_ms")) {
    event.duration_ms = totals.duration_ms;
  }
  if (breakdowns.by_model && grantFields.includes("model")) {
    event.by_model = breakdowns.by_model;
  }
  if (breakdowns.by_source && grantFields.includes("source")) {
    event.by_source = breakdowns.by_source;
  }
  if (breakdowns.by_language && grantFields.includes("language")) {
    event.by_language = breakdowns.by_language;
  }

  const delivered = broadcastPeerShareAgg(viewerId, event);

  if (delivered > 0) {
    log.info({
      msg: "peer-share-agg: SSE notify delivered",
      viewer_id: viewerId,
      owner_id: ownerId,
      aggregate_type: aggregateType,
      bucket_start: bucketStart,
      controllers: delivered,
    });
  }

  return delivered;
}
