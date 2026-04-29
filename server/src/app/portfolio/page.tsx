/**
 * /portfolio — health cards for every project the user is a member of.
 *
 * Mirrors the v0.3 ROADMAP item: "which client engagement is slipping?"
 * answered in <10 seconds without opening GitHub.
 *
 * Each card surfaces:
 *   - commits this week (sparkline + total)
 *   - active contributors (7d)
 *   - AI-share % (events with model ÷ total events on these repos, 7d)
 *   - last deploy (latest commit on default branch)
 *   - tokens + cost MTD
 *
 * Server component, single SQL fan-out via portfolio-db.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/current-user";
import { loadPortfolioHealth, type ProjectHealth } from "@/lib/portfolio-db";
import { fmtUsd } from "@/lib/pricing";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { palette, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

export default async function PortfolioPage(): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const projects = await loadPortfolioHealth(me.id);

  return (
    <DashboardShell maxWidth={1100}>
      <Header me={me} active="portfolio" />
      <h1 style={pageTitle}>portfolio</h1>
      <div style={pageSub}>
        per-project health across the orgs you belong to. updated each request.
      </div>

      {projects.length === 0 ? (
        <Card>
          <CardHeader title="no projects yet" />
          <p style={{ color: palette.textDim, fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            create your first project at <a href="/projects" style={{ color: palette.cyan }}>/projects</a> —
            group repos into SaaS products, client engagements, or internal tools to see them here.
          </p>
        </Card>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: space.x4,
          }}
        >
          {projects.map((p) => <PortfolioCard key={p.project_id} p={p} />)}
        </div>
      )}
    </DashboardShell>
  );
}

function PortfolioCard({ p }: { p: ProjectHealth }): ReactElement {
  const aiShare = p.events_7d > 0 ? p.ai_events_7d / p.events_7d : null;
  const sparkMax = Math.max(1, ...p.commits_per_day);

  return (
    <Card>
      <CardHeader
        title={p.project_name}
        hint={`${p.kind} · ${p.repos.length} repo${p.repos.length === 1 ? "" : "s"}`}
      />

      {/* Sparkline + commits-7d headline. */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: space.x3, marginBottom: space.x3 }}>
        <div>
          <div style={statBig}>{p.commits_7d}</div>
          <div style={statLabel}>commits · 7d</div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 28 }}>
          {p.commits_per_day.map((n, i) => (
            <span
              key={i}
              title={`${n} commit${n === 1 ? "" : "s"}`}
              style={{
                width: 6,
                height: `${Math.max(2, (n / sparkMax) * 28)}px`,
                background: n > 0 ? palette.green : palette.border,
                borderRadius: 1,
              }}
            />
          ))}
        </div>
      </div>

      <Row label="contributors · 7d" value={String(p.contributors_7d)} />
      <Row
        label="ai share · 7d"
        value={aiShare == null ? "—" : `${Math.round(aiShare * 100)}%`}
        accent={aiShare != null && aiShare < 0.1 ? palette.amber : undefined}
      />
      <Row
        label="last deploy"
        value={p.last_deploy_at ? fmtRelativeShort(p.last_deploy_at) : "never"}
        accent={
          p.last_deploy_at && Date.now() - new Date(p.last_deploy_at).getTime() > 14 * 24 * 3600_000
            ? palette.red
            : undefined
        }
      />
      <Row label="tokens · mtd" value={abbrev(p.tokens_mtd)} />
      <Row label="cost · mtd"   value={fmtUsd(p.cost_mtd_cents)} />

      <div style={{ marginTop: space.x3, paddingTop: space.x2, borderTop: `1px dashed ${palette.border}` }}>
        <a
          href={`/projects?focus=${encodeURIComponent(p.project_id)}`}
          style={{ fontSize: 11, color: palette.cyan, textDecoration: "none" }}
        >
          drill in →
        </a>
      </div>
    </Card>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: string }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        padding: `${space.x1}px 0`,
        borderTop: `1px dashed ${palette.border}`,
        fontSize: 12,
      }}
    >
      <span style={{ color: palette.textDim }}>{label}</span>
      <span style={{ color: accent ?? palette.text, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
    </div>
  );
}

function abbrev(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

function fmtRelativeShort(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)         return "just now";
  if (ms < 3_600_000)      return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000)     return `${Math.floor(ms / 3_600_000)}h ago`;
  const days = Math.floor(ms / 86_400_000);
  if (days < 7)            return `${days}d ago`;
  if (days < 30)           return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const pageTitle: React.CSSProperties = {
  fontSize: 22, fontWeight: 600, margin: `${space.x2}px 0 ${space.x05}px`,
  color: palette.text, letterSpacing: "-0.5px",
};
const pageSub: React.CSSProperties = {
  color: palette.textDim, fontSize: 13, marginBottom: space.x5,
};
const statBig: React.CSSProperties = {
  fontSize: 26, fontWeight: 600, color: palette.text,
  fontVariantNumeric: "tabular-nums", lineHeight: 1,
};
const statLabel: React.CSSProperties = {
  fontSize: 10, color: palette.textDim, textTransform: "uppercase",
  letterSpacing: "0.6px", marginTop: 4,
};

