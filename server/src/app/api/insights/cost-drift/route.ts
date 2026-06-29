/**
 * GET /api/insights/cost-drift
 *
 * Returns cross-source cost attribution + model preference drift for the
 * authenticated user's primary org over the last 28 days (split into two
 * consecutive 14-day windows for WoW comparison).
 *
 * Response shape:
 *   {
 *     sourceShift: { cursor: +12, claude_code: -8, ... },
 *     modelShift:  { opus: -2, sonnet: +5, ... },
 *     predictedDrift7d: { cursor: { byDay: [...], slope, rSquared }, ... },
 *     recommendation: "Cursor adoption +12% WoW…",
 *     anomalousShifts: [{ key, kind, pct }, …],
 *     meta: { windowDays: 14, totalPrevMillicents, totalCurrMillicents, computedAt }
 *   }
 *
 * Auth: current Supabase session (same pattern as /app page). Returns 401 when
 * unauthenticated. Returns 200 with empty drift when insufficient history.
 *
 * Privacy floor: only aggregates + source/model enums — no prompts,
 * completions, code, or PII reach this route.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { sql } from "@/lib/db";
import {
  detectCostDrift,
  splitWindows,
  totalCostMillicents,
  type DailyAggregate,
} from "@/lib/cost-drift-detector";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Number of calendar days to fetch (two 14-day windows). */
const WINDOW_DAYS = 28;

export async function GET(): Promise<Response> {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const db = sql();

    // Load 28 days of daily aggregates from activity_event grouped by
    // (date, source, model). Privacy: we select only aggregate metrics —
    // no prompts, completions, repo names, or user content.
    const rows = await db<{
      date: string;
      source: string;
      model: string;
      cost_millicents: string | number;
      event_count: string | number;
    }[]>`
      SELECT
        DATE(ts AT TIME ZONE 'UTC')::text              AS date,
        COALESCE(source, '')                           AS source,
        COALESCE(model, '')                            AS model,
        COALESCE(SUM(cost_millicents), 0)::bigint      AS cost_millicents,
        COUNT(*)::int                                  AS event_count
      FROM activity_event
      WHERE user_id   = ${me.id}::uuid
        AND ts       >= NOW() - INTERVAL '${WINDOW_DAYS} days'
        AND ts        < NOW()
      GROUP BY DATE(ts AT TIME ZONE 'UTC'), source, model
      ORDER BY date ASC
    `;

    const aggregates: DailyAggregate[] = rows.map((r) => ({
      date:            r.date,
      source:          r.source,
      model:           r.model,
      cost_millicents: Number(r.cost_millicents ?? 0),
      event_count:     Number(r.event_count ?? 0),
    }));

    const { prev14d, curr14d } = splitWindows(aggregates);
    const drift = detectCostDrift(prev14d, curr14d);

    return NextResponse.json({
      ...drift,
      meta: {
        windowDays:            14,
        totalPrevMillicents:   totalCostMillicents(prev14d),
        totalCurrMillicents:   totalCostMillicents(curr14d),
        computedAt:            new Date().toISOString(),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ msg: "insights/cost-drift: query failed", user_id: me.id, err: msg });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
