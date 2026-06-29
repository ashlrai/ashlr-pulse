/**
 * POST /api/cron/fleet-daily — daily fleet aggregate refresh (01:00 UTC).
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env), identical
 * to /api/cron/oversight and /api/cron/digest. Internal endpoint; not
 * user-facing.
 *
 * Per run:
 *   1. Calls runFleetAggregatesCron() which:
 *      a. Finds every org with fleet activity in the last 30 days.
 *      b. Upserts one fleet_daily_aggregate row per (org, day) for the
 *         last 30 calendar days — INSERT…ON CONFLICT so re-runs are safe.
 *      c. Prunes rows older than 90 days (RETENTION_DAYS in the lib).
 *   2. Returns aggregate counts (orgs processed, rows upserted/pruned).
 *
 * Idempotent: safe to trigger manually or re-run. Each invocation recomputes
 * and upserts the last 30 days per org — no data is lost on re-run.
 *
 * Per-org errors are swallowed inside runFleetAggregatesCron (best-effort);
 * this route returns 200 even on partial failure so the cron caller doesn't
 * retry the full sweep due to one bad org. The structured log captures details.
 *
 * Scheduled: vercel.json / Railway cron — "0 1 * * *" (01:00 UTC daily).
 * In-process: registered in lib/cron.ts (startBackgroundCron) alongside the
 * oversight and digest ticks.
 */

import { NextResponse } from "next/server";
import { runFleetAggregatesCron } from "@/lib/fleet-aggregate-refresh";
import { log } from "@/lib/logger";
import { safeEqual } from "@/lib/timing-safe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // up to 5 minutes for large fleets

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
  log.info({ msg: "cron: fleet-daily starting" });

  const result = await runFleetAggregatesCron();

  const elapsed_ms = Date.now() - startedAt;
  log.info({
    msg: "cron: fleet-daily done",
    elapsed_ms,
    orgs: result.orgs,
    rows_upserted: result.rowsUpserted,
    rows_pruned: result.rowsPruned,
  });

  // Aggregate counts only — no org ids in the HTTP body (see oversight/route.ts).
  return NextResponse.json({
    ok: true,
    elapsed_ms,
    orgs: result.orgs,
    rows_upserted: result.rowsUpserted,
    rows_pruned: result.rowsPruned,
  });
}
