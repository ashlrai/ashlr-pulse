/**
 * /settings/team-sync — visualize the team velocity heatmap and pick
 * preferred pairing hours.
 *
 * Server component + server action (saves preferred_hours via POST to
 * /api/team/velocity-zones). Shows:
 *   • 24h × 7-day grid heatmap (using the current user's DashboardData.heatmap)
 *   • Team velocity overlap overlay (from /api/team/velocity-zones)
 *   • Drag-select preferred hours (checkboxes rendered as a grid)
 *   • Recommendation text
 *
 * Privacy floor: only aggregate cost/event counts per hour/user are shown.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser } from "@/lib/org-db";
import { sql } from "@/lib/db";
import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { palette, space } from "@/lib/theme";
import { profileTeamVelocity, type AggregateInput } from "@/lib/team-velocity-profiler";

export const dynamic = "force-dynamic";

interface SearchParams { ok?: string; error?: string }

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAYS_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function loadTeamSyncData(userId: string, orgId: string): Promise<{
  heatmap: { dow: number; hour: number; value: number }[];
  profile: Awaited<ReturnType<typeof profileTeamVelocity>>;
  memberCount: number;
  preferredHours: string[];
}> {
  const db = sql();
  const WINDOW_DAYS = 30;

  // Load user's own heatmap from activity_event (last 30 days).
  const heatmapRows = await db<{ dow: number; hour: number; value: number }[]>`
    SELECT
      EXTRACT(DOW FROM ts)::int   AS dow,
      EXTRACT(HOUR FROM ts)::int  AS hour,
      COUNT(*)::int               AS value
    FROM activity_event
    WHERE user_id = ${userId}::uuid
      AND ts >= NOW() - INTERVAL '30 days'
    GROUP BY dow, hour
  `.catch(() => [] as { dow: number; hour: number; value: number }[]);

  // Load member count.
  const [{ count: memberCount }] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM membership WHERE org_id = ${orgId}::uuid
  `.catch(() => [{ count: 1 }]);

  // Load daily aggregates for team velocity.
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const members = await db<{ user_id: string }[]>`
    SELECT user_id::text FROM membership WHERE org_id = ${orgId}::uuid
  `.catch(() => [] as { user_id: string }[]);
  const memberIds = members.map((m) => m.user_id);

  const aggRows = await db<{
    owner_id: string; date: string;
    cost_millicents: string | number; event_count: string | number;
  }[]>`
    SELECT owner_id::text AS owner_id, date::text AS date,
      SUM(cost_millicents)::bigint AS cost_millicents,
      SUM(event_count)::int        AS event_count
    FROM peer_share_daily_aggregate
    WHERE owner_id = ANY(${memberIds}::uuid[])
      AND date >= ${cutoff}::date
    GROUP BY owner_id, date
  `.catch(() => [] as { owner_id: string; date: string; cost_millicents: string | number; event_count: string | number }[]);

  const aggregates: AggregateInput[] = aggRows.map((r) => ({
    ownerId: r.owner_id,
    date: r.date,
    costMillicents: Number(r.cost_millicents ?? 0),
    eventCount: Number(r.event_count ?? 0),
  }));

  // Build heatmap weight for current user.
  const heatmapWeights = Array(24).fill(0);
  for (const row of heatmapRows) heatmapWeights[row.hour] += row.value;

  const heatmapByUser = new Map([[userId, heatmapWeights]]);
  const profile = profileTeamVelocity(aggregates, WINDOW_DAYS, heatmapByUser);

  // Load saved preference.
  const [prefRow] = await db<{ preferred_hours: string[] }[]>`
    SELECT preferred_hours FROM team_pairing_preference
    WHERE org_id = ${orgId}::uuid AND user_id = ${userId}::uuid
    LIMIT 1
  `.catch(() => [] as { preferred_hours: string[] }[]);

  return {
    heatmap: heatmapRows,
    profile,
    memberCount: Number(memberCount),
    preferredHours: prefRow?.preferred_hours ?? [],
  };
}

async function savePreferencesAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const org = await primaryOrgForUser(me.id);
  if (!org) redirect("/settings/team-sync?error=no+org");

  // Collect checked hours from form (checkboxes named "hour_HH").
  const selected: string[] = [];
  for (let h = 0; h < 24; h++) {
    if (formData.get(`hour_${h}`) === "on") {
      selected.push(`${String(h).padStart(2, "0")}:00`);
    }
  }

  const db = sql();
  await db`
    INSERT INTO team_pairing_preference (org_id, user_id, preferred_hours, updated_at)
    VALUES (${org.id}::uuid, ${me.id}::uuid, ${selected}, NOW())
    ON CONFLICT (org_id, user_id) DO UPDATE SET
      preferred_hours = EXCLUDED.preferred_hours,
      updated_at      = EXCLUDED.updated_at
  `;

  revalidatePath("/settings/team-sync");
  redirect("/settings/team-sync?ok=1");
}

export default async function TeamSyncPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const params = await searchParams;
  const org = await primaryOrgForUser(me.id);
  if (!org) {
    redirect("/settings?error=no+org");
  }

  const { heatmap, profile, memberCount, preferredHours } =
    await loadTeamSyncData(me.id, org.id);

  // Build heatmap cell value map for quick lookup.
  const heatmapMax = Math.max(...heatmap.map((r) => r.value), 1);
  const heatmapLookup = new Map<string, number>();
  for (const row of heatmap) {
    heatmapLookup.set(`${row.dow}:${row.hour}`, row.value);
  }

  // Build overlap set for highlight.
  const overlapHours = new Set(profile.overlaps.map((o) => o.hour));
  const highProdHours = new Set(
    profile.zones.filter((z) => z.isHighProductivity).map((z) => z.hour),
  );
  const preferredSet = new Set(
    preferredHours.map((h) => Number.parseInt(h.split(":")[0], 10)),
  );

  return (
    <DashboardShell maxWidth={900}>
      <Header me={me} active="settings" />
      <h1 style={pageTitle}>Team Sync</h1>
      <div style={pageSub}>
        Best pairing windows for your team — based on 30 days of coding activity.
        Select your preferred hours to save them for calendar integration.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>
        {params.ok && <Banner variant="success">Preferences saved.</Banner>}
        {params.error && <Banner variant="danger">{params.error}</Banner>}

        {/* Recommendation card */}
        <Card accent={palette.cyan}>
          <CardHeader title="team velocity recommendation" hint="based on last 30 days of activity" />
          <p style={{ color: palette.text, fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            {profile.recommendation}
          </p>
          {memberCount < 2 && (
            <p style={{ color: palette.textDim, fontSize: 12, marginTop: space.x2 }}>
              Add more team members via{" "}
              <a href="/share" style={{ color: palette.cyan }}>peer-share</a>{" "}
              to see overlap analysis.
            </p>
          )}
        </Card>

        {/* Heatmap + preference grid */}
        <form action={savePreferencesAction}>
          <Card>
            <CardHeader
              title="activity heatmap · select preferred hours"
              hint="your coding intensity by hour (UTC) — overlap hours highlighted in cyan, high-productivity in amber"
            />

            <div style={{ overflowX: "auto", marginTop: space.x3 }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Hour (UTC)</th>
                    {HOURS.map((h) => (
                      <th key={h} style={{ ...thStyle, width: 28 }}>
                        <span style={{ fontSize: 9, color: palette.textMute }}>
                          {String(h).padStart(2, "0")}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DAYS_LABEL.map((dayLabel, dow) => (
                    <tr key={dow}>
                      <td style={{ ...tdStyle, color: palette.textDim, fontSize: 11, paddingRight: space.x3 }}>
                        {dayLabel}
                      </td>
                      {HOURS.map((hour) => {
                        const val = heatmapLookup.get(`${dow}:${hour}`) ?? 0;
                        const intensity = val / heatmapMax;
                        const isOverlap = overlapHours.has(hour);
                        const isHighProd = highProdHours.has(hour);
                        const isPref = preferredSet.has(hour);
                        const bg = isOverlap
                          ? `rgba(0,255,255,${0.15 + intensity * 0.35})`
                          : isHighProd
                            ? `rgba(255,180,0,${0.12 + intensity * 0.3})`
                            : intensity > 0
                              ? `rgba(0,255,128,${0.08 + intensity * 0.25})`
                              : "transparent";
                        return (
                          <td key={hour} style={{ ...tdStyle, textAlign: "center" }}>
                            <label
                              title={`${dayLabel} ${String(hour).padStart(2, "0")}:00 — ${val} events`}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: 22,
                                height: 22,
                                borderRadius: 3,
                                background: bg,
                                cursor: "pointer",
                                border: isPref ? `1.5px solid ${palette.cyan}` : "1.5px solid transparent",
                                transition: "background 0.1s, border-color 0.1s",
                              }}
                            >
                              <input
                                type="checkbox"
                                name={`hour_${hour}`}
                                defaultChecked={isPref}
                                style={{ width: 0, height: 0, opacity: 0, position: "absolute" }}
                              />
                            </label>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Legend */}
            <div style={{ display: "flex", gap: space.x4, marginTop: space.x3, flexWrap: "wrap" }}>
              {[
                { color: "rgba(0,255,255,0.45)", label: "team overlap" },
                { color: "rgba(255,180,0,0.4)", label: "high productivity" },
                { color: "rgba(0,255,128,0.3)", label: "your activity" },
                { color: "transparent", label: "inactive", border: `1.5px solid ${palette.border}` },
              ].map(({ color, label, border }) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: space.x1 }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: 2,
                    background: color,
                    border: border ?? `1px solid ${palette.border}`,
                  }} />
                  <span style={{ fontSize: 11, color: palette.textDim }}>{label}</span>
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: space.x1 }}>
                <div style={{ width: 14, height: 14, borderRadius: 2, border: `1.5px solid ${palette.cyan}`, background: "transparent" }} />
                <span style={{ fontSize: 11, color: palette.textDim }}>selected (click to toggle)</span>
              </div>
            </div>

            <div style={{ display: "flex", gap: space.x3, alignItems: "center", marginTop: space.x4 }}>
              <Button type="submit" variant="primary">Save preferred hours</Button>
              {preferredHours.length > 0 && (
                <span style={{ color: palette.textMute, fontSize: 11 }}>
                  Current: {preferredHours.join(", ")}
                </span>
              )}
            </div>
          </Card>
        </form>

        {/* Overlap details table */}
        {profile.overlaps.length > 0 && (
          <Card>
            <CardHeader
              title="overlap windows"
              hint="hours where multiple team members show coding activity"
            />
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: space.x3 }}>
              <thead>
                <tr>
                  {["Hour (UTC)", "Co-activity prob", "Team cost/hr (millicents)"].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {profile.overlaps.slice(0, 12).map((o) => (
                  <tr key={o.hour}>
                    <td style={tdStyle}>
                      {String(o.hour).padStart(2, "0")}:00–{String(o.hour + 1).padStart(2, "0")}:00 UTC
                    </td>
                    <td style={tdStyle}>
                      <span style={{ color: palette.cyan }}>{Math.round(o.prob * 100)}%</span>
                    </td>
                    <td style={tdStyle}>
                      {Math.round(o.costPerHour).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </DashboardShell>
  );
}

const pageTitle: React.CSSProperties = {
  fontSize: 22, fontWeight: 600, margin: `${space.x2}px 0 ${space.x05}px`,
  color: palette.text, letterSpacing: "-0.5px",
};
const pageSub: React.CSSProperties = {
  color: palette.textDim, fontSize: 13, marginBottom: space.x5,
};
const thStyle: React.CSSProperties = {
  textAlign: "left", fontSize: 10, color: palette.textMute,
  letterSpacing: "0.4px", textTransform: "uppercase",
  padding: `${space.x1}px ${space.x2}px`,
  borderBottom: `1px solid ${palette.border}`,
};
const tdStyle: React.CSSProperties = {
  padding: `${space.x1}px ${space.x2}px`,
  fontSize: 12, color: palette.text,
  borderBottom: `1px solid ${palette.border}`,
};
