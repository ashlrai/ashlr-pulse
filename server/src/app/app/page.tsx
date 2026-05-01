/**
 * /app — the cyber/agentic dashboard.
 *
 * Modes:
 *   1. /        → your own activity over the last 30 days, with the
 *                 last 24h elevated and the rest as charts/feed.
 *   2. /?as=<id> → a peer's activity, filtered by an active peer_share
 *                 grant from <id> to you. Honors granularity + field
 *                 whitelist (lib/peer-share-guard).
 *
 * The page is a single server component that loads everything in
 * parallel via lib/dashboard-data, then composes purely-presentational
 * components. The AI briefing call is fired in parallel with the heavy
 * SQL — it never blocks the chart render.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { currentUser } from "@/lib/current-user";
import { listGrantsForViewer, type PeerShareRow } from "@/lib/peer-share-db";
import { fmtUsd } from "@/lib/pricing";
import { getAgentStatus } from "@/lib/heartbeat";
import { loadMissedRepos } from "@/lib/missed-repos";
import { loadDashboard, type ScopeFilter } from "@/lib/dashboard-data";
import { getOrComputeBriefing, type BriefingInputs } from "@/lib/briefing";
import { detectAnomaly } from "@/lib/anomalies";
import { primaryOrgForUser } from "@/lib/org-db";
import { limitsFor, retentionCutoff, FREE_LIMITS } from "@/lib/plan-gate";

import { Header } from "@/components/Header";
import { StatCard } from "@/components/StatCard";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Skeleton } from "@/components/ui/Skeleton";
import { ChipGroup } from "@/components/ui/ChipGroup";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { StackedAreaChart } from "@/components/charts/StackedAreaChart";
import { HBarChart } from "@/components/charts/HBarChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { Heatmap } from "@/components/charts/Heatmap";
import { LineChart } from "@/components/charts/LineChart";
import { RadialGauge } from "@/components/charts/RadialGauge";

import { palette, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

interface SearchParams { as?: string; win?: string }

const WIN_OPTIONS = [
  { label: "7d",  value: "7",  days: 7  },
  { label: "14d", value: "14", days: 14 },
  { label: "30d", value: "30", days: 30 },
  { label: "90d", value: "90", days: 90 },
] as const;

function resolveWindow(raw: string | undefined): { value: string; days: number } {
  const opt = WIN_OPTIONS.find((o) => o.value === raw);
  return opt ?? { value: "14", days: 14 };
}

export default async function Page({
  searchParams,
}: { searchParams: Promise<SearchParams> }): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const { as, win } = await searchParams;
  const windowOpt = resolveWindow(win);
  let targetUserId = me.id;
  let scope: ScopeFilter = { repoClauseSql: "", repoParams: [] };
  let peerLabel: string | null = null;

  if (as && as !== me.id) {
    const grants = (await listGrantsForViewer(me.id)).filter((g) => g.owner_id === as);
    if (grants.length === 0) {
      redirect(`/share?error=${encodeURIComponent("no active grant from that user")}`);
    }
    targetUserId = as;
    scope = await buildScopeFilter(grants);
    peerLabel = grants[0].owner_email ?? "peer";
  }

  const isOwnView = targetUserId === me.id;
  const nowUtc = new Date();
  const since24hUtc = new Date(nowUtc.getTime() - 24 * 3600_000).toISOString();

  // Resolve plan limits once — used for retention clamp, AI gate, and banner.
  const org = isOwnView ? await primaryOrgForUser(me.id) : null;
  const limits = org ? limitsFor(org) : FREE_LIMITS;
  const isFreeTier = limits.retention_days < 90;

  // Run all the heavy lifts in parallel.
  const [data, agentStatus, missedRepos] = await Promise.all([
    loadDashboard(targetUserId, scope, { chartDays: windowOpt.days, limits }),
    isOwnView ? getAgentStatus(me.id, nowUtc) : Promise.resolve(null),
    isOwnView ? loadMissedRepos(me.id, since24hUtc, nowUtc.toISOString()) : Promise.resolve([]),
  ]);

  // Compute the prior-week median so the AI briefing has a baseline.
  const prior7 = data.daily.slice(0, 7);
  const baselineEvents = median(prior7.map((d) => d.events));
  const baselineTokens = median(prior7.map((d) => d.tokens));
  const baselineCost   = median(prior7.map((d) => d.costCents ?? 0));

  // Anomaly detection runs synchronously — pure numeric, no API calls.
  const eventAnomaly = detectAnomaly({
    current: data.today.events,
    baseline: prior7.map((d) => d.events),
    metric: "events", noun: "events",
  });
  const tokenAnomaly = detectAnomaly({
    current: data.today.tokens,
    baseline: prior7.map((d) => d.tokens),
    metric: "tokens", noun: "tokens",
  });
  const costAnomaly = detectAnomaly({
    current: data.today.costCents ?? 0,
    baseline: prior7.map((d) => d.costCents ?? 0),
    metric: "cost", noun: "spend",
  });

  // Cache hit ratio (rolling 14d) — single dimensional gauge.
  const totalReads  = data.cacheEfficiency.reduce((a, b) => a + b.reads, 0);
  const totalWrites = data.cacheEfficiency.reduce((a, b) => a + b.writes, 0);
  const cacheHit = totalReads + totalWrites === 0 ? 0 : totalReads / (totalReads + totalWrites);

  const eventsDelta = baselineEvents > 0 ? data.today.events / baselineEvents - 1 : null;
  const tokensDelta = baselineTokens > 0 ? data.today.tokens / baselineTokens - 1 : null;
  const costDelta = baselineCost > 0 && data.today.costCents != null
    ? data.today.costCents / baselineCost - 1
    : null;

  const agentSeenSecs = agentStatus?.seconds_ago ?? null;
  const agentAlive = agentSeenSecs != null && agentSeenSecs < 5 * 60;

  const briefingInputs: BriefingInputs = {
    events:        data.today.events,
    tokens:        data.today.tokens,
    costCents:     data.today.costCents,
    topRepos:      data.topRepos.slice(0, 6).map((r) => ({ repo: r.label, events: r.value })),
    topModels:     data.modelMix.slice(0, 4).map((m) => ({ model: m.label, tokens: m.value })),
    baselineEvents,
    baselineTokens,
    baselineCostCents: baselineCost,
    commits:       data.recentCommits.slice(0, 8).map((c) => c.subject),
  };

  return (
    <DashboardShell>
      <Header
        me={me}
        active="dashboard"
        agentAlive={isOwnView ? agentAlive : undefined}
        agentSeenSecondsAgo={agentSeenSecs}
      />

      {peerLabel && (
        <div style={{ marginBottom: space.x4 }}>
          <Banner variant="info" title={`viewing ${peerLabel}'s activity`}>
            scope filtered by active peer-share grants ·{" "}
            <a href="/app" style={{ color: palette.cyan }}>back to your view</a>
          </Banner>
        </div>
      )}

      {missedRepos.length > 0 && (
        <div style={{ marginBottom: space.x4 }}>
          <Banner variant="warning" title="repos with commits but no agent activity">
            {missedRepos.join(", ")} — looks like the agent isn't running there.
          </Banner>
        </div>
      )}

      {/* Retention banner — shown to free-tier users so they know why they're seeing less data. */}
      {isOwnView && isFreeTier && (
        <div style={{ marginBottom: space.x4 }}>
          <Banner variant="info">
            Free tier shows last {limits.retention_days} days.{" "}
            <a href="/billing" style={{ color: palette.cyan }}>Upgrade for 90-day retention →</a>
          </Banner>
        </div>
      )}

      {/* Window selector chip group. */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: space.x3 }}>
        <ChipGroup
          current={windowOpt.value}
          options={WIN_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
          hrefFor={(v) => buildHref({ as, win: v })}
        />
      </div>

      {/* Stat strip — first 1 second of value. */}
      <div className="dash-stat-strip">
        <StatCard
          accent="green"
          label="events · 24h"
          value={data.today.events.toLocaleString()}
          delta={eventsDelta}
          hint={baselineEvents ? `vs ${baselineEvents.toLocaleString()} median` : undefined}
          sparkline={data.sparklines.events}
        />
        <StatCard
          accent="cyan"
          label="tokens · 24h"
          value={abbrev(data.today.tokens)}
          delta={tokensDelta}
          hint={baselineTokens ? `vs ${abbrev(baselineTokens)} median` : undefined}
          sparkline={data.sparklines.tokens}
        />
        <StatCard
          accent="magenta"
          label="cost · 24h"
          value={fmtUsd(data.today.costCents)}
          delta={costDelta}
          hint={baselineCost ? `vs ${fmtUsd(baselineCost)} median` : undefined}
          sparkline={data.sparklines.cost}
        />
        <StatCard
          accent="amber"
          label="commits · 24h"
          value={data.recentCommits.length.toString()}
          hint="last 24h"
          sparkline={data.sparklines.commits}
        />
      </div>

      {/* AI briefing — async-streamed via Suspense. Free-tier renders upsell card. */}
      <div style={{ marginTop: space.x5 }}>
        <Suspense fallback={<BriefingSkeleton />}>
          <BriefingPanel userId={targetUserId} inputs={briefingInputs} aiEnabled={limits.ai_features} />
        </Suspense>
      </div>

      {/* Anomaly badges row (numeric, instant). */}
      {(eventAnomaly || tokenAnomaly || costAnomaly) && (
        <div style={{ marginTop: space.x4, display: "flex", gap: space.x3, flexWrap: "wrap" }}>
          {eventAnomaly && <AnomalyChip color={palette.green}  msg={eventAnomaly.message} />}
          {tokenAnomaly && <AnomalyChip color={palette.cyan}   msg={tokenAnomaly.message} />}
          {costAnomaly  && <AnomalyChip color={palette.magenta} msg={costAnomaly.message} />}
        </div>
      )}

      {/* Charts — 2 columns where it makes sense. */}
      <div className="dash-grid" style={{ marginTop: space.x6 }}>
        <div className="dash-grid-full">
          <ChartFrame
            title={`activity · last ${windowOpt.days} days`}
            hint="tokens per day, stacked by source"
            accent={palette.green}
          >
            {data.stackedArea.length > 0 && data.sources.length > 0 ? (
              <StackedAreaChart
                data={data.stackedArea}
                series={data.sources}
                vFmt={(v) => abbrev(Number(v))}
              />
            ) : (
              <EmptyChart label="No data in the last 14 days yet." />
            )}
          </ChartFrame>
        </div>

        <ChartFrame title="model mix · last 7d" hint="tokens by model" accent={palette.cyan}>
          {data.modelMix.length > 0 ? (
            <DonutChart
              data={data.modelMix}
              vFmt={(v) => abbrev(Number(v))}
              centerValue={abbrev(data.modelMix.reduce((a, b) => a + b.value, 0))}
              centerLabel="tokens"
            />
          ) : (
            <EmptyChart label="No model data yet." />
          )}
        </ChartFrame>

        <ChartFrame title="top repos · last 7d" hint="events" accent={palette.magenta}>
          {data.topRepos.length > 0 ? (
            <HBarChart data={data.topRepos} uniformColor={palette.magenta} />
          ) : (
            <EmptyChart label="No repo data yet." />
          )}
        </ChartFrame>

        <ChartFrame title={`cost trajectory · last ${windowOpt.days}d`} hint="cumulative dollars" accent={palette.magenta}>
          {data.costTrajectory.length > 0 ? (
            <LineChart
              data={data.costTrajectory.map((p) => ({ bucket: p.bucket, cost: p.cents / 100 }))}
              series={[{ key: "cost", label: "cumulative $", color: palette.magenta }]}
              yFmt={(v) => `$${v.toFixed(0)}`}
              vFmt={(v) => `$${Number(v).toFixed(2)}`}
            />
          ) : (
            <EmptyChart label="No cost data yet." />
          )}
        </ChartFrame>

        <ChartFrame title={`cache efficiency · last ${windowOpt.days}d`} hint="read-to-write ratio" accent={palette.amber}>
          {totalReads + totalWrites > 0 ? (
            <CacheEfficiencyPanel cacheHit={cacheHit} efficiency={data.cacheEfficiency} />
          ) : (
            <EmptyChart label="No cache data yet." />
          )}
        </ChartFrame>

        <ChartFrame title="top tools · last 7d" hint="tool calls" accent={palette.purple} minHeight={240}>
          {data.topTools.length > 0 ? (
            <HBarChart data={data.topTools} uniformColor={palette.purple} />
          ) : (
            <EmptyChart label="No tool-call data yet." />
          )}
        </ChartFrame>

        {(data.githubTotals.commits + data.githubTotals.prs_opened + data.githubTotals.prs_merged) > 0 && (
          <div className="dash-grid-full">
            <ChartFrame
              title={`github throughput · last ${windowOpt.days}d`}
              hint={`${data.githubTotals.commits} commits · ${data.githubTotals.prs_opened} prs opened · ${data.githubTotals.prs_merged} merged`}
              accent={palette.purple}
            >
              <LineChart
                data={data.github}
                series={[
                  { key: "commits",    label: "commits",    color: palette.green   },
                  { key: "prs_opened", label: "prs opened", color: palette.cyan    },
                  { key: "prs_merged", label: "prs merged", color: palette.magenta },
                ]}
                yFmt={(v) => v.toFixed(0)}
                vFmt={(v) => `${v}`}
                height={220}
              />
            </ChartFrame>
          </div>
        )}

        <div className="dash-grid-full">
          <ChartFrame
            title="when you actually work · last 30d"
            hint="hour-of-day × day-of-week — darker = more events"
            accent={palette.green}
            minHeight={180}
          >
            {data.heatmap.length > 0 ? (
              <Heatmap cells={data.heatmap} />
            ) : (
              <EmptyChart label="Not enough data for a heatmap yet." />
            )}
          </ChartFrame>
        </div>
      </div>

      {/* Project rollup — only renders if user has projects with activity in window. */}
      {data.byProject.length > 0 && (
        <div style={{ marginTop: space.x6 }}>
          <Card>
            <CardHeader
              title={`by project · last ${data.chartDays}d`}
              hint={`${data.byProject.length} project${data.byProject.length === 1 ? "" : "s"} with activity`}
              right={<a href="/projects" style={{ color: palette.cyan, textDecoration: "none" }}>manage projects →</a>}
            />
            <ProjectRollupTable rows={data.byProject} />
          </Card>
        </div>
      )}

      {/* Recent commits + activity feed. */}
      <div className="dash-grid" style={{ marginTop: space.x6 }}>
        <Card>
          <CardHeader title={`recent commits · last ${windowOpt.days}d`} hint={`${data.recentCommits.length} commits`} />
          <RecentCommits commits={data.recentCommits} />
        </Card>
        <Card>
          <CardHeader title="recent activity · last 50 events" />
          <ActivityFeed feed={data.feed} />
        </Card>
      </div>
    </DashboardShell>
  );
}

// ─── Async briefing panel (called inside Suspense) ────────────────────

async function BriefingPanel({
  userId, inputs, aiEnabled = true,
}: { userId: string; inputs: BriefingInputs; aiEnabled?: boolean }): Promise<ReactElement> {
  // Gate 5: AI features are Pro/Team only. Render an upgrade prompt on free.
  if (!aiEnabled) {
    return (
      <Card style={{ borderStyle: "dashed" }}>
        <div style={{ fontSize: 13, color: palette.textDim, lineHeight: 1.6 }}>
          <span style={{ color: palette.cyan, marginRight: 6 }}>briefing</span>
          AI insights are a Pro feature.{" "}
          <a href="/billing" style={{ color: palette.cyan }}>Upgrade to Pro →</a>
        </div>
      </Card>
    );
  }

  const briefing = await getOrComputeBriefing(userId, inputs, aiEnabled);
  if (!briefing) {
    // Should not happen when aiEnabled=true, but be defensive.
    return <></>;
  }
  return (
    <Card accent={palette.cyan} style={{ background: "linear-gradient(180deg, rgba(124,208,255,0.04), transparent 60%)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.x2, marginBottom: space.x2 }}>
        <span style={{
          fontSize: 10, color: palette.cyan, letterSpacing: "0.8px",
          textTransform: "uppercase", fontWeight: 500,
        }}>
          briefing · generated by Pulse {briefing.source === "fallback" && "· fallback"}
        </span>
        <span style={{ fontSize: 10, color: palette.textMute }}>
          {fmtAgo(briefing.generated_at)}
        </span>
      </div>
      <div style={{ fontSize: 14, lineHeight: 1.6, color: palette.text }}>
        {briefing.text}
      </div>
    </Card>
  );
}

function BriefingSkeleton(): ReactElement {
  return (
    <Card>
      <Skeleton height={11} width={180} />
      <div style={{ height: 8 }} />
      <Skeleton height={14} />
      <div style={{ height: 6 }} />
      <Skeleton height={14} width="80%" />
    </Card>
  );
}

// ─── Inline pieces ────────────────────────────────────────────────────

function AnomalyChip({ color, msg }: { color: string; msg: string }): ReactElement {
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "5px 10px",
        background: `${color}10`,
        border: `1px solid ${color}40`,
        borderRadius: 999,
        color, fontSize: 11, letterSpacing: "0.3px",
      }}
    >
      ⚡ {msg}
    </span>
  );
}

function EmptyChart({ label }: { label: string }): ReactElement {
  return (
    <div
      style={{
        height:     180,
        display:    "flex",
        alignItems: "center",
        justifyContent: "center",
        color:      palette.textMute,
        fontSize:   12,
        border:     `1px dashed ${palette.border}`,
        borderRadius: 6,
      }}
    >
      {label}
    </div>
  );
}

function CacheEfficiencyPanel({
  cacheHit, efficiency,
}: {
  cacheHit: number;
  efficiency: { bucket: string; ratio: number }[];
}): ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: space.x4 }}>
      <RadialGauge value={cacheHit} label="cache hit (14d)" color={palette.amber} size={130} />
      <div style={{ flex: 1, minWidth: 0, height: 130 }}>
        <LineChart
          data={efficiency}
          series={[{ key: "ratio", label: "read/write", color: palette.amber }]}
          yFmt={(v) => v.toFixed(1)}
          vFmt={(v) => `${Number(v).toFixed(2)}×`}
          height={130}
        />
      </div>
    </div>
  );
}

function RecentCommits({
  commits,
}: { commits: { subject: string; repo: string; sha: string; ts: string }[] }): ReactElement {
  if (commits.length === 0) {
    return <div style={{ color: palette.textMute, fontSize: 12 }}>No recent commits.</div>;
  }
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 12 }}>
      {commits.map((c) => (
        <li
          key={c.sha}
          style={{
            display: "flex", alignItems: "baseline", gap: space.x2,
            padding: "8px 0",
            borderBottom: `1px dashed ${palette.border}`,
          }}
        >
          <code style={{ color: palette.green, fontSize: 10 }}>{c.sha.slice(0, 7)}</code>
          <span style={{ color: palette.textDim, fontSize: 11, minWidth: 110, flexShrink: 0 }}>
            {c.repo.split("/").pop()}
          </span>
          <span style={{ color: palette.text, flex: 1 }}>{c.subject}</span>
          <span style={{ color: palette.textMute, fontSize: 10 }}>{fmtAgo(new Date(c.ts))}</span>
        </li>
      ))}
    </ul>
  );
}

function ProjectRollupTable({
  rows,
}: { rows: import("@/lib/dashboard-data").ProjectRollup[] }): ReactElement {
  const max = Math.max(...rows.map((r) => r.tokens), 1);
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: `1px solid ${palette.border}` }}>
          <th style={th}>project</th>
          <th style={th}>kind</th>
          <th style={{ ...th, textAlign: "right" }}>repos</th>
          <th style={{ ...th, textAlign: "right" }}>events</th>
          <th style={{ ...th, textAlign: "right" }}>tokens</th>
          <th style={{ ...th, width: "30%" }}></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.project_id} style={{ borderBottom: `1px dashed ${palette.border}` }}>
            <td style={td}>
              <span style={{ color: palette.text, fontWeight: 500 }}>{r.project_name}</span>
            </td>
            <td style={td}>
              <span style={kindChip(r.kind)}>{r.kind}</span>
            </td>
            <td style={{ ...td, textAlign: "right", color: palette.textDim }}>{r.repos}</td>
            <td style={{ ...td, textAlign: "right", color: palette.textDim, fontVariantNumeric: "tabular-nums" }}>
              {r.events.toLocaleString()}
            </td>
            <td style={{ ...td, textAlign: "right", color: palette.text, fontVariantNumeric: "tabular-nums" }}>
              {abbrev(r.tokens)}
            </td>
            <td style={td}>
              <div style={{ height: 6, background: palette.bgRaised, borderRadius: 3, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${Math.min(100, (r.tokens / max) * 100)}%`,
                    background: kindColor(r.kind),
                    transition: "width 0.5s ease",
                  }}
                />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function kindColor(kind: string): string {
  if (kind === "saas")       return palette.green;
  if (kind === "client")     return palette.magenta;
  if (kind === "internal")   return palette.cyan;
  if (kind === "experiment") return palette.amber;
  return palette.textDim;
}

function kindChip(kind: string): React.CSSProperties {
  const c = kindColor(kind);
  return {
    color: c,
    background: `${c}10`,
    border: `1px solid ${c}30`,
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 10,
    letterSpacing: "0.5px",
    textTransform: "uppercase",
  };
}

function ActivityFeed({ feed }: { feed: import("@/lib/dashboard-data").FeedRow[] }): ReactElement {
  if (feed.length === 0) {
    return <div style={{ color: palette.textMute, fontSize: 12 }}>No recent activity.</div>;
  }
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 11 }}>
      {feed.map((r, i) => (
        <li
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: "60px 70px 1fr 70px 60px",
            gap: 8,
            alignItems: "baseline",
            padding: "5px 0",
            borderBottom: `1px dashed ${palette.border}`,
          }}
        >
          <span style={{ color: palette.textMute, fontSize: 10 }}>
            {fmtAgoShort(new Date(r.ts))}
          </span>
          <span style={{ color: palette.cyan, fontSize: 10 }}>{r.source}</span>
          <span style={{ color: palette.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.repo ?? "—"}
            {r.model && <span style={{ color: palette.textDim, marginLeft: 8 }}>· {r.model}</span>}
          </span>
          <span style={{ color: palette.textDim, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {abbrev((r.tokens_input ?? 0) + (r.tokens_output ?? 0))}
          </span>
          <span style={{ color: palette.magenta, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {fmtUsd(r.costCents)}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

const th: React.CSSProperties = {
  padding: "8px 6px", color: palette.textDim,
  fontSize: 11, fontWeight: 500, letterSpacing: "0.5px",
  textTransform: "uppercase",
};
const td: React.CSSProperties = { padding: "8px 6px", color: palette.text };

function buildHref(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `/app?${s}` : "/app";
}

function abbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function fmtAgo(d: Date): string {
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60)     return `${s}s ago`;
  if (s < 3600)   return `${Math.round(s / 60)}m ago`;
  if (s < 86400)  return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function fmtAgoShort(d: Date): string {
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

async function buildScopeFilter(grants: PeerShareRow[]): Promise<ScopeFilter> {
  // Resolve grants → a UNION of (repo glob LIKE, project_id repo set).
  // If any grant has scope_type='all' we short-circuit to no filter.
  // Otherwise we collect LIKE patterns and project_ids, then expand
  // project_ids to their repo lists via project_repo, and build a
  // single (LIKE OR LIKE OR repo_name IN (…)) clause.
  let pIdx = 2; // $1 is user_id, scope params start at $2
  const ors: string[] = [];
  const params: (string | number)[] = [];
  const projectIds: string[] = [];

  for (const g of grants) {
    if (g.scope_type === "all") {
      return { repoClauseSql: "", repoParams: [] };
    }
    if (g.scope_type === "repo_pattern" && g.scope_value) {
      ors.push(`repo_name LIKE $${pIdx++}`);
      params.push(g.scope_value);
    } else if (g.scope_type === "project" && g.scope_value) {
      projectIds.push(g.scope_value);
    }
  }

  if (projectIds.length > 0) {
    const db = (await import("@/lib/db")).sql();
    const rows = await db<{ repo_name: string }[]>`
      SELECT DISTINCT repo_name FROM project_repo
      WHERE project_id = ANY(${projectIds}::uuid[])
    `;
    if (rows.length > 0) {
      const placeholders = rows.map(() => `$${pIdx++}`).join(",");
      ors.push(`repo_name IN (${placeholders})`);
      for (const r of rows) params.push(r.repo_name);
    } else {
      // Project has no repos → grant resolves to empty set. To be
      // safe, force the result set empty rather than no-op (which
      // would leak the owner's whole activity).
      ors.push("FALSE");
    }
  }

  if (ors.length === 0) {
    // Caller had grants but none resolved to a usable filter — return
    // an impossible clause rather than no filter.
    return { repoClauseSql: "AND FALSE", repoParams: [] };
  }
  return {
    repoClauseSql: `AND (${ors.join(" OR ")})`,
    repoParams: params,
  };
}
