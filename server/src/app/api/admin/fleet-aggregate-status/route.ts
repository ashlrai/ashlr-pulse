/**
 * GET /api/admin/fleet-aggregate-status
 *
 * Returns the last-computed timestamp and lag for fleet_daily_aggregate rows,
 * per org (for orgs with at least one aggregate row) plus a global summary.
 *
 * Auth: PULSE_CRON_SECRET in the `x-admin-secret` header (same secret as the
 * cron routes — admin-only, constant-time compared). This endpoint is not
 * user-facing; it's for ops dashboards and alert checks.
 *
 * Response shape:
 * {
 *   ok: true,
 *   global_lag_hours: number | null,   // hours since the most recent computed_at across all orgs
 *   orgs: [
 *     { org_id: string, last_computed_at: string, row_count: number, lag_hours: number }
 *   ]
 * }
 *
 * Privacy floor: only aggregate metadata — org ids (UUIDs), timestamps,
 * row counts, lag. No user data, proposals, or code.
 */

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { globalAggregatesLagHours } from "@/lib/fleet-aggregate-refresh";
import { safeEqual } from "@/lib/timing-safe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface OrgStatusRow {
  org_id: string;
  last_computed_at: string;
  row_count: number;
  lag_hours: number;
}

export async function GET(req: Request): Promise<Response> {
  const expected = process.env.PULSE_CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "PULSE_CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  const supplied = req.headers.get("x-admin-secret") ?? "";
  if (!safeEqual(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = sql();

  const [orgRows, globalLagHours] = await Promise.all([
    db<OrgStatusRow[]>`
      SELECT
        org_id::text                                                    AS org_id,
        MAX(computed_at)::text                                          AS last_computed_at,
        COUNT(*)::int                                                   AS row_count,
        ROUND(
          EXTRACT(EPOCH FROM (NOW() - MAX(computed_at))) / 3600.0, 1
        )::float8                                                       AS lag_hours
      FROM fleet_daily_aggregate
      GROUP BY org_id
      ORDER BY lag_hours DESC
    `,
    globalAggregatesLagHours(),
  ]);

  return NextResponse.json({
    ok: true,
    global_lag_hours: globalLagHours,
    orgs: orgRows.map((r) => ({
      org_id: r.org_id,
      last_computed_at: r.last_computed_at,
      row_count: Number(r.row_count),
      lag_hours: Number(r.lag_hours),
    })),
  });
}
