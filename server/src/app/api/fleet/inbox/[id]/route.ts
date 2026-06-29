/**
 * POST /api/fleet/inbox/[id] — operator action on a single fleet command.
 *
 * Body: { action: "cancel" }. Cancels a still-PENDING command before the
 * daemon claims it (transitions pending → failed, error="cancelled by
 * operator"). Race-safe: if the daemon claims the row first, the cancel
 * no-ops and we return 409 so the UI reflects that it's already in flight.
 *
 * Auth: session cookie via currentUser(). Org-scoped — a user can only cancel
 * commands in their own org (cancelPending filters on org_id).
 * Plan gate: Pro/Team (map_enabled).
 *
 * Privacy floor: returns only the metadata-shaped FleetCommand (no payload).
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser } from "@/lib/org-db";
import { limitsFor } from "@/lib/plan-gate";
import { cancelPending, getCommand } from "@/lib/fleet-inbox-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
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
      { error: "upgrade to Pro to manage the fleet inbox", upgrade: true },
      { status: 402 },
    );
  }

  const { id } = await ctx.params;

  let action: unknown;
  try {
    action = (await req.json())?.action;
  } catch {
    action = undefined;
  }
  if (action !== "cancel") {
    return NextResponse.json(
      { error: "unsupported action (only 'cancel' is supported)" },
      { status: 400 },
    );
  }

  const cancelled = await cancelPending(org.id, id);
  if (cancelled) {
    return NextResponse.json({ command: cancelled });
  }

  // Nothing transitioned: either the row isn't in this org, or it's no longer
  // pending (daemon claimed it first / already terminal). Disambiguate so the
  // UI can show the right message.
  const existing = await getCommand(org.id, id);
  if (!existing) {
    return NextResponse.json({ error: "command not found" }, { status: 404 });
  }
  return NextResponse.json(
    { error: `command is '${existing.status}', no longer cancellable`, command: existing },
    { status: 409 },
  );
}
