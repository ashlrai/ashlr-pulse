/**
 * POST /api/cron/peer-share-hourly-refresh — hourly materialisation of
 * peer-share activity into peer_share_hourly_aggregate.
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env), identical
 * to all other /api/cron/* routes. Internal endpoint only.
 *
 * Per run (fired hourly by Vercel / Railway cron):
 *   1. Calls runHourlyAggregateCron() which:
 *      a. Finds every active (non-revoked) peer_share grant.
 *      b. Upserts peer_share_hourly_aggregate rows covering the last 72 h per
 *         (owner, viewer, hour_bucket, source, model).
 *         INSERT…ON CONFLICT DO UPDATE — idempotent, safe to re-run.
 *      c. Prunes rows older than HOURLY_RETENTION_HRS (72 h).
 *   2. Returns aggregate counts (pairs, rows upserted/pruned).
 *
 * Per-pair errors are swallowed so a single bad pair doesn't abort the full
 * sweep. The structured log captures per-pair failure details.
 *
 * Privacy floor: only aggregate metadata (costs, tokens, event counts) is
 * stored — no prompts, completions, code, diffs, or raw OTel spans.
 */

import { NextResponse } from "next/server";
import { runHourlyAggregateCron } from "@/lib/peer-share-hourly-aggregate";
import { log } from "@/lib/logger";
import { safeEqual } from "@/lib/timing-safe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — may iterate many active pairs

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.PULSE_CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "PULSE_CRON_SECRET not configured" },
      { status: 500 },
    );
  }

  // Constant-time compare — prevents timing-based secret recovery.
  const supplied = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  log.info({ msg: "cron: peer-share-hourly-refresh starting" });

  const result = await runHourlyAggregateCron();

  const elapsed_ms = Date.now() - startedAt;
  log.info({
    msg: "cron: peer-share-hourly-refresh done",
    elapsed_ms,
    pairs: result.pairs,
    rows_upserted: result.rowsUpserted,
    rows_pruned: result.rowsPruned,
  });

  return NextResponse.json({
    ok: true,
    elapsed_ms,
    pairs: result.pairs,
    rows_upserted: result.rowsUpserted,
    rows_pruned: result.rowsPruned,
  });
}
