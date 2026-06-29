/**
 * POST /api/cron/peer-share-dimensional-agg — hourly materialisation of
 * cross-dimensional peer-share aggregates into three daily tables:
 *   • peer_share_daily_agg_by_model
 *   • peer_share_daily_agg_by_source
 *   • peer_share_daily_agg_by_language
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env) —
 * identical to all other /api/cron/* routes. Internal endpoint only.
 *
 * Schedule: runs after peer-share-hourly-agg (e.g. "10 * * * *", 10 past
 * each hour UTC) so the hourly aggregate rows are fresh before we roll them
 * up into daily dimensional buckets.
 *
 * Per run:
 *   1. Loads every active (non-revoked) peer_share grant.
 *   2. For each grant × each date in the last 30 days:
 *      a. Reads peer_share_hourly_aggregate (model + source) and
 *         activity_event (language) for that day.
 *      b. Upserts rows into the three dimension tables
 *         (INSERT … ON CONFLICT DO UPDATE — idempotent).
 *   3. Prunes rows older than 30 days from all three dimension tables.
 *   4. Per-pair/bucket errors are swallowed; error list is returned in the
 *      response body so callers can alert on non-empty errors[].
 *
 * Privacy floor: metadata only — counts, costs, source enums, model names,
 * language tags. No prompts, completions, code, diffs, or raw spans.
 */

import { NextResponse } from "next/server";
import { runDimensionalAggCron } from "@/lib/peer-share-dimensional-agg";
import { log } from "@/lib/logger";
import { safeEqual } from "@/lib/timing-safe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — iterates many pairs × 30 buckets

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
  log.info({ msg: "cron: peer-share-dimensional-agg starting" });

  const result = await runDimensionalAggCron();

  const elapsed_ms = Date.now() - startedAt;
  log.info({
    msg: "cron: peer-share-dimensional-agg done",
    elapsed_ms,
    pairs: result.pairs,
    buckets_processed: result.bucketsProcessed,
    rows_upserted: result.rowsUpserted,
    errors: result.errors.length,
  });

  // Aggregate counts only — no pair IDs in the response (cron callers log
  // response bodies; we must not leak share IDs into external log streams).
  return NextResponse.json({
    ok: true,
    elapsed_ms,
    pairs: result.pairs,
    buckets_processed: result.bucketsProcessed,
    rows_upserted: result.rowsUpserted,
    // Include non-empty error list so callers can alert, but cap to 50 to
    // avoid unbounded response sizes.
    errors: result.errors.slice(0, 50),
  });
}
