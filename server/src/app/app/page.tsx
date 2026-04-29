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

import { Header } from "@/components/Header";
import { StatCard } from "@/components/StatCard";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Skeleton } from "@/components/ui/Skeleton";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { StackedAreaChart } from "@/components/charts/StackedAreaChart";
import { HBarChart } from "@/components/charts/HBarChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { Heatmap } from "@/components/charts/Heatmap";
import { LineChart } from "@/components/charts/LineChart";
import { RadialGauge } from "@/components/charts/RadialGauge";

import { palette, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

interface SearchParams { as?: string }

export default async function Page({
  searchParams,
}: { searchParams: Promise<SearchParams> }): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const { as } = await searchParams;
  let targetUserId = me.id;
  let scope: ScopeFilter = { repoClauseSql: "", repoParams: [] };
  let peerLabel: string | null = null;

  if (as && as !== me.id) {
    const grants = (await listGrantsForViewer(me.id)).filter((g) => g.owner_id === as);
    if (grants.length === 0) {
      redirect(`/share?error=${encodeURIComponent("no active grant from that user")}`);
    }
    targetUserId = as;
    scope = buildScopeFilter(grants);
    peerLabel = grants[0].owner_email ?? "peer";
  }

  const isOwnView = targetUserId === me.id;
  const nowUtc = new Date();
  const since24hUtc = new Date(nowUtc.getTime() - 24 * 3600_000).toISOString();

  // Run all the heavy lifts in parallel.
  const [data, agentStatus, missedRepos] = await Promise.all([
    loadDashboard(targetUserId, scope),
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

      {/* Stat strip — first 1 second of value. */}
      <div style={statStrip}>
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

      {/* AI briefing — async-streamed via Suspense. */}
      <div style={{ marginTop: space.x5 }}>
        <Suspense fallback={<BriefingSkeleton />}>
          <BriefingPanel userId={targetUserId} inputs={briefingInputs} />
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
      <div style={{ marginTop: space.x6, ...gridTwoCols }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <ChartFrame
            title="activity · last 14 days"
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

        <ChartFrame title="cost trajectory · last 14d" hint="cumulative dollars" accent={palette.magenta}>
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

        <ChartFrame title="cache efficiency · last 14d" hint="read-to-write ratio" accent={palette.amber}>
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

        <div style={{ gridColumn: "1 / -1" }}>
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

      {/* Recent commits + activity feed. */}
      <div style={{ marginTop: space.x6, ...gridTwoCols }}>
        <Card>
          <CardHeader title="recent commits · last 14d" hint={`${data.recentCommits.length} commits`} />
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
  userId, inputs,
}: { userId: string; inputs: BriefingInputs }): Promise<ReactElement> {
  const briefing = await getOrComputeBriefing(userId, inputs);
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

const statStrip: React.CSSProperties = {
  display:        "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
  gap:            space.x3,
};

const gridTwoCols: React.CSSProperties = {
  display:        "grid",
  gridTemplateColumns: "1fr 1fr",
  gap:            space.x4,
};

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

function buildScopeFilter(grants: PeerShareRow[]): ScopeFilter {
  // Build a UNION of OR-clauses across all grants.
  // realtime/daily/weekly/monthly granularity is handled at dashboard
  // load time elsewhere — this just narrows by scope_type/scope_value.
  let pIdx = 2; // $1 is user_id, scope params start at $2
  const ors: string[] = [];
  const params: (string | number)[] = [];

  for (const g of grants) {
    if (g.scope_type === "all") {
      // No restriction; remove anything else and break.
      return { repoClauseSql: "", repoParams: [] };
    }
    if (g.scope_type === "repo_pattern" && g.scope_value) {
      ors.push(`repo_name LIKE $${pIdx++}`);
      params.push(g.scope_value);
    }
    // project scope is handled via project_repo join — for now skip
    // (the existing implementation also required a join).
  }

  if (ors.length === 0) return { repoClauseSql: "", repoParams: [] };
  return {
    repoClauseSql: `AND (${ors.join(" OR ")})`,
    repoParams: params,
  };
}
