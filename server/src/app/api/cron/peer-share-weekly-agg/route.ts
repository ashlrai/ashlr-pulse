/**
 * POST /api/cron/peer-share-weekly-agg — weekly materialisation of
 * peer-share activity into peer_share_weekly_aggregate.
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env) —
 * identical to all other /api/cron/* routes. Internal endpoint only.
 *
 * Schedule: Monday 00:05 UTC (after peer-share-hourly-agg completes).
 * This ensures the weekly roll-up has a fresh set of hourly rows to
 * aggregate from before producing the Monday "last week" snapshot.
 *
 * Per run:
 *   1. Loads every active (non-revoked) peer_share grant.
 *   2. For each grant: refreshes the last 8 weeks of weekly aggregates
 *      by summing peer_share_hourly_aggregate rows into weekly buckets.
 *      (INSERT … ON CONFLICT DO UPDATE — idempotent).
 *   3. Per-pair errors are swallowed; the error list is returned in the
 *      response body so the caller can alert on non-empty errors[].
 *
 * Response: { rows_upserted: number, errors: string[] }
 */

import { NextResponse } from "next/server";
import { runWeeklyAggregateCron } from "@/lib/peer-share-weekly-agg";
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
  log.info({ msg: "cron: peer-share-weekly-agg starting" });

  const result = await runWeeklyAggregateCron();

  const elapsed_ms = Date.now() - startedAt;
  log.info({
    msg: "cron: peer-share-weekly-agg done",
    elapsed_ms,
    pairs: result.pairs,
    rows_upserted: result.rowsUpserted,
    errors: result.errors.length,
  });

  return NextResponse.json({
    ok: true,
    elapsed_ms,
    pairs: result.pairs,
    rows_upserted: result.rowsUpserted,
    errors: result.errors,
  });
}
