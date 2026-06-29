/**
 * GET /api/fleet/health-rollup — per-org fleet-agent heartbeat rollup.
 *
 * Returns a <2KB JSON array of { agentId, lastHeartbeatSec, isHealthy,
 * proposalQueueDepth, costLastHour } entries, one per active fleet agent
 * seen in the last 24 hours. Designed for the HealthRollup client card
 * which polls this every 5 seconds.
 *
 * Auth: session cookie via currentUser().
 * Plan gate: Pro (same gate as Fleet inbox — map_enabled).
 * Feature flag: PULSE_FLEET_HEALTH=true must be set; returns 404 otherwise
 *   so the feature adds zero ingest or dashboard-load cost when disabled.
 *
 * Privacy floor: metadata only — heartbeat timestamps, pending counts, and
 * aggregated cost. No prompts, completions, code, or diffs ever reach here.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser } from "@/lib/org-db";
import { requirePlan, PlanGateError, limitsFor } from "@/lib/plan-gate";
import { computeAgentHealthRollup } from "@/lib/fleet-oversight";

export const runtime = "nodejs";

export async function GET(_req: Request): Promise<Response> {
  // Feature flag — return 404 when disabled so load paths are unaffected.
  if (process.env.PULSE_FLEET_HEALTH !== "true") {
    return NextResponse.json({ error: "not_enabled" }, { status: 404 });
  }

  const me = await currentUser();
  if (!me) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const org = await primaryOrgForUser(me.id);
  if (!org) {
    return NextResponse.json({ error: "no org" }, { status: 403 });
  }

  // Plan gate: fleet health is a Pro/Team feature.
  try {
    requirePlan(org, "pro");
  } catch (err) {
    if (err instanceof PlanGateError) {
      return NextResponse.json(
        { error: err.message, upgrade: true },
        { status: err.status },
      );
    }
    throw err;
  }
  if (!limitsFor(org).map_enabled) {
    return NextResponse.json(
      { error: "upgrade to Pro to use fleet health", upgrade: true },
      { status: 402 },
    );
  }

  const agents = await computeAgentHealthRollup(org.id);
  return NextResponse.json({ agents });
}
