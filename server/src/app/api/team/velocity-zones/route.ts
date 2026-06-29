/**
 * /api/team/velocity-zones?org_id=X
 *
 * Returns the team velocity profile for the caller's org:
 *   • overlapHours — hours where co-founders are both active
 *   • highProductivityWindow — e.g. "10:00–15:00 UTC"
 *   • recommendation — human-readable pairing advice
 *   • userPreference — the caller's saved preferred_hours (or null)
 *
 * Auth: cookie-session via currentUser().
 * Org gate: caller must be a member of the requested org (or their primary
 * org when org_id is omitted).
 *
 * Privacy floor: only aggregate cost/event counts per hour/user are returned.
 * Individual events never leave the server.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser } from "@/lib/org-db";
import { sql } from "@/lib/db";
import { profileTeamVelocity, type AggregateInput } from "@/lib/team-velocity-profiler";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const orgIdParam = searchParams.get("org_id");

  // Resolve the org — use the requested one if the caller is a member,
  // else fall back to the caller's primary org.
  const db = sql();

  let orgId: string | null = orgIdParam;
  if (orgId) {
    // Verify membership.
    const [membership] = await db<{ org_id: string }[]>`
      SELECT org_id::text FROM membership
      WHERE org_id = ${orgId}::uuid AND user_id = ${me.id}::uuid
      LIMIT 1
    `.catch(() => [] as { org_id: string }[]);
    if (!membership) {
      return NextResponse.json({ error: "org not found or access denied" }, { status: 403 });
    }
  } else {
    const org = await primaryOrgForUser(me.id);
    orgId = org?.id ?? null;
  }

  if (!orgId) {
    return NextResponse.json({ error: "no org found" }, { status: 404 });
  }

  // Load all members of the org.
  const members = await db<{ user_id: string }[]>`
    SELECT user_id::text FROM membership WHERE org_id = ${orgId}::uuid
  `.catch(() => [] as { user_id: string }[]);

  const memberIds = members.map((m) => m.user_id);

  if (memberIds.length < 2) {
    return NextResponse.json({
      overlapHours: [],
      highProductivityWindow: "not enough data",
      recommendation: "Add more team members to Pulse to see pairing recommendations.",
      zones: [],
      userPreference: null,
    });
  }

  // Pull 30 days of peer_share_daily_aggregate rows for all member pairs
  // where the owner is a member of this org. We aggregate across all peer
  // grants to capture the fullest picture of each user's activity pattern.
  // Privacy floor: only cost_millicents + event_count per (owner, date).
  const WINDOW_DAYS = 30;
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

  const rows = await db<{
    owner_id: string;
    date: string;
    cost_millicents: string | number;
    event_count: string | number;
  }[]>`
    SELECT
      owner_id::text AS owner_id,
      date::text     AS date,
      SUM(cost_millicents)::bigint AS cost_millicents,
      SUM(event_count)::int        AS event_count
    FROM peer_share_daily_aggregate
    WHERE owner_id = ANY(${memberIds}::uuid[])
      AND date >= ${cutoff}::date
    GROUP BY owner_id, date
    ORDER BY owner_id, date
  `.catch(() => [] as { owner_id: string; date: string; cost_millicents: string | number; event_count: string | number }[]);

  const aggregates: AggregateInput[] = rows.map((r) => ({
    ownerId: r.owner_id,
    date: r.date,
    costMillicents: Number(r.cost_millicents ?? 0),
    eventCount: Number(r.event_count ?? 0),
  }));

  const profile = profileTeamVelocity(aggregates, WINDOW_DAYS);

  // Load the caller's saved preference (if any).
  const [prefRow] = await db<{ preferred_hours: string[] }[]>`
    SELECT preferred_hours FROM team_pairing_preference
    WHERE org_id = ${orgId}::uuid AND user_id = ${me.id}::uuid
    LIMIT 1
  `.catch(() => [] as { preferred_hours: string[] }[]);

  return NextResponse.json({
    overlapHours: profile.overlaps.map((o) => ({
      hour: o.hour,
      dayOfWeek: o.dayOfWeek,
      prob: Math.round(o.prob * 100) / 100,
      costPerHour: o.costPerHour,
    })),
    highProductivityWindow: profile.highProductivityWindow,
    recommendation: profile.recommendation,
    zones: profile.zones,
    userPreference: prefRow?.preferred_hours ?? null,
  });
}

export async function POST(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as Record<string, unknown>).preferred_hours)
  ) {
    return NextResponse.json(
      { error: "preferred_hours must be an array of HH:00 strings" },
      { status: 400 },
    );
  }

  const rawHours = (body as { preferred_hours: unknown[] }).preferred_hours;
  // Validate each entry is a valid "HH:00" format (00:00–23:00).
  const HOUR_RE = /^([01]\d|2[0-3]):00$/;
  const validHours = rawHours.filter(
    (h): h is string => typeof h === "string" && HOUR_RE.test(h),
  );

  const { searchParams } = new URL(req.url);
  const orgIdParam = searchParams.get("org_id");

  const db = sql();
  let orgId: string | null = orgIdParam;
  if (!orgId) {
    const org = await primaryOrgForUser(me.id);
    orgId = org?.id ?? null;
  }
  if (!orgId) {
    return NextResponse.json({ error: "no org found" }, { status: 404 });
  }

  // Verify membership.
  const [membership] = await db<{ org_id: string }[]>`
    SELECT org_id::text FROM membership
    WHERE org_id = ${orgId}::uuid AND user_id = ${me.id}::uuid
    LIMIT 1
  `.catch(() => [] as { org_id: string }[]);
  if (!membership) {
    return NextResponse.json({ error: "org not found or access denied" }, { status: 403 });
  }

  await db`
    INSERT INTO team_pairing_preference (org_id, user_id, preferred_hours, updated_at)
    VALUES (${orgId}::uuid, ${me.id}::uuid, ${validHours}, NOW())
    ON CONFLICT (org_id, user_id) DO UPDATE SET
      preferred_hours = EXCLUDED.preferred_hours,
      updated_at      = EXCLUDED.updated_at
  `;

  return NextResponse.json({ ok: true, preferred_hours: validHours });
}
