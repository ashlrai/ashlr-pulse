/**
 * /app — the cyber/agentic dashboard shell.
 *
 * Modes:
 *   1. /app           → your own activity, tab=today by default
 *   2. /app?as=<id>   → peer-share view (filtered by active grant)
 *   3. /app?tab=X     → jump directly to a named tab
 *
 * This file owns: auth check, data loading (once, in parallel), and tab
 * routing. Rendering is fully delegated to _tabs/*.tsx — each tab receives
 * the full DashboardData payload and any derived values it needs.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";

import { currentUser } from "@/lib/current-user";
import { listGrantsForViewer, type PeerShareRow } from "@/lib/peer-share-db";
import { fmtUsd } from "@/lib/pricing";
import { getAgentStatus } from "@/lib/heartbeat";
import { loadMissedRepos } from "@/lib/missed-repos";
import { loadDashboard, type ScopeFilter } from "@/lib/dashboard-data";
import { type BriefingInputs } from "@/lib/briefing";
import { detectAnomaly } from "@/lib/anomalies";
import { generateInsights } from "@/lib/cost-insights";
import { forecast, sumForecast, type ForecastPoint } from "@/lib/forecast";
import { sql } from "@/lib/db";
import { listViews, type DashboardView, viewToHref } from "@/lib/dashboard-view-db";
import { primaryOrgForUser, subscriptionSourcesFor } from "@/lib/org-db";
import {
  limitsFor,
  FREE_LIMITS,
  isSubscriptionMode,
  BILLING_MODE_MONTHLY_CAP_USD,
  type BillingMode,
} from "@/lib/plan-gate";
import { type LinePoint } from "@/components/charts/LineChart";

import { Header } from "@/components/Header";
import { Banner } from "@/components/ui/Banner";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { ChipGroup } from "@/components/ui/ChipGroup";

import { palette, space } from "@/lib/theme";

import { TodayTab } from "./_tabs/today";
import { TrendsTab } from "./_tabs/trends";
import { CompareTab } from "./_tabs/compare";
import { CostsTab } from "./_tabs/costs";
import { ToolsTab } from "./_tabs/tools";
import { SavedViewsTabStrip } from "./_components/SavedViewsTabStrip";

export const dynamic = "force-dynamic";

// ─── Query-param schema ───────────────────────────────────────────────

interface SearchParams {
  as?: string;
  win?: string;
  src?: string;
  tab?: string;
  view?: string;
  project?: string;
}

const TABS = ["today", "trends", "compare", "costs", "tools"] as const;
type Tab = (typeof TABS)[number];

function resolveTab(raw: string | undefined): Tab {
  return TABS.includes(raw as Tab) ? (raw as Tab) : "today";
}

// ─── Source / window helpers ──────────────────────────────────────────

const SOURCE_OPTIONS = [
  { value: "",             label: "all" },
  { value: "claude_code",  label: "claude code" },
  { value: "codex",        label: "codex" },
  { value: "cursor",       label: "cursor" },
  { value: "copilot",      label: "copilot" },
  { value: "wakatime",     label: "wakatime" },
  { value: "shell",        label: "shell" },
  { value: "git",          label: "git" },
  { value: "ashlr_plugin", label: "plugin" },
];

function resolveSourceFilter(raw: string | undefined): string | null {
  if (!raw) return null;
  return SOURCE_OPTIONS.some((o) => o.value === raw) ? raw : null;
}

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

// ─── Page ─────────────────────────────────────────────────────────────

export default async function Page({
  searchParams,
}: { searchParams: Promise<SearchParams> }): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const { as, win, src, tab: tabParam } = await searchParams;
  const activeTab = resolveTab(tabParam);
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

  const billingMode: BillingMode = isOwnView
    ? ((org?.billing_mode ?? "api") as BillingMode)
    : "api";
  const isSubMode = isSubscriptionMode(billingMode);
  const monthlyCapUsd = BILLING_MODE_MONTHLY_CAP_USD[billingMode];

  // Subscription-mode set: zero cost for sources flagged "subscription".
  const subscriptionSources = isOwnView ? subscriptionSourcesFor(org) : new Set<string>();

  // Run all heavy lifts in parallel.
  const [data, agentStatus, missedRepos, pluginImpact, savedViews] = await Promise.all([
    loadDashboard(targetUserId, scope, {
      chartDays: windowOpt.days,
      limits,
      sourceFilter: resolveSourceFilter(src),
      subscriptionSources,
    }),
    isOwnView ? getAgentStatus(me.id, nowUtc) : Promise.resolve(null),
    isOwnView ? loadMissedRepos(me.id, since24hUtc, nowUtc.toISOString()) : Promise.resolve([]),
    isOwnView ? loadPluginImpact(targetUserId) : Promise.resolve(null),
    isOwnView ? listViews(me.id).catch(() => [] as DashboardView[]) : Promise.resolve([] as DashboardView[]),
  ]);

  // Compute prior-week medians for baselines + deltas.
  const prior7 = data.daily.slice(0, 7);
  const baselineEvents = median(prior7.map((d) => d.events));
  const baselineTokens = median(prior7.map((d) => d.tokens));
  const baselineCost   = median(prior7.map((d) => d.costCents ?? 0));

  // Anomaly detection — pure numeric, no API calls.
  const eventAnomaly = detectAnomaly({ current: data.today.events,             baseline: prior7.map((d) => d.events),              metric: "events", noun: "events" });
  const tokenAnomaly = detectAnomaly({ current: data.today.tokens,             baseline: prior7.map((d) => d.tokens),              metric: "tokens", noun: "tokens" });
  const costAnomaly  = detectAnomaly({ current: data.today.costCents ?? 0,     baseline: prior7.map((d) => d.costCents ?? 0),      metric: "cost",   noun: "spend"  });

  // Cache hit ratio (rolling 14d).
  const totalReads  = data.cacheEfficiency.reduce((a, b) => a + b.reads, 0);
  const totalWrites = data.cacheEfficiency.reduce((a, b) => a + b.writes, 0);
  const cacheHit = totalReads + totalWrites === 0 ? 0 : totalReads / (totalReads + totalWrites);

  const eventsDelta = baselineEvents > 0 ? data.today.events / baselineEvents - 1 : null;
  const tokensDelta = baselineTokens > 0 ? data.today.tokens / baselineTokens - 1 : null;
  const costDelta   = baselineCost > 0 && data.today.costCents != null
    ? data.today.costCents / baselineCost - 1
    : null;

  const agentSeenSecs = agentStatus?.seconds_ago ?? null;
  const agentAlive    = agentSeenSecs != null && agentSeenSecs < 5 * 60;

  // Forecast: extend cost-trajectory 30 days into the future.
  const dailyMillicents = data.daily.map((d) => (d.costCents ?? 0) * 1000);
  const projection = forecast({ history: dailyMillicents, horizon: 30 });

  // Pre-build trajectory+forecast point array for the LineChart.
  const trajectoryPoints = buildTrajectoryWithForecast(data.costTrajectory, projection);

  // Cost insights: Pro/Team only (LLM call).
  const insights = limits.ai_features
    ? await generateInsights({
        byModel: data.modelMix.map((m) => ({
          model: m.label, billable: m.value, cache: 0, events: 0, cost_cents: 0,
        })),
        byRepo: data.topRepos.slice(0, 8).map((r) => ({
          repo: r.label, billable: r.value, events: r.value, cost_cents: 0, model: null,
        })),
        pluginFeatures: pluginImpact?.features ?? [],
        totalCostCents: data.daily.reduce((a, d) => a + (d.costCents ?? 0), 0),
        cacheHitRate: cacheHit,
      })
    : [];

  // Briefing inputs (used only by TodayTab's async BriefingPanel).
  const briefingInputs: BriefingInputs = {
    events:            data.today.events,
    tokens:            data.today.tokens,
    costCents:         data.today.costCents,
    topRepos:          data.topRepos.slice(0, 6).map((r) => ({ repo: r.label, events: r.value })),
    topModels:         data.modelMix.slice(0, 4).map((m) => ({ model: m.label, tokens: m.value })),
    baselineEvents,
    baselineTokens,
    baselineCostCents: baselineCost,
    commits:           data.recentCommits.slice(0, 8).map((c) => c.subject),
  };

  // Shared tab props — passed to every tab component.
  const tabProps = {
    data,
    windowOpt,
    queryParams: { as, win, src, tab: tabParam },
    billingMode,
    isSubMode,
    monthlyCapUsd,
    cacheHit,
    totalReads,
    totalWrites,
    projection,
    trajectoryPoints,
    insights,
    pluginImpact,
    eventAnomaly,
    tokenAnomaly,
    costAnomaly,
    isOwnView,
  };

  return (
    <DashboardShell>
      <Header
        me={me}
        active="dashboard"
        agentAlive={isOwnView ? agentAlive : undefined}
        agentSeenSecondsAgo={agentSeenSecs}
      />

      {/* Peer-share banner */}
      {peerLabel && (
        <div style={{ marginBottom: space.x4 }}>
          <Banner variant="info" title={`viewing ${peerLabel}'s activity`}>
            scope filtered by active peer-share grants ·{" "}
            <a href="/app" style={{ color: palette.cyan }}>back to your view</a>
          </Banner>
        </div>
      )}

      {/* Missed-repos banner */}
      {missedRepos.length > 0 && (
        <div style={{ marginBottom: space.x4 }}>
          <Banner variant="warning" title="repos with commits but no agent activity">
            {missedRepos.join(", ")} — looks like the agent isn't running there.
          </Banner>
        </div>
      )}

      {/* Retention banner (free tier) */}
      {isOwnView && isFreeTier && (
        <div style={{ marginBottom: space.x4 }}>
          <Banner variant="info">
            Free tier shows last {limits.retention_days} days.{" "}
            <a href="/billing" style={{ color: palette.cyan }}>Upgrade for 90-day retention →</a>
          </Banner>
        </div>
      )}

      {/* Saved views + window selector */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: space.x3, marginBottom: space.x3, flexWrap: "wrap" }}>
        {isOwnView && (
          <SavedViewsTabStrip views={savedViews} currentWin={windowOpt.value} />
        )}
        <ChipGroup
          current={windowOpt.value}
          options={WIN_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
          hrefFor={(v) => buildHref({ as, win: v, src, tab: tabParam })}
        />
      </div>

      {/* Source filter */}
      <div style={{ display: "flex", alignItems: "center", gap: space.x2, marginTop: space.x3 }}>
        <span style={{ color: palette.textDim, fontSize: 11, letterSpacing: "0.5px", textTransform: "uppercase" }}>source</span>
        <ChipGroup
          current={src ?? ""}
          options={SOURCE_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
          hrefFor={(v) => buildHref({ as, win, src: v || undefined, tab: tabParam })}
        />
      </div>

      {/* Tab navigation */}
      <TabNav active={activeTab} queryParams={{ as, win, src }} />

      {/* Tab content */}
      {activeTab === "today" && (
        <TodayTab
          {...tabProps}
          briefingInputs={briefingInputs}
          userId={targetUserId}
          aiEnabled={limits.ai_features}
          eventsDelta={eventsDelta}
          tokensDelta={tokensDelta}
          costDelta={costDelta}
          baselineEvents={baselineEvents}
          baselineTokens={baselineTokens}
          baselineCost={baselineCost}
        />
      )}
      {activeTab === "trends"  && <TrendsTab  {...tabProps} />}
      {activeTab === "compare" && <CompareTab {...tabProps} />}
      {activeTab === "costs"   && <CostsTab   {...tabProps} />}
      {activeTab === "tools"   && <ToolsTab   {...tabProps} />}
    </DashboardShell>
  );
}

// ─── TabNav ───────────────────────────────────────────────────────────

const TAB_LABELS: Record<Tab, string> = {
  today:   "today",
  trends:  "trends",
  compare: "compare",
  costs:   "costs",
  tools:   "tools",
};

function TabNav({
  active,
  queryParams,
}: {
  active: Tab;
  queryParams: { as?: string; win?: string; src?: string };
}): ReactElement {
  return (
    <nav style={{
      display: "flex",
      gap: space.x2,
      marginTop: space.x4,
      marginBottom: space.x2,
      borderBottom: `1px solid ${palette.border}`,
      paddingBottom: 0,
    }}>
      {TABS.map((tab) => {
        const isActive = tab === active;
        return (
          <a
            key={tab}
            href={buildHref({ ...queryParams, tab })}
            style={{
              fontSize: 12,
              padding: "6px 14px",
              marginBottom: -1,
              color: isActive ? palette.cyan : palette.textDim,
              textDecoration: "none",
              letterSpacing: "0.4px",
              textTransform: "uppercase",
              borderBottom: isActive
                ? `2px solid ${palette.cyan}`
                : "2px solid transparent",
              background: "transparent",
              transition: "color 0.15s, border-color 0.15s",
            }}
          >
            {TAB_LABELS[tab]}
          </a>
        );
      })}
    </nav>
  );
}

// ─── SavedViewsTabStrip — extracted to _components ────────────────────
// (imported from ./_components/SavedViewsTabStrip above)

// ─── URL helpers ──────────────────────────────────────────────────────

function buildHref(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `/app?${s}` : "/app";
}

// ─── Pure utilities ───────────────────────────────────────────────────

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function buildTrajectoryWithForecast(
  history: { bucket: string; cents: number }[],
  projection: ForecastPoint[],
): LinePoint[] {
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

async function buildScopeFilter(grants: PeerShareRow[]): Promise<ScopeFilter> {
  let pIdx = 4;
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
      ors.push("FALSE");
    }
  }

  if (ors.length === 0) {
    return { repoClauseSql: "AND FALSE", repoParams: [] };
  }
  return {
    repoClauseSql: `AND (${ors.join(" OR ")})`,
    repoParams: params,
  };
}

// ─── Plugin impact loader ─────────────────────────────────────────────

interface PluginImpact {
  tokensSaved: number;
  breakdown: { genome: number; snipcompact: number; route: number };
  features: string[];
  estUsdSavedCents: number;
  daysCovered: number;
}

async function loadPluginImpact(userId: string): Promise<PluginImpact | null> {
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
    const estUsdSavedCents = Math.round(tokensSaved * 5 / 10_000);
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
