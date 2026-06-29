/**
 * POST /api/cron/peer-share-hourly — hourly peer-share aggregate refresh
 * + nightly back-fill for the last 72 h.
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env), identical
 * to /api/cron/peer-share-refresh and all other cron routes. Internal only.
 *
 * Scheduling (cron.ts):
 *   - Hourly tick: runs every hour to keep the current bucket fresh.
 *   - Nightly back-fill (same tick): each run refreshes the last 72 h for all
 *     active grants, so missed ticks self-heal automatically.
 *
 * Per run:
 *   1. Calls runHourlyAggregateCron() which:
 *      a. Finds every active (non-revoked) peer_share grant.
 *      b. Upserts one peer_share_hourly_aggregate row per
 *         (owner, viewer, hour_bucket, source, model) for the last 72 h.
 *         INSERT…ON CONFLICT so re-runs are safe (idempotent).
 *      c. Prunes rows older than HOURLY_RETENTION_HRS (72 h).
 *   2. Returns aggregate counts (pairs, rows upserted/pruned).
 *
 * Per-pair errors are swallowed inside runHourlyAggregateCron (best-effort);
 * this route returns 200 even on partial failure so the cron caller doesn't
 * retry the full sweep due to one bad pair.
 *
 * Privacy floor: only aggregate metadata (costs, tokens, event counts) is
 * computed and stored — no prompts, completions, or raw OTel spans.
 */

import { NextResponse } from "next/server";
import { runHourlyAggregateCron } from "@/lib/peer-share-hourly-aggregate";
import { log } from "@/lib/logger";
import { safeEqual } from "@/lib/timing-safe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — could be many active pairs

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
  log.info({ msg: "cron: peer-share-hourly starting" });

  const result = await runHourlyAggregateCron();

  const elapsed_ms = Date.now() - startedAt;
  log.info({
    msg: "cron: peer-share-hourly done",
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
