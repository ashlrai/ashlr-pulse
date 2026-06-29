/**
 * POST /api/cron/anomaly-incident-close
 *
 * Runs every 30 minutes. Auto-closes anomaly_incident rows whose
 * last_seen_at is older than 4 hours (INCIDENT_AUTO_CLOSE_MS) and are
 * still open (closed_at IS NULL).
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env),
 * identical to every other cron route in this project.
 *
 * Per run:
 *   1. Fetch open incidents with last_seen_at < NOW() - 4h.
 *   2. Set closed_at = NOW() on each.
 *   3. Return aggregate close count; no incident ids in response.
 *
 * Idempotent: already-closed incidents are never touched (WHERE closed_at
 * IS NULL guard). Safe to re-run or trigger manually.
 *
 * Retention: closed incidents are kept indefinitely for audit (soft delete
 * via closed_at — no hard DELETE here).
 *
 * Scheduled: every 30 minutes ("* /30 * * * *" — cron expression without the space).
 */

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { safeEqual } from "@/lib/timing-safe";
import { log } from "@/lib/logger";
import { INCIDENT_AUTO_CLOSE_MS } from "@/lib/anomaly-incident-grouping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  // ── Auth ───────────────────────────────────────────────────────────────────
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
  const autoCloseHours = INCIDENT_AUTO_CLOSE_MS / (60 * 60 * 1000);
  log.info({ msg: "cron: anomaly-incident-close starting", auto_close_hours: autoCloseHours });

  const db = sql();

  // Single UPDATE: close all open incidents whose last_seen_at is stale.
  // We use the constant directly as an interval expression so the DB does
  // the arithmetic — no per-row round-trip needed.
  const result = await db<{ closed_count: number }[]>`
    WITH closed AS (
      UPDATE anomaly_incident
      SET    closed_at = NOW()
      WHERE  closed_at IS NULL
        AND  last_seen_at < NOW() - (${autoCloseHours} || ' hours')::interval
      RETURNING id
    )
    SELECT COUNT(*)::int AS closed_count FROM closed
  `;

  const closedCount = Number(result[0]?.closed_count ?? 0);
  const elapsed_ms  = Date.now() - startedAt;

  log.info({
    msg:          "cron: anomaly-incident-close done",
    elapsed_ms,
    closed_count: closedCount,
    auto_close_hours: autoCloseHours,
  });

  return NextResponse.json({
    ok:               true,
    elapsed_ms,
    closed_count:     closedCount,
    auto_close_hours: autoCloseHours,
  });
}
