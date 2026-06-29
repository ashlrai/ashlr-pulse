/**
 * POST /api/cron/peer-share-hourly-agg — hourly materialisation of
 * peer-share activity into peer_share_hourly_aggregate + webhook push.
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env) —
 * identical to all other /api/cron/* routes. Internal endpoint only.
 *
 * Per run (fired hourly by Vercel / Railway cron at :05 past each hour):
 *   1. Loads every active (non-revoked) peer_share grant joined to the
 *      owner's org.peer_share_webhook_url.
 *   2. For each grant:
 *      a. Aggregates activity_event rows for the previous full hour bucket
 *         into peer_share_hourly_aggregate
 *         (INSERT … ON CONFLICT DO UPDATE — idempotent).
 *      b. If cost_millicents > 0 AND a webhook URL is configured:
 *         POSTs a sanitised JSON payload signed with
 *         HMAC-SHA256(PULSE_CRON_SECRET, body) to the endpoint.
 *         Retries on 5xx up to 3 times with exponential backoff
 *         (same pattern as fleet-scorecard-webhook.ts).
 *   3. Per-pair errors are swallowed so the cron caller doesn't retry
 *      the full sweep for one bad pair.
 *
 * Payload privacy floor (enforced by sanitisePayload in peer-share-agg.ts):
 *   repo_name / model are only included when present in grant.fields.
 *   No prompts, completions, code, diffs, or raw spans — ever.
 *
 * Schedule: "5 * * * *" (5 past every hour UTC).
 */

import { NextResponse } from "next/server";
import { runPeerShareHourlyAgg } from "@/lib/peer-share-agg";
import { log } from "@/lib/logger";
import { safeEqual } from "@/lib/timing-safe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — may iterate many pairs

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.PULSE_CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "PULSE_CRON_SECRET not configured" },
      { status: 500 },
    );
  }

  // Constant-time compare — same pattern as all other cron routes.
  const supplied = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  log.info({ msg: "cron: peer-share-hourly-agg starting" });

  const result = await runPeerShareHourlyAgg();

  const elapsed_ms = Date.now() - startedAt;
  log.info({
    msg: "cron: peer-share-hourly-agg done",
    elapsed_ms,
    pairs: result.pairs,
    rows_upserted: result.rowsUpserted,
    webhooks_sent: result.webhooksSent,
    webhooks_failed: result.webhooksFailed,
  });

  // Aggregate counts only — no pair IDs or webhook URLs in the response
  // (cron callers log response bodies; we must not leak endpoint URLs).
  return NextResponse.json({
    ok: true,
    elapsed_ms,
    pairs: result.pairs,
    rows_upserted: result.rowsUpserted,
    webhooks_sent: result.webhooksSent,
    webhooks_failed: result.webhooksFailed,
  });
}
