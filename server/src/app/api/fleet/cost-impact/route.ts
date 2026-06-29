/**
 * GET /api/fleet/cost-impact
 *
 * Returns peer-safe team cost metrics for the fleet cost-impact dashboard.
 *
 * Response shape: OrgCostImpact (from fleet-cost-impact.ts)
 *   • users[]             — per-user rolling 7d cost, cost/event, cost/token,
 *                           daily avg, 7-day sparkline series
 *   • teamAvgDailyMillicents — org-wide average daily cost in millicents
 *   • modelDrift[]        — model share this week vs last week
 *   • computedAt          — ISO-8601 timestamp
 *
 * Auth: requires a valid Supabase session. The caller must be a member of
 * the resolved org.
 *
 * Privacy floor: all fields are aggregate numeric — no prompts, completions,
 * code, diffs, or raw spans. Reads only from peer_share_daily_aggregate,
 * which is already gated by active peer_share grants at write time.
 *
 * Query params:
 *   ?win=7|14|30  — rolling window in days (default: 7, max: 30)
 */

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser } from "@/lib/org-db";
import { loadOrgCostImpact } from "@/lib/fleet-cost-impact";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WIN = 30;
const DEFAULT_WIN = 7;

function resolveWindow(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_WIN;
  return Math.min(n, MAX_WIN);
}

export async function GET(req: NextRequest): Promise<Response> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  let me;
  try {
    me = await currentUser();
  } catch (err) {
    log.warn({ msg: "fleet/cost-impact: currentUser threw", error: String(err) });
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }

  if (!me) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ── 2. Resolve org ────────────────────────────────────────────────────────
  let org;
  try {
    org = await primaryOrgForUser(me.id);
  } catch (err) {
    log.warn({ msg: "fleet/cost-impact: primaryOrgForUser threw", error: String(err) });
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }

  if (!org) {
    return NextResponse.json(
      { error: "no org found — complete onboarding first" },
      { status: 403 },
    );
  }

  // ── 3. Parse window ───────────────────────────────────────────────────────
  const win = resolveWindow(req.nextUrl.searchParams.get("win"));

  // ── 4. Load aggregates ────────────────────────────────────────────────────
  let impact;
  try {
    impact = await loadOrgCostImpact(org.id, win);
  } catch (err) {
    log.warn({
      msg: "fleet/cost-impact: loadOrgCostImpact threw",
      orgId: org.id,
      error: String(err),
    });
    return NextResponse.json({ error: "failed to load cost impact data" }, { status: 500 });
  }

  return NextResponse.json(impact);
}
