/**
 * POST /api/cron/peer-share-monthly — monthly peer-share aggregate refresh.
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env) —
 * identical to all other /api/cron/* routes. Internal endpoint only.
 *
 * Schedule: 1st of each month at 00:05 UTC (after midnight UTC so the
 * prior month's activity_event rows are fully landed).
 *
 * Also supports ad-hoc backfill — every run refreshes the last 13 months
 * for all active grants, so missed ticks self-heal automatically.
 *
 * Per run:
 *   1. Loads every active (non-revoked) peer_share grant.
 *   2. For each grant: UPSERTs monthly aggregate rows for the last 13 months,
 *      computing OLS-based trend_flag per row.
 *   3. Prunes rows older than MONTHLY_RETENTION_MONTHS.
 *
 * Per-pair errors are swallowed and surfaced in response.errors[] so callers
 * can alert on non-empty error lists without aborting the full sweep.
 *
 * Privacy floor: only aggregate metadata (costs, tokens, event counts)
 * is computed and stored — no prompts, completions, or raw OTel spans.
 */

import { NextResponse } from "next/server";
import { runMonthlyAggregateCron } from "@/lib/peer-share-monthly-aggregate";
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
  log.info({ msg: "cron: peer-share-monthly starting" });

  const result = await runMonthlyAggregateCron();

  const elapsed_ms = Date.now() - startedAt;
  log.info({
    msg: "cron: peer-share-monthly done",
    elapsed_ms,
    pairs: result.pairs,
    rows_upserted: result.rowsUpserted,
    rows_pruned: result.rowsPruned,
    errors: result.errors.length,
  });

  return NextResponse.json({
    ok: true,
    elapsed_ms,
    pairs: result.pairs,
    rows_upserted: result.rowsUpserted,
    rows_pruned: result.rowsPruned,
    errors: result.errors,
  });
}
