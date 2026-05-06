/**
 * /projects/[id] — drill-down for one project.
 *
 * Surfaces what the global dashboard never quite answers: "for *this*
 * client engagement, what did the last 14d of AI work cost, in which
 * repo, on which model?" Aggregates pulled in three small queries from
 * project-db so the page renders in one round-trip.
 *
 * Auth: must be a member of the project's org. Anything else 404s
 * (rather than 403) so we don't reveal the project's existence.
 */

import type { ReactElement } from "react";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/current-user";
import { getProjectByIdForUser, loadProjectDetail } from "@/lib/project-db";
import { fmtUsd } from "@/lib/pricing";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { palette, space } from "@/lib/theme";
import {
  abbrev,
  kindChip,
  th,
  td,
} from "@/app/app/_components/dashboard-format";

export const dynamic = "force-dynamic";

const DEFAULT_DAYS = 14;

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ProjectDetailPage({ params }: PageProps): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login?next=/projects");

  const { id } = await params;
  const project = await getProjectByIdForUser(id, me.id);
  if (!project) notFound();

  const detail = await loadProjectDetail(id, me.id, DEFAULT_DAYS);
  const totalCents = detail.byRepo.reduce((s, r) => s + r.cents, 0);
  const totalEvents = detail.byRepo.reduce((s, r) => s + r.events, 0);
  const totalTokens = detail.byRepo.reduce((s, r) => s + r.tokens, 0);

  const dayPoints: LinePoint[] = detail.byDay.map((d) => ({
    bucket: d.bucket,
    cost_usd: d.cents / 100, // dollars for the chart
  }));

  return (
    <DashboardShell maxWidth={1024}>
      <Header me={me} active="projects" />

      <div style={{ marginBottom: space.x4 }}>
        <a href="/projects" style={{ color: palette.cyan, fontSize: 12 }}>← all projects</a>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: space.x3, marginBottom: space.x2 }}>
        <h1 style={pageTitle}>{project.name}</h1>
        <span style={kindChip(project.kind)}>{project.kind}</span>
      </div>
      <div style={pageSub}>
        {project.repos.length} repo{project.repos.length === 1 ? "" : "s"}
        {" · "}created {project.created_at.slice(0, 10)}
        {" · "}showing last {DEFAULT_DAYS} days
      </div>

      {detail.byRepo.length === 0 ? (
        <Card>
          <CardHeader title="no activity yet" />
          <p style={{ color: palette.textDim, fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            No spans landed for this project&apos;s repos in the last {DEFAULT_DAYS} days.
            Either the agent isn&apos;t running, the repos haven&apos;t been touched,
            or the project_repo mapping doesn&apos;t cover what you actually worked on.
            <br /><br />
            Repos in this project: {project.repos.length === 0 ? "(none)" : project.repos.map((r) => <code key={r} style={{ color: palette.cyan, marginRight: 8 }}>{r}</code>)}
          </p>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: space.x3 }}>
            <Stat label={`cost · ${DEFAULT_DAYS}d`} value={fmtUsd(totalCents)} accent={palette.magenta} />
            <Stat label={`tokens · ${DEFAULT_DAYS}d`} value={abbrev(totalTokens)} accent={palette.cyan} />
            <Stat label={`events · ${DEFAULT_DAYS}d`} value={totalEvents.toLocaleString()} accent={palette.green} />
          </div>

          <ChartFrame
            title={`cost trajectory · ${DEFAULT_DAYS}d`}
            hint="dollars per day across all repos in this project"
            accent={palette.magenta}
            minHeight={200}
          >
            <LineChart
              data={dayPoints}
              series={[{ key: "cost_usd", label: "cost ($)", color: palette.magenta }]}
              yFormat="dollars-2dp"
              valueFormat="dollars-2dp"
              height={200}
            />
          </ChartFrame>

          <Card>
            <CardHeader title={`top repos · ${DEFAULT_DAYS}d`} hint="cost rank within this project" />
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: `1px solid ${palette.border}` }}>
                  <th style={th}>repo</th>
                  <th style={{ ...th, textAlign: "right" }}>events</th>
                  <th style={{ ...th, textAlign: "right" }}>tokens</th>
                  <th style={{ ...th, textAlign: "right" }}>cost</th>
                </tr>
              </thead>
              <tbody>
                {detail.byRepo.map((r) => (
                  <tr key={r.repo} style={{ borderBottom: `1px dashed ${palette.border}` }}>
                    <td style={{ ...td, color: palette.text }}>{r.repo}</td>
                    <td style={{ ...td, textAlign: "right", color: palette.textDim, fontVariantNumeric: "tabular-nums" }}>
                      {r.events.toLocaleString()}
                    </td>
                    <td style={{ ...td, textAlign: "right", color: palette.textDim, fontVariantNumeric: "tabular-nums" }}>
                      {abbrev(r.tokens)}
                    </td>
                    <td style={{ ...td, textAlign: "right", color: palette.magenta, fontVariantNumeric: "tabular-nums" }}>
                      {fmtUsd(r.cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {detail.byModel.length > 0 && (
            <Card>
              <CardHeader title={`models · ${DEFAULT_DAYS}d`} hint="which model paid for this project's work" />
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: `1px solid ${palette.border}` }}>
                    <th style={th}>model</th>
                    <th style={{ ...th, textAlign: "right" }}>events</th>
                    <th style={{ ...th, textAlign: "right" }}>tokens</th>
                    <th style={{ ...th, textAlign: "right" }}>cost</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.byModel.map((m) => (
                    <tr key={m.model} style={{ borderBottom: `1px dashed ${palette.border}` }}>
                      <td style={{ ...td, color: palette.text }}>{m.model}</td>
                      <td style={{ ...td, textAlign: "right", color: palette.textDim, fontVariantNumeric: "tabular-nums" }}>
                        {m.events.toLocaleString()}
                      </td>
                      <td style={{ ...td, textAlign: "right", color: palette.textDim, fontVariantNumeric: "tabular-nums" }}>
                        {abbrev(m.tokens)}
                      </td>
                      <td style={{ ...td, textAlign: "right", color: palette.magenta, fontVariantNumeric: "tabular-nums" }}>
                        {fmtUsd(m.cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      )}
    </DashboardShell>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }): ReactElement {
  return (
    <div style={{
      padding: `${space.x3}px ${space.x4}px`,
      background: palette.bgRaised,
      border: `1px solid ${palette.border}`,
      borderRadius: 8,
      borderLeft: `3px solid ${accent}`,
    }}>
      <div style={{ color: palette.textDim, fontSize: 11, letterSpacing: "0.5px", textTransform: "uppercase" }}>{label}</div>
      <div style={{ color: palette.text, fontSize: 22, fontWeight: 600, fontVariantNumeric: "tabular-nums", marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
}

const pageTitle: React.CSSProperties = {
  fontSize: 24, fontWeight: 600, margin: `${space.x2}px 0 0`,
  color: palette.text, letterSpacing: "-0.5px",
};
const pageSub: React.CSSProperties = {
  color: palette.textDim, fontSize: 12, marginBottom: space.x5,
};
