/**
 * POST /api/cron/peer-share-refresh — nightly peer-share aggregate refresh
 * (02:00 UTC).
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env), identical
 * to /api/cron/oversight and /api/cron/fleet-daily. Internal endpoint; not
 * user-facing.
 *
 * Per run:
 *   1. Calls runPeerShareAggregatesCron() which:
 *      a. Finds every active (non-revoked) peer_share grant.
 *      b. Upserts one peer_share_daily_aggregate row per (owner, viewer,
 *         day, source, model) for the last 30 calendar days — INSERT…ON
 *         CONFLICT so re-runs are safe.
 *      c. Prunes rows older than 30 days (RETENTION_DAYS in the lib).
 *   2. Returns aggregate counts (pairs processed, rows upserted/pruned).
 *
 * Idempotent: safe to trigger manually or re-run. Each invocation recomputes
 * and upserts the last 30 days per pair — no data is lost on re-run.
 *
 * Per-pair errors are swallowed inside runPeerShareAggregatesCron (best-effort);
 * this route returns 200 even on partial failure so the cron caller doesn't
 * retry the full sweep due to one bad pair. The structured log captures details.
 *
 * Scheduled: cron.ts — "peer-share-refresh" tick, daily at 02:00 UTC
 * (offset from fleet-daily at 01:00 so they don't overlap).
 */

import { NextResponse } from "next/server";
import { runPeerShareAggregatesCron } from "@/lib/peer-share-aggregate-refresh";
import { log } from "@/lib/logger";
import { safeEqual } from "@/lib/timing-safe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes — could be many active pairs

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.PULSE_CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "PULSE_CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  // Constant-time compare: a plain !== short-circuits and leaks the secret
  // byte-by-byte to an attacker measuring response timing.
  const supplied = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  log.info({ msg: "cron: peer-share-refresh starting" });

  const result = await runPeerShareAggregatesCron();

  const elapsed_ms = Date.now() - startedAt;
  log.info({
    msg: "cron: peer-share-refresh done",
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
