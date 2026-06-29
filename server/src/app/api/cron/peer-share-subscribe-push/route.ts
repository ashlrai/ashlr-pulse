/**
 * POST /api/cron/peer-share-subscribe-push
 *
 * Fires every minute (via Railway/Vercel cron or external scheduler).
 * Fans out pending materialized aggregate deltas to all active subscribers
 * whose next_retry_at is <= NOW().
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env) —
 * identical to all other /api/cron/* routes.
 *
 * Per run:
 *   1. Load all due subscribers (next_retry_at <= NOW()).
 *   2. For each subscriber:
 *      a. Verify the viewer still holds an active grant from the owner.
 *         If not, skip (grant may have been revoked after subscription).
 *      b. Query the latest materialized aggregate for the subscriber's
 *         (owner, viewer, granularity, scope) combination.
 *      c. Build a signed PeerShareAggregateDelta (SHAREABLE_FIELDS enforced).
 *      d. POST to the subscriber's webhook_url via broadcastPeerShareAggregate().
 *      e. On success: markSubscriberDelivered() — resets fail_count + advances schedule.
 *         On failure: markSubscriberFailed() — increments fail_count + exponential backoff.
 *   3. Return summary: { subscribers_due, delivered, skipped, failed, errors[] }.
 *
 * Privacy floor:
 *   • Only fields present in the grant's fields[] array are included.
 *   • broadcastPeerShareAggregate / buildAggregateDelta enforce SHAREABLE_FIELDS.
 *   • No emails, prompts, completions, diffs, or raw spans flow here.
 *
 * Idempotency:
 *   • The aggregate query returns the latest materialized bucket.
 *   • A successful push advances next_retry_at by 1 h (hourly) or 7 d (weekly),
 *     preventing duplicate delivery within the same bucket window.
 *   • Redundant pushes from back-to-back cron firings are harmless: the
 *     aggregate values are the same and the seq+ts in the delta differ so
 *     receivers can dedup by seq if needed.
 */

import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/timing-safe";
import { log } from "@/lib/logger";
import { listGrantsForViewer } from "@/lib/peer-share-db";
import {
  listDueSubscribers,
  markSubscriberDelivered,
  markSubscriberFailed,
  type PeerShareSubscriberRow,
} from "@/lib/peer-share-subscribe-db";
import {
  buildAggregateDelta,
  broadcastPeerShareAggregate,
} from "@/lib/peer-share-realtime";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // 1 min — one cron tick

// ---------------------------------------------------------------------------
// Aggregate query
// ---------------------------------------------------------------------------

interface LatestAggRow {
  cost_millicents: number;
  tokens_input: number;
  tokens_output: number;
  event_count: number;
  duration_ms: number;
  bucket_start: string;
  by_model: Record<string, { cost_millicents: number; tokens_input: number; tokens_output: number }> | null;
  by_source: Record<string, { cost_millicents: number; tokens_input: number; tokens_output: number }> | null;
  by_language: Record<string, { cost_millicents: number; event_count: number }> | null;
}

/**
 * Fetch the most recent materialized aggregate bucket for an (owner, viewer)
 * pair at the requested granularity.
 *
 * For "hourly" — reads peer_share_hourly_aggregate, sums the last complete bucket.
 * For "weekly" — reads peer_share_weekly_aggregate, returns the latest ISO week.
 *
 * Returns null when no data is available yet.
 */
async function fetchLatestAggregate(
  ownerId: string,
  viewerId: string,
  granularity: "hourly" | "weekly",
): Promise<LatestAggRow | null> {
  const db = sql();

  if (granularity === "hourly") {
    const rows = await db<{
      hour_bucket: string;
      cost_millicents: string | number;
      tokens_input: string | number;
      tokens_output: string | number;
      event_count: string | number;
      source: string;
      model: string;
    }[]>`
      SELECT
        hour_bucket,
        COALESCE(SUM(cost_millicents), 0)::bigint  AS cost_millicents,
        COALESCE(SUM(tokens_input),    0)::bigint  AS tokens_input,
        COALESCE(SUM(tokens_output),   0)::bigint  AS tokens_output,
        COALESCE(SUM(event_count),     0)::int     AS event_count,
        COALESCE(source, '')                       AS source,
        COALESCE(model,  '')                       AS model
      FROM peer_share_hourly_aggregate
      WHERE owner_id  = ${ownerId}::uuid
        AND viewer_id = ${viewerId}::uuid
        AND hour_bucket = (
          SELECT MAX(hour_bucket)
          FROM peer_share_hourly_aggregate
          WHERE owner_id  = ${ownerId}::uuid
            AND viewer_id = ${viewerId}::uuid
        )
      GROUP BY hour_bucket, source, model
    `;

    if (rows.length === 0) return null;

    const bucketStart = rows[0].hour_bucket;
    let totalCost = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalEvents = 0;

    const byModel: Record<string, { cost_millicents: number; tokens_input: number; tokens_output: number }> = {};
    const bySource: Record<string, { cost_millicents: number; tokens_input: number; tokens_output: number }> = {};

    for (const r of rows) {
      const cost = Number(r.cost_millicents ?? 0);
      const tIn  = Number(r.tokens_input ?? 0);
      const tOut = Number(r.tokens_output ?? 0);
      const ev   = Number(r.event_count ?? 0);

      totalCost       += cost;
      totalTokensIn   += tIn;
      totalTokensOut  += tOut;
      totalEvents     += ev;

      const model = String(r.model || "");
      if (model) {
        if (!byModel[model]) byModel[model] = { cost_millicents: 0, tokens_input: 0, tokens_output: 0 };
        byModel[model].cost_millicents += cost;
        byModel[model].tokens_input    += tIn;
        byModel[model].tokens_output   += tOut;
      }

      const source = String(r.source || "");
      if (source) {
        if (!bySource[source]) bySource[source] = { cost_millicents: 0, tokens_input: 0, tokens_output: 0 };
        bySource[source].cost_millicents += cost;
        bySource[source].tokens_input    += tIn;
        bySource[source].tokens_output   += tOut;
      }
    }

    return {
      bucket_start: bucketStart,
      cost_millicents: totalCost,
      tokens_input: totalTokensIn,
      tokens_output: totalTokensOut,
      event_count: totalEvents,
      duration_ms: 0, // hourly aggregate does not track duration
      by_model: Object.keys(byModel).length > 0 ? byModel : null,
      by_source: Object.keys(bySource).length > 0 ? bySource : null,
      by_language: null,
    };
  }

  // Weekly granularity — read from peer_share_weekly_aggregate.
  const weekRows = await db<{
    week_start_iso: string;
    field: string;
    value: string | number;
  }[]>`
    SELECT
      week_start_iso,
      field,
      value
    FROM peer_share_weekly_aggregate
    WHERE owner_id  = ${ownerId}::uuid
      AND viewer_id = ${viewerId}::uuid
      AND week_start_iso = (
        SELECT MAX(week_start_iso)
        FROM peer_share_weekly_aggregate
        WHERE owner_id  = ${ownerId}::uuid
          AND viewer_id = ${viewerId}::uuid
      )
    ORDER BY field
  `;

  if (weekRows.length === 0) return null;

  const bucketStart = weekRows[0].week_start_iso;
  const fieldMap: Record<string, number> = {};
  for (const r of weekRows) {
    fieldMap[r.field] = Number(r.value ?? 0);
  }

  return {
    bucket_start: bucketStart,
    cost_millicents: fieldMap["cost_millicents"] ?? 0,
    tokens_input:    fieldMap["tokens_input"]    ?? 0,
    tokens_output:   fieldMap["tokens_output"]   ?? 0,
    event_count:     fieldMap["event_count"]     ?? 0,
    duration_ms:     0,
    by_model:        null,
    by_source:       null,
    by_language:     null,
  };
}

// ---------------------------------------------------------------------------
// Process one subscriber
// ---------------------------------------------------------------------------

async function processSubscriber(
  sub: PeerShareSubscriberRow,
  secret: string | null,
): Promise<{ ok: boolean; error?: string }> {
  // Verify grant is still active.
  const grants = await listGrantsForViewer(sub.viewer_id);
  const grant = grants.find((g) => g.owner_id === sub.owner_id);
  if (!grant) {
    return { ok: false, error: "grant revoked or not found — skipping" };
  }

  // Fetch latest aggregate.
  const agg = await fetchLatestAggregate(sub.owner_id, sub.viewer_id, sub.granularity);
  if (!agg) {
    // No data yet — not an error, just skip.
    return { ok: true };
  }

  // Build signed aggregate delta (privacy floor enforced by buildAggregateDelta).
  const delta = buildAggregateDelta(
    sub.granularity,
    sub.owner_id,
    sub.viewer_id,
    agg.bucket_start,
    {
      cost_millicents: agg.cost_millicents,
      tokens_input:    agg.tokens_input,
      tokens_output:   agg.tokens_output,
      event_count:     agg.event_count,
      duration_ms:     agg.duration_ms > 0 ? agg.duration_ms : undefined,
    },
    {
      by_model:    agg.by_model    ?? undefined,
      by_source:   agg.by_source   ?? undefined,
      by_language: agg.by_language ?? undefined,
    },
    grant.fields,
  );

  // Deliver via HTTPS POST.
  const result = await broadcastPeerShareAggregate(sub.webhook_url, delta, secret);

  if (result.ok) {
    await markSubscriberDelivered(sub.id, sub.granularity);
    return { ok: true };
  } else {
    await markSubscriberFailed(sub.id);
    return { ok: false, error: result.error ?? `HTTP ${result.status}` };
  }
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.PULSE_CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "PULSE_CRON_SECRET not configured" },
      { status: 500 },
    );
  }

  const supplied = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  log.info({ msg: "cron: peer-share-subscribe-push starting" });

  const due = await listDueSubscribers();

  let delivered = 0;
  let skipped   = 0;
  let failed    = 0;
  const errors: string[] = [];

  await Promise.all(
    due.map(async (sub) => {
      try {
        const result = await processSubscriber(sub, expected);
        if (result.ok) {
          delivered++;
        } else if (result.error?.startsWith("grant revoked")) {
          skipped++;
        } else {
          failed++;
          if (result.error) errors.push(`${sub.id}: ${result.error}`);
        }
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${sub.id}: ${msg}`);
        log.error({
          msg: "cron: peer-share-subscribe-push subscriber threw",
          subscriber_id: sub.id,
          err: msg,
        });
      }
    }),
  );

  const elapsed_ms = Date.now() - startedAt;
  log.info({
    msg: "cron: peer-share-subscribe-push done",
    elapsed_ms,
    subscribers_due: due.length,
    delivered,
    skipped,
    failed,
  });

  return NextResponse.json({
    ok: true,
    elapsed_ms,
    subscribers_due: due.length,
    delivered,
    skipped,
    failed,
    errors,
  });
}
