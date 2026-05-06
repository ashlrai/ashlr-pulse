/**
 * /admin/health — internal observability dashboard.
 *
 * Surfaces the in-process counters + cron-tick ring exposed by the
 * T3.1 metrics module on /api/healthz, plus a few row-count + freshness
 * queries straight from postgres. Visible to org admins only — see
 * isOrgAdmin gate below. Not linked from the global nav; access by
 * typing the URL or following a link from the digest if something is
 * obviously broken.
 *
 * Why a page when /api/healthz is JSON? Because the JSON is for
 * Railway's healthcheck loop — operators want a human-readable view
 * with timestamps, deltas, and failure-counter colors.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser, isOrgAdmin } from "@/lib/org-db";
import { metricsSnapshot, recentTicks } from "@/lib/metrics";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { palette, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

interface RowCounts {
  activity_event: number;
  github_event: number;
  user: number;
  org: number;
  pat: number;
  peer_share: number;
  invite: number;
}

async function loadRowCounts(): Promise<RowCounts> {
  // Single round-trip — postgres returns one row with seven counts.
  const db = sql();
  const [row] = await db<RowCounts[]>`
    SELECT
      (SELECT COUNT(*)::bigint FROM activity_event)::int AS activity_event,
      (SELECT COUNT(*)::bigint FROM github_event)::int   AS github_event,
      (SELECT COUNT(*)::bigint FROM "user")::int         AS "user",
      (SELECT COUNT(*)::bigint FROM org)::int            AS org,
      (SELECT COUNT(*)::bigint FROM pat)::int            AS pat,
      (SELECT COUNT(*)::bigint FROM peer_share)::int     AS peer_share,
      (SELECT COUNT(*)::bigint FROM invite)::int         AS invite
  `;
  return row;
}

async function loadIngestFreshness(): Promise<{
  last_span_ts: string | null;
  spans_24h: number;
  spans_with_null_cost: number;
}> {
  const db = sql();
  const [row] = await db<{
    last_span_ts: string | null;
    spans_24h: number;
    spans_with_null_cost: number;
  }[]>`
    SELECT
      MAX(ts)::text AS last_span_ts,
      COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL '24 hours')::int AS spans_24h,
      COUNT(*) FILTER (WHERE cost_millicents IS NULL)::int            AS spans_with_null_cost
    FROM activity_event
  `;
  return row;
}

export default async function AdminHealthPage(): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const org = await primaryOrgForUser(me.id);
  if (!org) redirect("/app");
  if (!(await isOrgAdmin(org.id, me.id))) {
    redirect(`/app?error=${encodeURIComponent("admin role required")}`);
  }

  const [snap, rowCounts, ingest] = await Promise.all([
    Promise.resolve(metricsSnapshot()),
    loadRowCounts(),
    loadIngestFreshness(),
  ]);
  const ticks = recentTicks().slice().reverse();

  const counterEntries = Object.entries(snap.counters).sort(([a], [b]) => a.localeCompare(b));

  return (
    <DashboardShell maxWidth={960}>
      <Header me={me} active="settings" />

      <h1 style={pageTitle}>Admin · health</h1>
      <div style={pageSub}>
        Internal observability. Counters + cron history come from the
        in-process T3.1 metrics module — same data /api/healthz exposes
        as JSON for Railway. Numbers reset on container restart.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>

        <Card>
          <CardHeader title="ingest" hint="latest activity_event row + cost backfill state" />
          <KV
            rows={[
              ["last span ts", ingest.last_span_ts ?? "—"],
              ["spans (24h)", ingest.spans_24h.toLocaleString()],
              ["rows total", rowCounts.activity_event.toLocaleString()],
              ["rows with NULL cost_millicents", String(ingest.spans_with_null_cost)],
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="counters" hint="incremented at ingest + cron tick" />
          {counterEntries.length === 0 ? (
            <p style={{ color: palette.textDim, fontSize: 12, margin: 0 }}>
              No counters yet — wait for an OTLP ingest or a cron tick.
            </p>
          ) : (
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <tbody>
                {counterEntries.map(([k, v]) => (
                  <tr key={k} style={{ borderBottom: `1px dashed ${palette.border}` }}>
                    <td style={{ ...td, color: palette.textDim }}>{k}</td>
                    <td style={{ ...td, textAlign: "right", color: palette.text, fontVariantNumeric: "tabular-nums" }}>
                      {v.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card>
          <CardHeader title="cron ticks" hint="most recent first; up to 32 entries retained" />
          {ticks.length === 0 ? (
            <p style={{ color: palette.textDim, fontSize: 12, margin: 0 }}>
              No cron ticks yet (production-only — disabled in dev / when
              PULSE_CRON_SECRET is unset).
            </p>
          ) : (
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: `1px solid ${palette.border}` }}>
                  <th style={th}>endpoint</th>
                  <th style={th}>status</th>
                  <th style={{ ...th, textAlign: "right" }}>duration</th>
                  <th style={{ ...th, textAlign: "right" }}>ts</th>
                </tr>
              </thead>
              <tbody>
                {ticks.map((t, i) => {
                  const ok = t.status != null && t.status >= 200 && t.status < 300;
                  return (
                    <tr key={i} style={{ borderBottom: `1px dashed ${palette.border}` }}>
                      <td style={{ ...td, color: palette.text }}>{t.endpoint}</td>
                      <td style={{ ...td, color: ok ? palette.green : palette.magenta }}>
                        {t.status ?? "network"}
                        {t.error && <span style={{ color: palette.textMute, marginLeft: 6 }}>· {t.error.slice(0, 60)}</span>}
                      </td>
                      <td style={{ ...td, textAlign: "right", color: palette.textDim, fontVariantNumeric: "tabular-nums" }}>
                        {t.duration_ms.toLocaleString()}ms
                      </td>
                      <td style={{ ...td, textAlign: "right", color: palette.textMute, fontVariantNumeric: "tabular-nums" }}>
                        {t.ts.slice(0, 19).replace("T", " ")}Z
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card>
          <CardHeader title="row counts" hint="approximate; use \\dt+ in psql for exact" />
          <KV
            rows={[
              ["user", rowCounts.user.toLocaleString()],
              ["org", rowCounts.org.toLocaleString()],
              ["pat", rowCounts.pat.toLocaleString()],
              ["activity_event", rowCounts.activity_event.toLocaleString()],
              ["github_event", rowCounts.github_event.toLocaleString()],
              ["peer_share", rowCounts.peer_share.toLocaleString()],
              ["invite", rowCounts.invite.toLocaleString()],
            ]}
          />
        </Card>

      </div>
    </DashboardShell>
  );
}

function KV({ rows }: { rows: [string, string][] }): ReactElement {
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} style={{ borderBottom: `1px dashed ${palette.border}` }}>
            <td style={{ ...td, color: palette.textDim }}>{k}</td>
            <td style={{ ...td, textAlign: "right", color: palette.text, fontVariantNumeric: "tabular-nums" }}>
              {v}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const pageTitle: React.CSSProperties = {
  fontSize: 22, fontWeight: 600, margin: `${space.x2}px 0 ${space.x05}px`,
  color: palette.text, letterSpacing: "-0.5px",
};
const pageSub: React.CSSProperties = {
  color: palette.textDim, fontSize: 13, marginBottom: space.x5, lineHeight: 1.6,
};
const th: React.CSSProperties = {
  padding: "8px 6px", color: palette.textDim,
  fontSize: 11, fontWeight: 500, letterSpacing: "0.5px",
  textTransform: "uppercase",
};
const td: React.CSSProperties = { padding: "8px 6px" };
