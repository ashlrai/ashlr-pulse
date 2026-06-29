/**
 * GET /api/fleet/inbox — the operator's fleet_command queue + status counts.
 *
 * Backs the self-refreshing FleetInbox client card. Returns a small JSON
 * payload { commands, counts } — newest-first commands plus per-status badge
 * counts for the org.
 *
 * Auth: session cookie via currentUser().
 * Plan gate: Pro/Team (same map_enabled gate as the rest of the fleet surface).
 *
 * Privacy floor: metadata only — kind, target, status, timestamps, claimer id,
 * short error. Command payload/result bags are NOT included (not needed for
 * queue triage, and content-bearing fields are never surfaced).
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser } from "@/lib/org-db";
import { limitsFor } from "@/lib/plan-gate";
import { listForOrg, countsByStatus } from "@/lib/fleet-inbox-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const org = await primaryOrgForUser(me.id);
  if (!org) {
    return NextResponse.json({ error: "no org" }, { status: 403 });
  }
  if (!limitsFor(org).map_enabled) {
    return NextResponse.json(
      { error: "upgrade to Pro to use the fleet inbox", upgrade: true },
      { status: 402 },
    );
  }

  const [commands, counts] = await Promise.all([
    listForOrg(org.id),
    countsByStatus(org.id),
  ]);

  return NextResponse.json({ commands, counts });
}
