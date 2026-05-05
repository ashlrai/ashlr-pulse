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
import { generateInsights, type Recommendation } from "@/lib/cost-insights";
import { forecast, sumForecast, type ForecastPoint } from "@/lib/forecast";
import { sql } from "@/lib/db";
import { listViews, type DashboardView, viewToHref } from "@/lib/dashboard-view-db";
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
import { LineChart, type LinePoint } from "@/components/charts/LineChart";
import { RadialGauge } from "@/components/charts/RadialGauge";

import { palette, space } from "@/lib/theme";
import { ProjectRollupTable } from "./_components/ProjectRollupTable";
import { ActivityFeed } from "./_components/ActivityFeed";
import {
  abbrev,
  fmtAgoShort,
  kindColor,
  kindChip,
  th,
  td,
} from "./_components/dashboard-format";

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
  const [data, agentStatus, missedRepos, pluginImpact, savedViews] = await Promise.all([
    loadDashboard(targetUserId, scope, { chartDays: windowOpt.days, limits }),
    isOwnView ? getAgentStatus(me.id, nowUtc) : Promise.resolve(null),
    isOwnView ? loadMissedRepos(me.id, since24hUtc, nowUtc.toISOString()) : Promise.resolve([]),
    isOwnView ? loadPluginImpact(targetUserId) : Promise.resolve(null),
    isOwnView ? listViews(me.id).catch(() => [] as DashboardView[]) : Promise.resolve([] as DashboardView[]),
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

  // ---- Forecast: extend cost-trajectory N days into the future.
  // Project from daily.costCents (in cents) × 1000 → millicents for the
  // forecaster, then collapse back. Bands widen with sqrt(d).
  const dailyMillicents = data.daily.map((d) => (d.costCents ?? 0) * 1000);
  const projection = forecast({ history: dailyMillicents, horizon: 30 });
  const projTotal = sumForecast(projection);

  // ---- Cost insights: only call the LLM for Pro/Team. Pure aggregates.
  const insights: Recommendation[] = limits.ai_features
    ? await generateInsights({
        byModel: data.modelMix.map((m) => ({
          model: m.label,
          billable: m.value,
          cache: 0,             // not broken out by model on the read path yet
          events: 0,
          cost_cents: 0,        // dashboard doesn't currently aggregate cost by model;
                                // the LLM gets the high-level mix and the totals.
        })),
        byRepo: data.topRepos.slice(0, 8).map((r) => ({
          repo: r.label,
          billable: r.value,
          events: r.value,
          cost_cents: 0,
          model: null,
        })),
        pluginFeatures: pluginImpact?.features ?? [],
        totalCostCents: data.daily.reduce((a, d) => a + (d.costCents ?? 0), 0),
        cacheHitRate: cacheHit,
      })
    : [];

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

      {/* Saved views tab strip + window selector. */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: space.x3, marginBottom: space.x3, flexWrap: "wrap" }}>
        {isOwnView && (
          <SavedViewsTabStrip views={savedViews} currentWin={windowOpt.value} />
        )}
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
          hint={tokenStatHint(data.today, baselineTokens)}
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

      {/* Cost breakdown panel — auditable decomposition of the 24h
          number into Anthropic's actual rate-sheet components. Cache
          writes (5m at 1.25× input rate, 1h at 2.00×) often dominate
          cmux/long-context spend; the headline $5/$25 input/output
          rates make this surprising the first time. */}
      {data.costBreakdown24h.total > 0 && (
        <div style={{ marginTop: space.x5 }}>
          <Card>
            <CardHeader
              title="cost breakdown · 24h"
              hint="auditable decomposition by Anthropic rate component — sums to the cost shown above"
            />
            <CostBreakdownPanel breakdown={data.costBreakdown24h} />
          </Card>
        </div>
      )}

      {/* Cost optimizer cards — Pro/Team only, rendered when LLM has
          something specific to suggest. Heuristics fill in if no LLM. */}
      {insights.length > 0 && (
        <div style={{ marginTop: space.x5 }}>
          <Card>
            <CardHeader
              title="suggestions"
              hint="automatic cost optimization, generated from your usage"
            />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: space.x3, marginTop: space.x3 }}>
              {insights.map((r, i) => (
                <InsightCard key={i} rec={r} />
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Plugin Impact card — visible whenever the ashlr-plugin has
          contributed any tokens_saved in the user's history. */}
      {pluginImpact && pluginImpact.tokensSaved > 0 && (
        <div style={{ marginTop: space.x5 }}>
          <PluginImpactCard impact={pluginImpact} />
        </div>
      )}

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
                valueFormat="abbrev"
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
              valueFormat="abbrev"
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

        <ChartFrame
          title={`cost trajectory · last ${windowOpt.days}d + 30d projection`}
          hint={projTotal.p50 > 0 ? `~$${(projTotal.p50 / 100_000).toFixed(0)} projected next 30d · ±$${((projTotal.p90 - projTotal.p10) / 200_000).toFixed(0)}` : "cumulative dollars"}
          accent={palette.magenta}
        >
          {data.costTrajectory.length > 0 ? (
            <LineChart
              data={buildTrajectoryWithForecast(data.costTrajectory, projection)}
              series={[
                { key: "cost",       label: "cumulative $",   color: palette.magenta },
                { key: "projected",  label: "projected",      color: palette.amber },
              ]}
              yFormat="dollars-int"
              valueFormat="dollars-2dp"
            />
          ) : (
            <EmptyChart label="No cost data yet." />
          )}
        </ChartFrame>

        {/* Token-type breakdown — proves the billable-vs-total split.
            Stacked area shows where the volume actually goes:
            input + output (real work) vs cache (mechanism). */}
        <ChartFrame
          title={`token mix · last ${windowOpt.days}d`}
          hint="input · output · reasoning · cache (read + 5m + 1h)"
          accent={palette.cyan}
        >
          {data.tokenBreakdown.some((b) =>
            b.input + b.output + b.reasoning + b.cache_read + b.cache_5m_write + b.cache_1h_write + b.cache_write_legacy > 0
          ) ? (
            <StackedAreaChart
              data={data.tokenBreakdown}
              series={["input", "output", "reasoning", "cache_read", "cache_5m_write", "cache_1h_write", "cache_write_legacy"]}
              valueFormat="abbrev"
            />
          ) : (
            <EmptyChart label="No token data yet." />
          )}
        </ChartFrame>

        {/* Per-model cost stacked area — answers "which model drives spend?"
            Series are ordered by 14d cost desc; long tail collapses to "other". */}
        <ChartFrame
          title={`cost by model · last ${windowOpt.days}d`}
          hint="daily cost ($) stacked by model"
          accent={palette.amber}
        >
          {data.models.length > 0 ? (
            <StackedAreaChart
              data={data.byModel.map((row) => {
                // Convert cents → dollars for display continuity with the
                // cost-trajectory chart.
                const out: { bucket: string; [k: string]: string | number } = { bucket: row.bucket as string };
                for (const m of data.models) {
                  const v = row[m];
                  out[m] = typeof v === "number" ? v / 100 : 0;
                }
                return out;
              })}
              series={data.models}
              valueFormat="dollars-2dp"
            />
          ) : (
            <EmptyChart label="No priced data yet." />
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
                yFormat="int"
                valueFormat="locale"
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
          yFormat="decimal-1"
          valueFormat="ratio"
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

// ProjectRollupTable / ActivityFeed / kind helpers moved to
// ./_components/* — imported at the top. Format helpers (`abbrev`,
// `fmtAgoShort`, `th`, `td`, `kindColor`, `kindChip`) live in
// ./_components/dashboard-format and are re-imported here so the
// other inline components below can keep using them unchanged.

function SavedViewsTabStrip({
  views,
  currentWin,
}: { views: DashboardView[]; currentWin: string }): ReactElement {
  // "All" is implicit — always present, leftmost, links to /app with no
  // overrides so it cleanly resets state.
  const tabs = [
    { label: "All", href: "/app", active: views.every((v) => v.filter.win !== currentWin) && currentWin === "14" },
    ...views.map((v) => ({
      label: v.name,
      href: viewToHref(v.filter),
      active: false, // we don't have a reliable way to know which view is
                     // currently active without diffing all filter dims;
                     // the user re-clicks if they want to switch.
    })),
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: space.x2, flexWrap: "wrap" }}>
      {tabs.map((t) => (
        <a
          key={t.label + t.href}
          href={t.href}
          style={{
            fontSize: 11,
            padding: "4px 10px",
            border: `1px solid ${t.active ? palette.cyan : palette.border}`,
            borderRadius: 999,
            color: t.active ? palette.cyan : palette.textDim,
            textDecoration: "none",
            background: t.active ? `${palette.cyan}15` : "transparent",
            letterSpacing: 0.3,
          }}
        >
          {t.label}
        </a>
      ))}
      <a
        href="/share?save_view=1"
        title="Save the current filters as a named view (coming soon)"
        style={{
          fontSize: 11,
          padding: "4px 10px",
          border: `1px dashed ${palette.border}`,
          borderRadius: 999,
          color: palette.textMute,
          textDecoration: "none",
        }}
      >
        + save current
      </a>
    </div>
  );
}

interface PluginImpact {
  tokensSaved: number;
  breakdown: { genome: number; snipcompact: number; route: number };
  features: string[];
  estUsdSavedCents: number;
  daysCovered: number;
}

async function loadPluginImpact(userId: string): Promise<PluginImpact | null> {
  // Sum tokens_saved + per-feature breakdown over the last 14d. Models
  // are NOT joined to a price here — the counterfactual cost estimate
  // uses input rate as a conservative lower bound.
  const db = sql();
  try {
    const rows = await db<{
      tokens_saved: string | number | null;
      saved_genome: string | number | null;
      saved_snip:   string | number | null;
      saved_route:  string | number | null;
      features:     string[] | null;
    }[]>`
      SELECT
        COALESCE(SUM(tokens_saved), 0)::bigint                                         AS tokens_saved,
        COALESCE(SUM((tokens_saved_breakdown->>'genome')::int), 0)::bigint             AS saved_genome,
        COALESCE(SUM((tokens_saved_breakdown->>'snipcompact')::int), 0)::bigint        AS saved_snip,
        COALESCE(SUM((tokens_saved_breakdown->>'route')::int), 0)::bigint              AS saved_route,
        ARRAY(
          SELECT DISTINCT unnest(plugin_features)
          FROM activity_event
          WHERE user_id = ${userId}::uuid
            AND ts >= NOW() - INTERVAL '14 days'
            AND plugin_features IS NOT NULL
        ) AS features
      FROM activity_event
      WHERE user_id = ${userId}::uuid
        AND ts >= NOW() - INTERVAL '14 days'
        AND tokens_saved IS NOT NULL
        AND tokens_saved > 0
    `;
    const r = rows[0];
    if (!r) return null;
    const tokensSaved = Number(r.tokens_saved ?? 0);
    if (tokensSaved === 0) return null;
    // Conservative counterfactual: input rate of $5/M (Opus 4.7).
    const estUsdSavedCents = Math.round(tokensSaved * 5 / 10_000); // tokens × $5/M → cents
    return {
      tokensSaved,
      breakdown: {
        genome:      Number(r.saved_genome ?? 0),
        snipcompact: Number(r.saved_snip   ?? 0),
        route:       Number(r.saved_route  ?? 0),
      },
      features: r.features ?? [],
      estUsdSavedCents,
      daysCovered: 14,
    };
  } catch {
    return null;
  }
}

function PluginImpactCard({ impact }: { impact: PluginImpact }): ReactElement {
  const totalBreakdown =
    impact.breakdown.genome + impact.breakdown.snipcompact + impact.breakdown.route;
  const pct = (n: number): number =>
    totalBreakdown === 0 ? 0 : Math.round((n / totalBreakdown) * 100);
  return (
    <Card accent={palette.green}>
      <CardHeader
        title="ashlr-plugin impact"
        hint={`last ${impact.daysCovered}d · ${impact.features.join(" · ") || "unspecified features"}`}
      />
      <div style={{ display: "flex", alignItems: "baseline", gap: space.x4, marginTop: space.x3, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 28, color: palette.green, fontVariantNumeric: "tabular-nums" }}>
            {abbrev(impact.tokensSaved)}
          </div>
          <div style={{ fontSize: 11, color: palette.textMute, letterSpacing: 0.5, textTransform: "uppercase" }}>
            tokens saved
          </div>
        </div>
        <div>
          <div style={{ fontSize: 22, color: palette.cyan, fontVariantNumeric: "tabular-nums" }}>
            ~{fmtUsd(impact.estUsdSavedCents)}
          </div>
          <div style={{ fontSize: 11, color: palette.textMute, letterSpacing: 0.5, textTransform: "uppercase" }}>
            estimated — conservative
          </div>
        </div>
        {totalBreakdown > 0 && (
          <div style={{ flex: 1, minWidth: 240 }}>
            <BreakdownBar parts={[
              { label: "genome",      value: impact.breakdown.genome,      pct: pct(impact.breakdown.genome),      color: palette.green },
              { label: "snipcompact", value: impact.breakdown.snipcompact, pct: pct(impact.breakdown.snipcompact), color: palette.cyan },
              { label: "route",       value: impact.breakdown.route,       pct: pct(impact.breakdown.route),       color: palette.amber },
            ]} />
          </div>
        )}
      </div>
    </Card>
  );
}

function BreakdownBar({
  parts,
}: { parts: { label: string; value: number; pct: number; color: string }[] }): ReactElement {
  return (
    <div>
      <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: palette.bgRaised }}>
        {parts.map((p) => (
          p.pct > 0 && (
            <div key={p.label} style={{ width: `${p.pct}%`, background: p.color, transition: "width 0.5s ease" }} />
          )
        ))}
      </div>
      <div style={{ display: "flex", gap: space.x3, fontSize: 11, marginTop: space.x2, flexWrap: "wrap" }}>
        {parts.map((p) => (
          <span key={p.label} style={{ color: palette.textDim }}>
            <span style={{ color: p.color }}>●</span> {p.label} · {abbrev(p.value)}
          </span>
        ))}
      </div>
    </div>
  );
}

function CostBreakdownPanel({
  breakdown,
}: { breakdown: import("@/lib/pricing").CostBreakdownMillicents }): ReactElement {
  // Order rows by typical magnitude so the dominant components surface
  // at the top. cache_read is usually the biggest line in cmux flows
  // (10% of input rate × huge cache volumes); 5m/1h writes follow.
  const rows: { label: string; rate: string; ms: number; color: string }[] = [
    { label: "input",            rate: "1.00× model rate",  ms: breakdown.input,              color: palette.cyan    },
    { label: "output",           rate: "1.00× output rate", ms: breakdown.output,             color: palette.magenta },
    { label: "reasoning",        rate: "1.00× output rate", ms: breakdown.reasoning,          color: palette.purple  },
    { label: "cache read",       rate: "0.10× input rate",  ms: breakdown.cache_read,         color: palette.green   },
    { label: "cache write · 5m", rate: "1.25× input rate",  ms: breakdown.cache_5m_write,     color: palette.amber   },
    { label: "cache write · 1h", rate: "2.00× input rate",  ms: breakdown.cache_1h_write,     color: palette.amber   },
    { label: "cache (legacy)",   rate: "1.25-2× input",     ms: breakdown.cache_write_legacy, color: palette.textDim },
  ].filter((r) => r.ms > 0);
  const total = breakdown.total || 1;
  return (
    <div style={{ marginTop: space.x3 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: `1px solid ${palette.border}` }}>
            <th style={th}>component</th>
            <th style={th}>rate</th>
            <th style={{ ...th, textAlign: "right" }}>$</th>
            <th style={{ ...th, textAlign: "right" }}>%</th>
            <th style={{ ...th, width: "30%" }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pct = (r.ms / total) * 100;
            return (
              <tr key={r.label} style={{ borderBottom: `1px dashed ${palette.border}` }}>
                <td style={td}>
                  <span style={{ color: r.color }}>●</span>
                  <span style={{ color: palette.text, marginLeft: 8 }}>{r.label}</span>
                </td>
                <td style={{ ...td, color: palette.textMute, fontSize: 11 }}>{r.rate}</td>
                <td style={{ ...td, textAlign: "right", color: palette.text, fontVariantNumeric: "tabular-nums" }}>
                  {fmtUsd(Math.round(r.ms / 1000))}
                </td>
                <td style={{ ...td, textAlign: "right", color: palette.textDim, fontVariantNumeric: "tabular-nums" }}>
                  {pct.toFixed(1)}%
                </td>
                <td style={td}>
                  <div style={{ height: 6, background: palette.bgRaised, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(100, pct)}%`, background: r.color, transition: "width 0.5s ease" }} />
                  </div>
                </td>
              </tr>
            );
          })}
          <tr style={{ borderTop: `1px solid ${palette.border}` }}>
            <td style={{ ...td, color: palette.text, fontWeight: 500 }}>total</td>
            <td style={td}></td>
            <td style={{ ...td, textAlign: "right", color: palette.magenta, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
              {fmtUsd(Math.round(breakdown.total / 1000))}
            </td>
            <td style={{ ...td, textAlign: "right", color: palette.textDim }}>100%</td>
            <td style={td}></td>
          </tr>
        </tbody>
      </table>
      {breakdown.cache_5m_write + breakdown.cache_1h_write + breakdown.cache_write_legacy > breakdown.input + breakdown.output + breakdown.reasoning && (
        <div style={{ marginTop: space.x3, fontSize: 11, color: palette.textMute, lineHeight: 1.5 }}>
          Cache writes ({fmtUsd(Math.round((breakdown.cache_5m_write + breakdown.cache_1h_write + breakdown.cache_write_legacy) / 1000))}) outweigh input + output + reasoning ({fmtUsd(Math.round((breakdown.input + breakdown.output + breakdown.reasoning) / 1000))}). Anthropic charges 5-minute cache writes at 1.25× and 1-hour writes at 2.00× input rate, so cmux + long-context flows pay more for caching context than for the model invocations themselves.
        </div>
      )}
    </div>
  );
}

function InsightCard({ rec }: { rec: Recommendation }): ReactElement {
  const accent =
    rec.kind === "model_swap"            ? palette.cyan :
    rec.kind === "enable_plugin_feature" ? palette.green :
    rec.kind === "cache_strategy"        ? palette.amber :
                                            palette.magenta;
  return (
    <div style={{
      border: `1px solid ${accent}30`,
      borderRadius: 8,
      padding: space.x3,
      background: `${accent}08`,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: space.x2, marginBottom: space.x2 }}>
        <span style={{
          fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase",
          color: accent,
        }}>{rec.kind.replace(/_/g, " ")}</span>
        {rec.est_savings_usd_month > 0 && (
          <span style={{ fontSize: 10, color: palette.textMute, marginLeft: "auto" }}>
            ~${rec.est_savings_usd_month}/mo
          </span>
        )}
      </div>
      <div style={{ fontSize: 13, color: palette.text, fontWeight: 500, marginBottom: space.x2 }}>
        {rec.title}
      </div>
      <div style={{ fontSize: 12, color: palette.textDim, lineHeight: 1.5, marginBottom: space.x2 }}>
        {rec.detail}
      </div>
      <div style={{ fontSize: 11, color: accent }}>
        {rec.cta} →
      </div>
    </div>
  );
}

function buildTrajectoryWithForecast(
  history: { bucket: string; cents: number }[],
  projection: ForecastPoint[],
): LinePoint[] {
  // Splice historical cumulative cost (in dollars) with projected
  // cumulative cost. The two series ride a single x-axis: history rows
  // omit the `projected` key (so the projected line doesn't render
  // there), future rows omit `cost` (so the actual line stops cleanly).
  // The boundary day carries both keys so both lines connect through
  // the same point — visually continuous.
  if (history.length === 0) return [];
  const out: LinePoint[] = history.map((p) => ({
    bucket: p.bucket,
    cost: p.cents / 100,
  }));

  let runningCents = history[history.length - 1].cents;
  // Anchor projection at the last historical point.
  out[out.length - 1].projected = runningCents / 100;
  const baseMs = Date.now();
  for (const f of projection) {
    runningCents += f.p50 / 1000; // millicents → cents
    const date = new Date(baseMs + f.d * 86_400_000);
    out.push({
      bucket: date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      projected: runningCents / 100,
    });
  }
  return out;
}

function buildHref(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `/app?${s}` : "/app";
}

// `abbrev` is now imported from ./_components/dashboard-format.

function tokenStatHint(
  today: { tokens: number; tokensTotal: number },
  baseline: number,
): string | undefined {
  // Show cache load explicitly so users understand why cost can be
  // large even when the displayed (billable) token count is small.
  // "6.2M billable" + "+ 187M cache" is the honest split; previously
  // we showed only the billable number while pricing the cache.
  const cacheTokens = Math.max(0, today.tokensTotal - today.tokens);
  const baselinePart = baseline ? `vs ${abbrev(baseline)} median` : null;
  const cachePart    = cacheTokens > 0 ? `+ ${abbrev(cacheTokens)} cache` : null;
  return [cachePart, baselinePart].filter(Boolean).join(" · ") || undefined;
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

// `fmtAgoShort` is now imported from ./_components/dashboard-format.

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
