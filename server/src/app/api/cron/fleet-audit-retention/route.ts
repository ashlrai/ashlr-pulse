/**
 * POST /api/cron/fleet-audit-retention — 90-day audit log retention sweep.
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env), identical
 * to /api/cron/fleet-daily, /api/cron/oversight, and /api/cron/digest.
 * Internal endpoint; not user-facing.
 *
 * Per run:
 *   1. Deletes activity_event rows WHERE source='ashlr-fleet' AND
 *      fleet_event IN ('proposal','merge','decline') AND ts < (NOW - 90 days).
 *      Non-fleet and non-lifecycle rows are never touched.
 *   2. Deletes fleet_command rows in terminal state (done/failed) whose
 *      completed_at/created_at < (NOW - 90 days). Pending/claimed rows are
 *      never pruned — they may still be in flight.
 *   3. Returns aggregate delete counts (no row ids, no org ids).
 *
 * Idempotent: safe to trigger manually or re-run. Each invocation only deletes
 * rows that are already past the 90-day window — no data within the retention
 * window is ever removed.
 *
 * Scheduled: "0 2 * * *" (02:00 UTC daily, 1 hour after fleet-daily).
 */

import { NextResponse } from "next/server";
import { deleteOldAuditRows, AUDIT_RETENTION_DAYS } from "@/lib/fleet-audit-export";
import { log } from "@/lib/logger";
import { safeEqual } from "@/lib/timing-safe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.PULSE_CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "PULSE_CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  // Constant-time compare — same pattern as every other cron route.
  const supplied = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  log.info({
    msg: "cron: fleet-audit-retention starting",
    retention_days: AUDIT_RETENTION_DAYS,
  });

  const result = await deleteOldAuditRows();

  const elapsed_ms = Date.now() - startedAt;
  log.info({
    msg: "cron: fleet-audit-retention done",
    elapsed_ms,
    deleted_events: result.deletedEvents,
    deleted_commands: result.deletedCommands,
    retention_days: AUDIT_RETENTION_DAYS,
  });

  return NextResponse.json({
    ok: true,
    elapsed_ms,
    retention_days: AUDIT_RETENTION_DAYS,
    deleted_events: result.deletedEvents,
    deleted_commands: result.deletedCommands,
  });
}
