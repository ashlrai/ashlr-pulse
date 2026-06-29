/**
 * dashboard-data.ts — single aggregation layer for the /app dashboard.
 *
 * Does every Postgres round-trip needed to render the dashboard's stat
 * cards, eight charts, activity feed, and AI briefing inputs. The page
 * component is purely presentational on top of this.
 *
 * Privacy floor: every query reads the whitelisted columns from
 * activity_event + github_commit. No prompts, completions, or code.
 */

import { sql } from "@/lib/db";
import {
  costMillicents, millicentsToCents,
  costBreakdownMillicents, emptyBreakdown, addBreakdown,
  type CostBreakdownMillicents,
} from "@/lib/pricing";
import { retentionCutoff, type PlanLimits } from "@/lib/plan-gate";

export interface ScopeFilter {
  /** Raw SQL fragment, e.g. `AND repo_name LIKE $2`. Empty string = no filter. */
  repoClauseSql: string;
  /** Bind params consumed by repoClauseSql, in order. */
  repoParams: (string | number)[];
}

export interface LoadOpts {
  /** Chart window in days. Default 14. Stat-card today/yesterday/week
   *  totals always use their fixed (24h/48h/7d) windows. */
  chartDays?: number;
  /**
   * When set, clamps all queries to ts >= limits.retention_cutoff. Pass
   * the resolved PlanLimits from limitsFor(org) so free-tier users only
   * see their allowed retention window (7 days). When omitted no cutoff
   * is applied (no-op for paid plans).
   */
  limits?: PlanLimits;
  /**
   * Filter activity by source: 'claude_code', 'cursor', 'copilot',
   * 'shell', 'git', 'wakatime', 'ashlr_plugin', 'codex'. When omitted, all
   * sources are included. Validated against the schema's source enum at
   * the route layer.
   */
  sourceFilter?: string | null;
  /**
   * Sources flagged "subscription" in the org's source_subscription_modes
   * map. Events from these sources have their cost zeroed in headline
   * cost totals (stat cards, daily aggregates, project rollups, feed,
   * cost trajectory). Token counts are unaffected. Computed via
   * subscriptionSourcesFor(org) at the call site.
   */
  subscriptionSources?: Set<string>;
  /**
   * When set, restricts all queries to events belonging to a single
   * claude.session.id / ashlr.plugin.session_id value. Used by the
   * /sessions/[id] detail page to isolate one profiling session.
   * NULL means all sessions are included.
   */
  sessionFilter?: string | null;
}

export interface DashboardData {
  /** Today (last 24h) summary. `tokens` is BILLABLE tokens (input +
   *  output + reasoning) so the displayed $/token ratio matches
   *  intuition. `tokensTotal` includes cache reads & writes which
   *  drive cost but inflate the denominator if shown directly. */
  today: StatCard;
  yesterday: StatCard;
  week: StatCard;
  /** Daily totals over the last 14 days, with deltas baked in. */
  daily: DailyAggregate[];
  /** Last-24h cost decomposed by component so users can see exactly
   *  where the money went. cache_5m/1h writes often dominate cmux
   *  workloads even though the rate-sheet headline numbers ($5/$25
   *  input/output for Opus 4.7) don't suggest it. */
  costBreakdown24h: CostBreakdownMillicents;
  /** Per-day stacked token breakdown by type (Wave 1 token-trust chart). */
  tokenBreakdown: { bucket: string; input: number; output: number; reasoning: number; cache_read: number; cache_5m_write: number; cache_1h_write: number; cache_write_legacy: number }[];
  /** Per-day cost stacked by model, last chartDays. Wave 2/3 chart. */
  byModel: { bucket: string; [model: string]: string | number }[];
  /** Models present in byModel, ordered by total cost desc. */
  models: string[];
  /** Stacked-area chart data: 14 days × source. */
  stackedArea: { bucket: string; [source: string]: string | number }[];
  /** Sources present in the data, ordered by 14-day total desc. */
  sources: string[];
  /** Donut: model mix by tokens, last 7d. */
  modelMix: { label: string; value: number }[];
  /** Top repos by event count, last 7d. */
  topRepos: { label: string; value: number }[];
  /** Top tools by call count, last 7d. */
  topTools: { label: string; value: number }[];
  /** Repo × agent scoreboard over the selected chart window. */
  repoAgentRollup: RepoAgentRollup[];
  /** Repo focus chart: active time beside merged commit / PR output. */
  repoFocus: RepoFocusRow[];
  /** Per-repo source mix, derived from active-time attribution. */
  repoSourceMix: RepoSourceMixRow[];
  /** Tool × model call-count matrix over the selected chart window. */
  toolModelMatrix: ToolModelMatrix;
  /** Hour-of-day × day-of-week heatmap, last 30d. */
  heatmap: { dow: number; hour: number; value: number }[];
  /** Cumulative cost over last 14d. */
  costTrajectory: { bucket: string; cents: number }[];
  /** Cache efficiency over last 14d (read/write ratio per day). */
  cacheEfficiency: { bucket: string; ratio: number; reads: number; writes: number }[];
  /** Recent commits (subjects only) over last 24h. */
  recentCommits: { subject: string; repo: string; sha: string; ts: string }[];
  /** Recent activity feed (last N events). */
  feed: FeedRow[];
  /** Sparkline daily series for the 4 stat cards. */
  sparklines: { events: number[]; tokens: number[]; cost: number[]; commits: number[] };
  /** Project-level rollup over the chart window. */
  byProject: ProjectRollup[];
  /** GitHub activity per day over the chart window. */
  github: GithubDaily[];
  /** GitHub totals over the chart window. */
  githubTotals: { commits: number; prs_opened: number; prs_merged: number; reviews: number };
  /** Merged commit totals: GitHub where available, agent git as fallback. */
  commitTotals: { commits: number; githubCommits: number; agentGitCommits: number };
  /** Dashboard copy state for GitHub-backed commit detail panels. */
  githubState: DashboardGitHubState;
  /** Effective window in days that the charts cover. */
  chartDays: number;
  /** Fleet aggregates — null when no ashlr-fleet events in the window. */
  fleet: FleetData | null;
}

// ── Fleet types ─────────────────────────────────────────────────────────────

/** Per-teammate fleet activity breakdown (M109 fleet_owner). */
export interface FleetOwnerStat {
  /** Owner identifier — value of ashlr.fleet.owner attribute. */
  owner: string;
  proposals: number;
  merges: number;
  declines: number;
  ticks: number;
}

export interface FleetData {
  /** ISO timestamp of the last fleet.tick event, or null if no ticks. */
  lastTickTs: string | null;
  /** Total proposals in the chart window. */
  proposals: number;
  /** Total merges in the chart window. */
  merges: number;
  /** Total declines in the chart window. */
  declines: number;
  /** Total ticks in the chart window. */
  ticks: number;
  /** Proposals per repo (top 10 by proposals desc). */
  repoProposals: { label: string; value: number }[];
  /** Merges per repo (top 10 by merges desc). */
  repoMerges: { label: string; value: number }[];
  /** Engine mix by event count (for DonutChart). */
  engineMix: { label: string; value: number }[];
  /** Daily token + cost trend (for LineChart). */
  daily: FleetDailyPoint[];
  /** Recent merge events (last 20). */
  recentMerges: FleetMergeRow[];
  /**
   * Per-owner breakdown: proposals / merges / declines / ticks for each
   * teammate whose fleet_owner attribute was set (M109). Empty array when
   * no owner-tagged events are present (pre-M109 data or solo user).
   */
  byOwner: FleetOwnerStat[];
}

export interface FleetDailyPoint {
  bucket: string;
  /** All tokens (input + output) for fleet events on this day. */
  tokens: number;
  /** Cost in cents for fleet events on this day. */
  costCents: number;
  [k: string]: string | number;
}

export interface FleetMergeRow {
  ts: string;
  repo: string | null;
  /** gen_ai.system / provider (engine label). */
  engine: string | null;
  costCents: number | null;
}

export interface GithubDaily {
  bucket: string;
  commits: number;
  prs_opened: number;
  prs_merged: number;
  reviews: number;
  /** LineChart accepts arbitrary string keys; this index signature lets
   *  GithubDaily[] satisfy LinePoint[] without a cast. */
  [series: string]: string | number;
}

export interface StatCard {
  events: number;
  /** Billable tokens: input + output + reasoning. The denominator
   *  users intuit when they see "$X / Y tokens". */
  tokens: number;
  /** Full token volume including cache reads & writes — drives cost
   *  but is shown as a secondary number to avoid the $306/M illusion. */
  tokensTotal: number;
  costCents: number | null;
}

export interface ProjectRollup {
  project_id: string;
  project_name: string;
  kind: string;
  events: number;
  tokens: number;
  cents: number | null;
  repos: number;
}

export interface RepoAgentRollup {
  repo: string;
  claudeEvents: number;
  codexEvents: number;
  otherEvents: number;
  otherMinutes: number;
  claudeMinutes: number;
  codexMinutes: number;
  totalMinutes: number;
  tokens: number;
  costCents: number | null;
  commits: number;
  prsOpened: number;
  prsMerged: number;
}

export interface RepoFocusRow {
  repo: string;
  activeMinutes: number;
  commits: number;
  prs: number;
}

export interface RepoSourceMixRow {
  repo: string;
  claudeMinutes: number;
  codexMinutes: number;
  otherMinutes: number;
}

export type DashboardGitHubState = "ready" | "missing_or_stale" | "empty";

export interface ToolModelMatrix {
  rows: string[];
  cols: string[];
  cells: number[][];
}

export interface DailyAggregate {
  bucket: string; // YYYY-MM-DD
  events: number;
  /** Billable tokens (input + output + reasoning). */
  tokens: number;
  /** Full tokens including cache. */
  tokensTotal: number;
  costCents: number | null;
  commits: number;
}

export interface FeedRow {
  ts: string;
  source: string;
  model: string | null;
  repo: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  /** Sum of cache_read + cache_5m + cache_1h + legacy cache_write. */
  tokens_cache: number | null;
  duration_ms: number | null;
  costCents: number | null;
}

interface RawEvent {
  ts: string;
  source: string;
  provider: string | null;
  model: string | null;
  repo_name: string | null;
  duration_ms: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  tokens_cache_5m_write: number | null;
  tokens_cache_1h_write: number | null;
  tool_calls_count: number | null;
  tool_calls_types: string[] | null;
  /** Cached cost at ingest, in millicents. NULL on legacy rows pre-0015
   *  — we fall back to recomputing via costMillicents() per row.
   *  postgres-js returns int8 columns as either bigint or string
   *  depending on driver config, so the runtime type is wider than
   *  the schema's "BIGINT" suggests; resolveMillicents() coerces. */
  cost_millicents: number | bigint | string | null;
  /** Fleet-specific — null for non-fleet sources (added in 0025). */
  fleet_event: string | null;
  fleet_outcome: string | null;
  /** Fleet owner — null for non-fleet sources (added in 0026). */
  fleet_owner: string | null;
}

export interface ActiveTimeEvent {
  ts: string;
  source: string;
  repo_name: string | null;
  duration_ms: number | null;
}

export interface CommitRollupEvent {
  repo: string;
  ts: string;
}

export interface MergedCommitRollup {
  commitsByDay: Map<string, number>;
  commitsByRepo: Map<string, number>;
  totalCommits: number;
  githubCommits: number;
  agentGitCommits: number;
}

export const ACTIVE_GAP_CAP_MINUTES = 10;
const ACTIVE_GAP_CAP_MS = ACTIVE_GAP_CAP_MINUTES * 60_000;
const ACTIVE_SINGLE_EVENT_MS = 60_000;
const MAX_MEANINGFUL_DURATION_MS = 4 * 60 * 60_000;

/**
 * Loads everything the dashboard needs in one shot. Heavy enough that
 * we only call it once per page render — never on a hot path.
 */
export async function loadDashboard(
  userId: string,
  scope: ScopeFilter,
  opts: LoadOpts = {},
): Promise<DashboardData> {
  const chartDays = clampDays(opts.chartDays ?? 14);
  const db = sql();

  // Retention cutoff: free-tier users see at most 7 days of data.
  // We clamp the SQL window to min(sqlWindowDays, retentionDays) so
  // the query never returns rows the plan doesn't allow.
  const retCutoff = opts.limits ? retentionCutoff(opts.limits) : null;

  // Pull a window of raw rows; we'll bucket in memory. The window is
  // max(chartDays, 30) so the 30d heatmap always has data even when
  // the user picks a 7d chart range. ~30k rows × in-memory bucketing
  // is well under postgres-js + Node's memory budget.
  const sqlWindowDays = Math.max(chartDays, 30);
  // Bind layout (fixed slots, then variadic):
  //   $1 = user_id
  //   $2 = retCutoff (nullable; NULL → no retention clamp)
  //   $3 = sourceFilter (nullable; NULL → all sources)
  //   $4+ = scope params from buildScopeFilter (peer-share)
  // The OR-NULL fragments turn each fixed slot into a no-op when the
  // bind is NULL — keeps the SQL string static so postgres can plan it.
  const retParam: string | null = retCutoff ? retCutoff.toISOString() : null;
  const sourceParam: string | null = opts.sourceFilter ?? null;
  const events = await db.unsafe<RawEvent[]>(
    `
    SELECT
      ts::text                AS ts,
      source,
      provider,
      model,
      repo_name,
      duration_ms,
      tokens_input,
      tokens_output,
      tokens_reasoning,
      tokens_cache_read,
      tokens_cache_write,
      tokens_cache_5m_write,
      tokens_cache_1h_write,
      tool_calls_count,
      tool_calls_types,
      cost_millicents,
      fleet_event,
      fleet_outcome,
      fleet_owner
    FROM activity_event
    WHERE user_id = $1
      AND ts >= NOW() - INTERVAL '${sqlWindowDays} days'
      AND ($2::timestamptz IS NULL OR ts >= $2::timestamptz)
      AND ($3::text IS NULL OR source = $3::text)
      ${scope.repoClauseSql}
    ORDER BY ts DESC
    `,
    [userId, retParam, sourceParam, ...scope.repoParams],
  );

  // Session filter: isolate a single claude.session.id / ashlr.plugin.session_id.
  // Applied in-memory so we don't disturb the fixed-slot SQL bind layout
  // (scope params already occupy $4+). Sessions are a small fraction of
  // the total event window so this is safe.
  const filteredEvents = opts.sessionFilter
    ? events.filter((e) => (e as unknown as { session_id?: string | null }).session_id === opts.sessionFilter)
    : events;

  const githubRepoClauseSql = scope.repoClauseSql.replaceAll("repo_name", "gr.full_name");
  const projectRepoClauseSql = rebaseScopePlaceholders(
    scope.repoClauseSql.replaceAll("repo_name", "ae.repo_name"),
    3,
  );

  // Pull last chartDays of github commits (subjects only — public info).
  // github_event ⨝ github_account (account_id) ⨝ github_repo (repo_id).
  // Retention cutoff at $2 (nullable) — see events query above. $3 is
  // reserved as a dummy slot so peer-share repo params retain their $4+
  // placeholder numbering from buildScopeFilter().
  const commits = await db.unsafe<{ subject: string; repo: string; sha: string; ts: string }[]>(
    `
    SELECT
      ge.message_first_line AS subject,
      gr.full_name          AS repo,
      ge.external_id        AS sha,
      ge.ts::text           AS ts
    FROM github_event ge
    JOIN github_account ga ON ga.id = ge.account_id
    JOIN github_repo    gr ON gr.id = ge.repo_id
    WHERE ga.user_id = $1::uuid
      AND ge.kind    = 'commit'
      AND ge.ts >= NOW() - INTERVAL '${chartDays} days'
      AND ($2::timestamptz IS NULL OR ge.ts >= $2::timestamptz)
      AND ($3::text IS NULL OR $3::text IS NULL)
      ${githubRepoClauseSql}
    ORDER BY ge.ts DESC
    LIMIT 50
    `,
    [userId, retParam, sourceParam, ...scope.repoParams],
  ).catch(() => [] as { subject: string; repo: string; sha: string; ts: string }[]);

  // Pull GitHub events for daily PR throughput aggregation.
  const ghEvents = await db.unsafe<{ kind: string; repo: string; ts: string }[]>(
    `
    SELECT ge.kind, gr.full_name AS repo, ge.ts::text AS ts
    FROM github_event ge
    JOIN github_account ga ON ga.id = ge.account_id
    JOIN github_repo    gr ON gr.id = ge.repo_id
    WHERE ga.user_id = $1::uuid
      AND ge.ts >= NOW() - INTERVAL '${chartDays} days'
      AND ($2::timestamptz IS NULL OR ge.ts >= $2::timestamptz)
      AND ($3::text IS NULL OR $3::text IS NULL)
      ${githubRepoClauseSql}
    `,
    [userId, retParam, sourceParam, ...scope.repoParams],
  ).catch(() => [] as { kind: string; repo: string; ts: string }[]);

  // Load project rollups in parallel — small query, joins activity_event
  // to project_repo. Bounded to chartDays. Cost comes from cached
  // cost_millicents (migration 0015); rows pre-0015 contribute zero
  // until a backfill runs, but recent data is accurate.
  const projectRaw = await db.unsafe<{
    project_id: string;
    project_name: string;
    kind: string;
    repos: number;
    events: number;
    // postgres-js returns bigint as string in some configurations; we
    // accept either and coerce in the JS map below. Casting to ::int on
    // the server side risks silent overflow on large workloads (cmux
    // teams routinely exceed INT_MAX in a 14-day token sum).
    tokens: string | number;
    millicents: string | number | null;
  }[]>(
    `
    SELECT
      p.id::text          AS project_id,
      p.name              AS project_name,
      p.kind              AS kind,
      COUNT(DISTINCT pr.repo_name)::int AS repos,
      COUNT(ae.*)::int    AS events,
      COALESCE(SUM(COALESCE(ae.tokens_input, 0) + COALESCE(ae.tokens_output, 0) + COALESCE(ae.tokens_reasoning, 0)), 0)::bigint AS tokens,
      COALESCE(SUM(
        CASE WHEN ae.source = ANY($2::text[]) THEN 0 ELSE ae.cost_millicents END
      ), 0)::bigint AS millicents
    FROM project p
    JOIN membership m  ON m.org_id    = p.org_id AND m.user_id = $1::uuid
    JOIN project_repo pr ON pr.project_id = p.id
    LEFT JOIN activity_event ae
      ON ae.repo_name = pr.repo_name
     AND ae.user_id   = $1::uuid
     AND ae.ts >= NOW() - INTERVAL '${chartDays} days'
     ${projectRepoClauseSql}
    GROUP BY p.id, p.name, p.kind
    HAVING COUNT(ae.*) > 0
    ORDER BY tokens DESC, events DESC
    LIMIT 20
    `,
    [userId, [...(opts.subscriptionSources ?? [])], ...scope.repoParams],
  ).catch(() => [] as never[]);

  // Convert millicents → integer cents at the boundary; NULL stays NULL
  // so the UI renders "—" cleanly when there's no priced data.
  const projectRollups: ProjectRollup[] = projectRaw.map((r) => {
    const m = r.millicents == null ? null : Number(r.millicents);
    return {
      project_id: r.project_id,
      project_name: r.project_name,
      kind: r.kind,
      repos: r.repos,
      events: r.events,
      tokens: Number(r.tokens),
      cents: m == null || m === 0 ? null : millicentsToCents(m),
    };
  });

  return computeAggregates(filteredEvents, commits, ghEvents, projectRollups, chartDays, opts.subscriptionSources, retCutoff);
}

interface BreakdownRow {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_5m_write: number;
  cache_1h_write: number;
  cache_write_legacy: number;
}
function blankBreakdown(): BreakdownRow {
  return {
    input: 0, output: 0, reasoning: 0,
    cache_read: 0, cache_5m_write: 0, cache_1h_write: 0, cache_write_legacy: 0,
  };
}

function computeAggregates(
  events: RawEvent[],
  commits: { subject: string; repo: string; sha: string; ts: string }[],
  ghEvents: { kind: string; repo: string; ts: string }[],
  byProject: ProjectRollup[],
  chartDays: number,
  subscriptionSources: Set<string> | undefined,
  retCutoff: Date | null = null,
): DashboardData {
  const now = Date.now();
  const D_MS = 86_400_000;

  const today: SumBucket    = newSum();
  const yesterday: SumBucket = newSum();
  const week: SumBucket      = newSum();
  const dailyMap = new Map<string, SumBucket>(); // YYYY-MM-DD → sum
  const stackedMap = new Map<string, Record<string, number>>(); // bucket → source → tokens
  const sourceTotals = new Map<string, number>();
  const modelTokens = new Map<string, number>();
  const modelByDayMillicents = new Map<string, Map<string, number>>(); // model → day → millicents
  const modelTotalMillicents = new Map<string, number>(); // model → total millicents over chart window
  const repoEvents = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  const repoAgents = new Map<string, RepoAgentAccumulator>();
  const activeMinutesByRepoSource = computeActiveMinutesByRepoSource(events, now, chartDays);
  const toolModels = new Map<string, Map<string, number>>();
  const heatmapMap = new Map<string, number>(); // "dow:hour" → events
  const cacheReadsByDay = new Map<string, number>();
  const cacheWritesByDay = new Map<string, number>();
  const breakdownByDay = new Map<string, BreakdownRow>();
  const costBreakdown24h = emptyBreakdown();

  // Pre-fill chart window so empty buckets render too.
  const daysBack = lastNDays(chartDays);
  for (const d of daysBack) {
    dailyMap.set(d, newSum());
    stackedMap.set(d, {});
    cacheReadsByDay.set(d, 0);
    cacheWritesByDay.set(d, 0);
    breakdownByDay.set(d, blankBreakdown());
  }

  for (const e of events) {
    const ts = new Date(e.ts);
    const ageMs = now - ts.getTime();

    const millicents = resolveMillicents(e, ts, subscriptionSources);

    // Billable tokens: what the user pays the model to *do*. Cache reads
    // & writes are billable too but they're a cost-mechanism artefact —
    // showing them in the displayed denominator made $/token look 60×
    // higher than the model rate sheet (the visible bug at /app today).
    const billable =
      (e.tokens_input ?? 0) +
      (e.tokens_output ?? 0) +
      (e.tokens_reasoning ?? 0);
    const cacheTokens = sumCacheTokens(e);
    const total = billable + cacheTokens;
    const day = ts.toISOString().slice(0, 10);
    const inChartWindow = ageMs <= chartDays * D_MS;

    addTo(today,     ageMs <= D_MS,                        billable, total, millicents);
    if (ageMs <= D_MS) {
      const bd = costBreakdownMillicents({
        model:                 e.model,
        tokens_input:          e.tokens_input,
        tokens_output:         e.tokens_output,
        tokens_reasoning:      e.tokens_reasoning,
        tokens_cache_read:     e.tokens_cache_read,
        tokens_cache_write:    e.tokens_cache_write,
        tokens_cache_5m_write: e.tokens_cache_5m_write,
        tokens_cache_1h_write: e.tokens_cache_1h_write,
        ts,
      });
      if (bd) addBreakdown(costBreakdown24h, bd);
    }
    addTo(yesterday, ageMs > D_MS && ageMs <= 2 * D_MS,    billable, total, millicents);
    addTo(week,      ageMs <= 7 * D_MS,                    billable, total, millicents);

    const daily = dailyMap.get(day);
    if (daily) addTo(daily, true, billable, total, millicents);

    // Stacked area uses TOTAL tokens — lets cache-heavy sources show
    // proportionally; the y-axis label already says "tokens per day,
    // stacked by source" so users expect the full volume.
    const stack = stackedMap.get(day);
    if (stack && total > 0) {
      stack[e.source] = (stack[e.source] ?? 0) + total;
    }

    // chart-window source totals (controls render order in the legend).
    if (inChartWindow) {
      sourceTotals.set(e.source, (sourceTotals.get(e.source) ?? 0) + total);
    }

    // 7-day model mix: BILLABLE tokens, so the donut reflects "what
    // model did real work" not "what model wrote a lot of cache".
    if (ageMs <= 7 * D_MS && e.model && billable > 0) {
      modelTokens.set(e.model, (modelTokens.get(e.model) ?? 0) + billable);
    }

    // Per-model cost over chart window (millicents) for byModel chart.
    if (inChartWindow && e.model && millicents != null && millicents > 0) {
      const dayMap = modelByDayMillicents.get(e.model) ?? new Map<string, number>();
      dayMap.set(day, (dayMap.get(day) ?? 0) + millicents);
      modelByDayMillicents.set(e.model, dayMap);
      modelTotalMillicents.set(e.model, (modelTotalMillicents.get(e.model) ?? 0) + millicents);
    }

    // 7-day repo + tool counts.
    if (ageMs <= 7 * D_MS) {
      if (e.repo_name) repoEvents.set(e.repo_name, (repoEvents.get(e.repo_name) ?? 0) + 1);
      if (e.tool_calls_types) {
        for (const t of e.tool_calls_types) {
          toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
        }
      } else if (e.tool_calls_count != null && e.tool_calls_count > 0) {
        toolCounts.set("(unspecified)", (toolCounts.get("(unspecified)") ?? 0) + e.tool_calls_count);
      }
    }

    if (inChartWindow) {
      if (e.repo_name) {
        const r = ensureRepoAgent(repoAgents, e.repo_name);
        if (e.source === "claude_code") {
          r.claudeEvents += 1;
        } else if (e.source === "codex") {
          r.codexEvents += 1;
        } else {
          r.otherEvents += 1;
        }
        r.tokens += billable;
        if (millicents != null) r.millicents += millicents;
      }

      const model = shortModel(e.model ?? "unknown");
      if (e.tool_calls_types && e.tool_calls_types.length > 0) {
        for (const t of e.tool_calls_types) {
          incrementToolModel(toolModels, t, model, 1);
        }
      } else if (e.tool_calls_count != null && e.tool_calls_count > 0) {
        incrementToolModel(toolModels, "(unspecified)", model, e.tool_calls_count);
      }
    }

    // 30-day heatmap.
    if (ageMs <= 30 * D_MS) {
      const dow = ts.getUTCDay();
      const hour = ts.getUTCHours();
      const k = `${dow}:${hour}`;
      heatmapMap.set(k, (heatmapMap.get(k) ?? 0) + 1);
    }

    // Cache efficiency (chart window).
    if (cacheReadsByDay.has(day)) {
      cacheReadsByDay.set(day, (cacheReadsByDay.get(day) ?? 0) + (e.tokens_cache_read ?? 0));
      cacheWritesByDay.set(day, (cacheWritesByDay.get(day) ?? 0) + sumCacheWriteTokens(e));
    }

    // Token breakdown per day (chart window) — powers the new
    // input/output/cache-by-type stacked chart that proves the
    // billable-vs-total split is real.
    const bd = breakdownByDay.get(day);
    if (bd) {
      bd.input          += e.tokens_input          ?? 0;
      bd.output         += e.tokens_output         ?? 0;
      bd.reasoning      += e.tokens_reasoning      ?? 0;
      bd.cache_read     += e.tokens_cache_read     ?? 0;
      bd.cache_5m_write += e.tokens_cache_5m_write ?? 0;
      bd.cache_1h_write += e.tokens_cache_1h_write ?? 0;
      if (e.tokens_cache_5m_write == null && e.tokens_cache_1h_write == null) {
        bd.cache_write_legacy += e.tokens_cache_write ?? 0;
      }
    }
  }

  // GitHub PRs / reviews per day (chart window).
  const githubByDay = new Map<string, { commits: number; prs_opened: number; prs_merged: number; reviews: number }>();
  const ghTotals = { commits: 0, prs_opened: 0, prs_merged: 0, reviews: 0 };
  const githubRepoTotals = new Map<string, { commits: number; prsOpened: number; prsMerged: number }>();
  for (const ev of ghEvents) {
    const day = ev.ts.slice(0, 10);
    const cur = githubByDay.get(day) ?? { commits: 0, prs_opened: 0, prs_merged: 0, reviews: 0 };
    const repo = ensureGithubRepo(githubRepoTotals, ev.repo);
    if (ev.kind === "commit") {
      cur.commits += 1;
      ghTotals.commits += 1;
      repo.commits += 1;
    } else if (ev.kind === "pr_opened") {
      cur.prs_opened += 1;
      ghTotals.prs_opened += 1;
      repo.prsOpened += 1;
    } else if (ev.kind === "pr_merged") {
      cur.prs_merged += 1;
      ghTotals.prs_merged += 1;
      repo.prsMerged += 1;
    } else if (ev.kind === "review" || ev.kind === "pr_reviewed") {
      cur.reviews += 1;
      ghTotals.reviews += 1;
    }
    githubByDay.set(day, cur);
  }

  const gitCommitRollup = mergeCommitRollups({
    githubCommits: ghEvents
      .filter((ev) => ev.kind === "commit")
      .map((ev) => ({ repo: ev.repo, ts: ev.ts })),
    agentGitCommits: events
      .filter((e) => e.source === "git" && e.repo_name)
      .filter((e) => now - new Date(e.ts).getTime() <= chartDays * D_MS)
      .map((e) => ({ repo: e.repo_name!, ts: e.ts })),
  });

  // -------- Build outputs --------
  const sources = [...sourceTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);

  const stackedArea: { bucket: string; [series: string]: string | number }[] = daysBack.map((d) => {
    const out: { bucket: string; [series: string]: string | number } = { bucket: shortDay(d) };
    const slice = stackedMap.get(d) ?? {};
    for (const s of sources) out[s] = slice[s] ?? 0;
    return out;
  });

  const daily = daysBack.map<DailyAggregate>((d) => {
    const s = dailyMap.get(d)!;
    return {
      bucket:      shortDay(d),
      events:      s.events,
      tokens:      s.tokensBillable,
      tokensTotal: s.tokensTotal,
      costCents:   millicentsToCents(s.millicents),
      commits:     gitCommitRollup.commitsByDay.get(d) ?? 0,
    };
  });

  const sparklines = {
    events:  daily.map((d) => d.events),
    tokens:  daily.map((d) => d.tokens),
    cost:    daily.map((d) => d.costCents ?? 0),
    commits: daily.map((d) => d.commits),
  };

  // Token-type breakdown stacked chart (chart window).
  const tokenBreakdown = daysBack.map((d) => {
    const bd = breakdownByDay.get(d) ?? blankBreakdown();
    return { bucket: shortDay(d), ...bd };
  });

  // Per-model cost stacked area: top 6 models by total cost over the
  // chart window. Smaller models roll up into "other" so the chart
  // doesn't shatter into a hundred 0.1% slices.
  const modelOrder = [...modelTotalMillicents.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m);
  const TOP_MODELS = 6;
  const topModels = modelOrder.slice(0, TOP_MODELS);
  const otherModels = new Set(modelOrder.slice(TOP_MODELS));
  const byModel = daysBack.map((d) => {
    const out: { bucket: string; [k: string]: string | number } = { bucket: shortDay(d) };
    let other = 0;
    for (const m of topModels) {
      const cents = millicentsToCents(modelByDayMillicents.get(m)?.get(d) ?? 0) ?? 0;
      out[shortModel(m)] = cents;
    }
    if (otherModels.size > 0) {
      for (const m of otherModels) {
        other += modelByDayMillicents.get(m)?.get(d) ?? 0;
      }
      out.other = millicentsToCents(other) ?? 0;
    }
    return out;
  });
  const models = otherModels.size > 0
    ? [...topModels.map(shortModel), "other"]
    : topModels.map(shortModel);

  const modelMix = [...modelTokens.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([m, v]) => ({ label: shortModel(m), value: v }));

  const topRepos = [...repoEvents.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([r, v]) => ({ label: r, value: v }));

  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t, v]) => ({ label: t, value: v }));

  const repoAgentRollup = buildRepoAgentRollup(repoAgents, githubRepoTotals, gitCommitRollup.commitsByRepo, activeMinutesByRepoSource);
  const repoFocus = buildRepoFocus(repoAgentRollup);
  const repoSourceMix = buildRepoSourceMix(repoAgentRollup);
  const toolModelMatrix = buildToolModelMatrix(toolModels);
  const githubState = selectDashboardGitHubState({
    githubCommitCount: gitCommitRollup.githubCommits,
    githubEventCount: ghEvents.length,
    agentGitCommitCount: gitCommitRollup.agentGitCommits,
    repoActivityCount: repoAgents.size,
  });

  const heatmap = [...heatmapMap.entries()].map(([k, v]) => {
    const [dow, hour] = k.split(":").map((x) => Number.parseInt(x, 10));
    return { dow, hour, value: v };
  });

  // Cumulative cost in millicents — round only at display so a long
  // trail of sub-cent events doesn't truncate to zero.
  let cumMillicents = 0;
  const costTrajectory = daysBack.map((d) => {
    cumMillicents += dailyMap.get(d)?.millicents ?? 0;
    return { bucket: shortDay(d), cents: millicentsToCents(cumMillicents) ?? 0 };
  });

  const cacheEfficiency = daysBack.map((d) => {
    const reads = cacheReadsByDay.get(d) ?? 0;
    const writes = cacheWritesByDay.get(d) ?? 0;
    const ratio = writes === 0 ? 0 : reads / writes;
    return { bucket: shortDay(d), ratio, reads, writes };
  });

  // Recent feed: 50 newest events. Use cached cost first; show cache
  // tokens distinctly so users can see WHY the cost number is what it
  // is (was: "171 tokens / $0.41" mystery; now: "171 in/out + 65k cache").
  const feed: FeedRow[] = events.slice(0, 50).map((e) => {
    const ts = new Date(e.ts);
    const m = resolveMillicents(e, ts, subscriptionSources);
    const cacheTokens = sumCacheTokens(e);
    return {
      ts: e.ts,
      source: e.source,
      model: e.model,
      repo: e.repo_name,
      tokens_input: e.tokens_input,
      tokens_output: e.tokens_output,
      tokens_cache: cacheTokens > 0 ? cacheTokens : null,
      duration_ms: e.duration_ms,
      costCents: millicentsToCents(m),
    };
  });

  // ── Fleet aggregation (source = 'ashlr-fleet') ───────────────────────────
  const fleetEvents = events.filter(
    (e) => e.source === "ashlr-fleet" && now - new Date(e.ts).getTime() <= chartDays * D_MS,
  );
  const fleet: FleetData | null = fleetEvents.length === 0 ? null : (() => {
    let lastTickTs: string | null = null;
    let proposals = 0, merges = 0, declines = 0, ticks = 0;
    const repoProposalsMap = new Map<string, number>();
    const repoMergesMap    = new Map<string, number>();
    const engineMap        = new Map<string, number>();
    const fleetDailyTokens = new Map<string, number>();
    const fleetDailyMillicents = new Map<string, number>();
    const recentMergeRows: FleetMergeRow[] = [];
    // Per-owner accumulator (M109 fleet_owner attribute).
    const ownerMap = new Map<string, FleetOwnerStat>();

    // Pre-fill daily buckets so empty days render.
    for (const d of daysBack) {
      fleetDailyTokens.set(d, 0);
      fleetDailyMillicents.set(d, 0);
    }

    for (const e of fleetEvents) {
      const ev = e.fleet_event ?? "";
      const repo = e.repo_name;
      const engine = e.provider ?? e.model ?? "unknown";
      const day = new Date(e.ts).toISOString().slice(0, 10);
      const mc = resolveMillicents(e, new Date(e.ts), subscriptionSources) ?? 0;
      const tokens = (e.tokens_input ?? 0) + (e.tokens_output ?? 0);

      if (ev === "tick") {
        ticks++;
        if (!lastTickTs || e.ts > lastTickTs) lastTickTs = e.ts;
      } else if (ev === "proposal") {
        proposals++;
        if (repo) repoProposalsMap.set(repo, (repoProposalsMap.get(repo) ?? 0) + 1);
      } else if (ev === "merge") {
        merges++;
        if (repo) repoMergesMap.set(repo, (repoMergesMap.get(repo) ?? 0) + 1);
        if (recentMergeRows.length < 20) {
          recentMergeRows.push({
            ts: e.ts,
            repo,
            engine: engine === "unknown" ? null : engine,
            costCents: millicentsToCents(mc),
          });
        }
      } else if (ev === "decline") {
        declines++;
      }

      engineMap.set(engine, (engineMap.get(engine) ?? 0) + 1);

      // Per-owner accumulation (M109). Only when the attribute is present.
      if (e.fleet_owner) {
        const ownerKey = e.fleet_owner;
        const ownerStat = ownerMap.get(ownerKey) ?? {
          owner: ownerKey,
          proposals: 0,
          merges: 0,
          declines: 0,
          ticks: 0,
        };
        if (ev === "proposal") ownerStat.proposals += 1;
        else if (ev === "merge") ownerStat.merges += 1;
        else if (ev === "decline") ownerStat.declines += 1;
        else if (ev === "tick") ownerStat.ticks += 1;
        ownerMap.set(ownerKey, ownerStat);
      }

      if (fleetDailyTokens.has(day)) {
        fleetDailyTokens.set(day, (fleetDailyTokens.get(day) ?? 0) + tokens);
        fleetDailyMillicents.set(day, (fleetDailyMillicents.get(day) ?? 0) + mc);
      }
    }

    const fleetDaily: FleetDailyPoint[] = daysBack.map((d) => ({
      bucket:    shortDay(d),
      tokens:    fleetDailyTokens.get(d) ?? 0,
      costCents: millicentsToCents(fleetDailyMillicents.get(d) ?? 0) ?? 0,
    }));

    return {
      lastTickTs,
      proposals,
      merges,
      declines,
      ticks,
      repoProposals: [...repoProposalsMap.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([label, value]) => ({ label, value })),
      repoMerges: [...repoMergesMap.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([label, value]) => ({ label, value })),
      engineMix: [...engineMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, value]) => ({ label, value })),
      daily: fleetDaily,
      recentMerges: recentMergeRows,
      byOwner: [...ownerMap.values()].sort((a, b) =>
        (b.proposals + b.merges + b.declines + b.ticks) -
        (a.proposals + a.merges + a.declines + a.ticks)
      ),
    };
  })();

  return {
    today:     statCard(today),
    yesterday: statCard(yesterday),
    week:      statCard(week),
    daily,
    costBreakdown24h,
    tokenBreakdown,
    byModel,
    models,
    stackedArea,
    sources,
    modelMix,
    topRepos,
    topTools,
    repoAgentRollup,
    repoFocus,
    repoSourceMix,
    toolModelMatrix,
    heatmap,
    costTrajectory,
    cacheEfficiency,
    byProject,
    chartDays,
    fleet,
    github: daysBack.map<GithubDaily>((d) => {
      const slot = githubByDay.get(d) ?? { commits: 0, prs_opened: 0, prs_merged: 0, reviews: 0 };
      return { bucket: shortDay(d), ...slot, commits: gitCommitRollup.commitsByDay.get(d) ?? 0 };
    }),
    githubTotals: { ...ghTotals, commits: gitCommitRollup.totalCommits },
    commitTotals: {
      commits: gitCommitRollup.totalCommits,
      githubCommits: gitCommitRollup.githubCommits,
      agentGitCommits: gitCommitRollup.agentGitCommits,
    },
    githubState,
    recentCommits: commits.slice(0, 8),
    feed,
    sparklines,
  };
}

// ---------- helpers ----------

interface RepoAgentAccumulator {
  claudeEvents: number;
  codexEvents: number;
  otherEvents: number;
  tokens: number;
  millicents: number;
}

function ensureRepoAgent(map: Map<string, RepoAgentAccumulator>, repo: string): RepoAgentAccumulator {
  const existing = map.get(repo);
  if (existing) return existing;
  const next: RepoAgentAccumulator = {
    claudeEvents: 0,
    codexEvents: 0,
    otherEvents: 0,
    tokens: 0,
    millicents: 0,
  };
  map.set(repo, next);
  return next;
}

function ensureGithubRepo(
  map: Map<string, { commits: number; prsOpened: number; prsMerged: number }>,
  repo: string,
): { commits: number; prsOpened: number; prsMerged: number } {
  const existing = map.get(repo);
  if (existing) return existing;
  const next = { commits: 0, prsOpened: 0, prsMerged: 0 };
  map.set(repo, next);
  return next;
}

function incrementToolModel(
  map: Map<string, Map<string, number>>,
  tool: string,
  model: string,
  count: number,
): void {
  const row = map.get(tool) ?? new Map<string, number>();
  row.set(model, (row.get(model) ?? 0) + count);
  map.set(tool, row);
}

function buildRepoAgentRollup(
  repoAgents: Map<string, RepoAgentAccumulator>,
  githubRepoTotals: Map<string, { commits: number; prsOpened: number; prsMerged: number }>,
  mergedCommitsByRepo: Map<string, number>,
  activeMinutesByRepoSource: Map<string, Map<string, number>>,
): RepoAgentRollup[] {
  const repos = new Set<string>([
    ...repoAgents.keys(),
    ...githubRepoTotals.keys(),
    ...mergedCommitsByRepo.keys(),
    ...activeMinutesByRepoSource.keys(),
  ]);
  return [...repos].map((repo) => {
    const a = repoAgents.get(repo);
    const gh = githubRepoTotals.get(repo);
    const activeBySource = activeMinutesByRepoSource.get(repo);
    const claudeMinutes = activeBySource?.get("claude_code") ?? 0;
    const codexMinutes = activeBySource?.get("codex") ?? 0;
    const totalMinutes = sumMapValues(activeBySource);
    const otherMinutes = Math.max(0, totalMinutes - claudeMinutes - codexMinutes);
    return {
      repo,
      claudeEvents: Math.round(a?.claudeEvents ?? 0),
      codexEvents: Math.round(a?.codexEvents ?? 0),
      otherEvents: Math.round(a?.otherEvents ?? 0),
      claudeMinutes: round1(claudeMinutes),
      codexMinutes: round1(codexMinutes),
      otherMinutes: round1(otherMinutes),
      totalMinutes: round1(totalMinutes),
      tokens: Math.round(a?.tokens ?? 0),
      costCents: millicentsToCents(a?.millicents ?? 0),
      commits: mergedCommitsByRepo.get(repo) ?? gh?.commits ?? 0,
      prsOpened: gh?.prsOpened ?? 0,
      prsMerged: gh?.prsMerged ?? 0,
    };
  }).sort((a, b) => (
    b.totalMinutes - a.totalMinutes ||
    (b.claudeEvents + b.codexEvents + b.otherEvents) - (a.claudeEvents + a.codexEvents + a.otherEvents) ||
    b.commits - a.commits
  )).slice(0, 12);
}

export function computeActiveMinutesByRepoSource(
  events: ActiveTimeEvent[],
  nowMs = Date.now(),
  chartDays = 14,
): Map<string, Map<string, number>> {
  const cutoffMs = nowMs - chartDays * 86_400_000;
  const groups = new Map<string, ActiveTimeEvent[]>();
  for (const e of events) {
    if (!e.repo_name) continue;
    if (e.source === "git") continue;
    const tsMs = new Date(e.ts).getTime();
    if (!Number.isFinite(tsMs) || tsMs < cutoffMs || tsMs > nowMs + 60_000) continue;
    const key = `${e.repo_name}\u0000${e.source}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }

  const out = new Map<string, Map<string, number>>();
  for (const [key, rows] of groups) {
    rows.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    let ms = 0;
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i];
      const duration = meaningfulDurationMs(e.duration_ms);
      if (duration != null) {
        ms += duration;
        continue;
      }

      const tsMs = new Date(e.ts).getTime();
      const next = rows[i + 1];
      if (next) {
        const gapMs = Math.max(0, new Date(next.ts).getTime() - tsMs);
        ms += Math.min(gapMs, ACTIVE_GAP_CAP_MS);
      } else {
        ms += ACTIVE_SINGLE_EVENT_MS;
      }
    }

    const [repo, source] = key.split("\u0000");
    const bySource = out.get(repo) ?? new Map<string, number>();
    bySource.set(source, (bySource.get(source) ?? 0) + ms / 60_000);
    out.set(repo, bySource);
  }
  return out;
}

function meaningfulDurationMs(durationMs: number | null): number | null {
  if (durationMs == null || durationMs <= 0) return null;
  if (durationMs > MAX_MEANINGFUL_DURATION_MS) return null;
  return durationMs;
}

export function mergeCommitRollups({
  githubCommits,
  agentGitCommits,
}: {
  githubCommits: CommitRollupEvent[];
  agentGitCommits: CommitRollupEvent[];
}): MergedCommitRollup {
  const githubByRepoDay = new Map<string, number>();
  const agentByRepoDay = new Map<string, number>();
  let githubTotal = 0;
  let agentTotal = 0;

  for (const c of githubCommits) {
    const key = repoDayKey(c);
    githubByRepoDay.set(key, (githubByRepoDay.get(key) ?? 0) + 1);
    githubTotal += 1;
  }
  for (const c of agentGitCommits) {
    const key = repoDayKey(c);
    agentByRepoDay.set(key, (agentByRepoDay.get(key) ?? 0) + 1);
    agentTotal += 1;
  }

  const commitsByDay = new Map<string, number>();
  const commitsByRepo = new Map<string, number>();
  const keys = new Set([...githubByRepoDay.keys(), ...agentByRepoDay.keys()]);
  for (const key of keys) {
    const githubCount = githubByRepoDay.get(key) ?? 0;
    const agentCount = agentByRepoDay.get(key) ?? 0;
    const merged = githubCount > 0 ? githubCount : agentCount;
    const [repo, day] = key.split("\u0000");
    commitsByDay.set(day, (commitsByDay.get(day) ?? 0) + merged);
    commitsByRepo.set(repo, (commitsByRepo.get(repo) ?? 0) + merged);
  }

  return {
    commitsByDay,
    commitsByRepo,
    totalCommits: [...commitsByDay.values()].reduce((a, b) => a + b, 0),
    githubCommits: githubTotal,
    agentGitCommits: agentTotal,
  };
}

function repoDayKey(c: CommitRollupEvent): string {
  return `${c.repo}\u0000${c.ts.slice(0, 10)}`;
}

function rebaseScopePlaceholders(clauseSql: string, firstIndex: number): string {
  if (!clauseSql) return "";
  let next = firstIndex;
  return clauseSql.replace(/\$\d+/g, () => `$${next++}`);
}

export function selectDashboardGitHubState(input: {
  githubCommitCount: number;
  githubEventCount: number;
  agentGitCommitCount: number;
  repoActivityCount: number;
}): DashboardGitHubState {
  if (input.githubEventCount > 0 || input.githubCommitCount > 0) return "ready";
  if (input.agentGitCommitCount > 0 || input.repoActivityCount > 0) return "missing_or_stale";
  return "empty";
}

function buildRepoFocus(rows: RepoAgentRollup[]): RepoFocusRow[] {
  return rows
    .map((r) => ({
      repo: r.repo,
      activeMinutes: r.totalMinutes,
      commits: r.commits,
      prs: r.prsOpened + r.prsMerged,
    }))
    .filter((r) => r.activeMinutes > 0 || r.commits > 0 || r.prs > 0)
    .slice(0, 10);
}

function buildRepoSourceMix(rows: RepoAgentRollup[]): RepoSourceMixRow[] {
  return rows
    .filter((r) => r.totalMinutes > 0)
    .map((r) => ({
      repo: r.repo,
      claudeMinutes: r.claudeMinutes,
      codexMinutes: r.codexMinutes,
      otherMinutes: r.otherMinutes,
    }))
    .slice(0, 10);
}

function sumMapValues(map: Map<string, number> | undefined): number {
  if (!map) return 0;
  let out = 0;
  for (const v of map.values()) out += v;
  return out;
}

function buildToolModelMatrix(toolModels: Map<string, Map<string, number>>): ToolModelMatrix {
  const rowTotals = [...toolModels.entries()]
    .map(([tool, models]) => [tool, [...models.values()].reduce((a, b) => a + b, 0)] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const modelTotals = new Map<string, number>();
  for (const [, models] of toolModels) {
    for (const [model, count] of models) {
      modelTotals.set(model, (modelTotals.get(model) ?? 0) + count);
    }
  }
  const rows = rowTotals.map(([tool]) => tool);
  const cols = [...modelTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([model]) => model);
  const cells = rows.map((tool) => {
    const models = toolModels.get(tool) ?? new Map<string, number>();
    return cols.map((model) => models.get(model) ?? 0);
  });
  return { rows, cols, cells };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

interface SumBucket {
  events: number;
  /** Billable tokens (input + output + reasoning). */
  tokensBillable: number;
  /** All tokens including cache. */
  tokensTotal: number;
  /** Cumulative cost in millicents — NULL only when no row in the
   *  bucket had a known model. */
  millicents: number | null;
}
function newSum(): SumBucket {
  return { events: 0, tokensBillable: 0, tokensTotal: 0, millicents: null };
}
function addTo(
  sum: SumBucket,
  include: boolean,
  billable: number,
  total: number,
  millicents: number | null,
): void {
  if (!include) return;
  sum.events += 1;
  sum.tokensBillable += billable;
  sum.tokensTotal += total;
  if (millicents != null) sum.millicents = (sum.millicents ?? 0) + millicents;
}
function statCard(s: SumBucket): StatCard {
  return {
    events: s.events,
    tokens: s.tokensBillable,
    tokensTotal: s.tokensTotal,
    costCents: millicentsToCents(s.millicents),
  };
}

/**
 * Sum of cache_5m_write + cache_1h_write, falling back to legacy
 * cache_write when both new columns are null (pre-migration-0015 rows).
 */
function sumCacheWriteTokens(e: RawEvent): number {
  return (
    (e.tokens_cache_5m_write ?? 0) +
    (e.tokens_cache_1h_write ?? 0) +
    (e.tokens_cache_5m_write == null && e.tokens_cache_1h_write == null
      ? (e.tokens_cache_write ?? 0)
      : 0)
  );
}

/** All cache tokens (reads + writes incl. legacy fallback). */
function sumCacheTokens(e: RawEvent): number {
  return (e.tokens_cache_read ?? 0) + sumCacheWriteTokens(e);
}

/**
 * Cost: trust the cached millicents from migration 0015 first.
 * Falls back to live computation for legacy rows where the column
 * is still NULL (will be populated by a later backfill).
 *
 * If `subscriptionSources` is provided and `e.source` is in the set,
 * the effective cost is zero (the user is on a subscription that
 * covers this source). Token counts elsewhere are unaffected — only
 * the dollar number changes.
 */
function resolveMillicents(
  e: RawEvent,
  ts: Date,
  subscriptionSources?: Set<string>,
): number | null {
  if (subscriptionSources?.has(e.source)) return 0;
  // Coerce at the boundary: bigint from postgres-js mixed with the
  // `number` math elsewhere triggers `Cannot mix BigInt and other
  // types` at runtime, even though tsc accepts the union.
  if (e.cost_millicents != null) return Number(e.cost_millicents);
  return costMillicents({
    model:                 e.model,
    tokens_input:          e.tokens_input,
    tokens_output:         e.tokens_output,
    tokens_reasoning:      e.tokens_reasoning,
    tokens_cache_read:     e.tokens_cache_read,
    tokens_cache_write:    e.tokens_cache_write,
    tokens_cache_5m_write: e.tokens_cache_5m_write,
    tokens_cache_1h_write: e.tokens_cache_1h_write,
    ts,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// loadCompare — side-by-side source comparison
// ─────────────────────────────────────────────────────────────────────────────

export interface CompareSide {
  source: string;
  totalCostCents: number | null;
  totalTokens: number;
  daily: Array<{ ts: string; tokens: number; costCents: number | null }>;
  /** Token share by model (top 8). */
  modelMix: Array<{ name: string; value: number }>;
  /** 24 buckets, index = UTC hour, value = event count. */
  hourOfDay: number[];
  topRepos: Array<{ repo: string; tokens: number }>;
  latency: { p50: number; p95: number };
  toolCalls: Array<{ name: string; count: number }>;
}

export interface CompareData {
  a: CompareSide;
  b: CompareSide;
  days: number;
}

export async function loadCompare(
  userId: string,
  scope: ScopeFilter,
  sourceA: string,
  sourceB: string,
  days: number,
  opts?: { subscriptionSources?: Set<string> },
): Promise<CompareData> {
  const window = clampDays(days);
  const db = sql();
  const subSources = opts?.subscriptionSources ?? new Set<string>();

  // Single query pulling both sources; we split in memory.
  const rows = await db.unsafe<RawEvent[]>(
    `
    SELECT
      ts::text                AS ts,
      source,
      provider,
      model,
      repo_name,
      duration_ms,
      tokens_input,
      tokens_output,
      tokens_reasoning,
      tokens_cache_read,
      tokens_cache_write,
      tokens_cache_5m_write,
      tokens_cache_1h_write,
      tool_calls_count,
      tool_calls_types,
      cost_millicents
    FROM activity_event
    WHERE user_id = $1
      AND ts >= NOW() - INTERVAL '${window} days'
      AND source = ANY($2::text[])
      ${scope.repoClauseSql}
    ORDER BY ts DESC
    `,
    [userId, [sourceA, sourceB], ...scope.repoParams],
  );

  return {
    a: buildCompareSide(sourceA, rows, window, subSources),
    b: buildCompareSide(sourceB, rows, window, subSources),
    days: window,
  };
}

function buildCompareSide(
  source: string,
  allRows: RawEvent[],
  window: number,
  subscriptionSources: Set<string>,
): CompareSide {
  const rows = allRows.filter((r) => r.source === source);

  const days = lastNDays(window);
  // Daily buckets
  const dailyTokens = new Map<string, number>();
  const dailyMillicents = new Map<string, number>();
  for (const d of days) { dailyTokens.set(d, 0); dailyMillicents.set(d, 0); }

  const modelTokenMap = new Map<string, number>();
  const hourBuckets   = new Array<number>(24).fill(0);
  const repoTokenMap  = new Map<string, number>();
  const toolCountMap  = new Map<string, number>();
  const latencies: number[] = [];
  let totalTokens = 0;
  let totalMillicents = 0;

  for (const e of rows) {
    const ts  = new Date(e.ts);
    const day = ts.toISOString().slice(0, 10);
    const billable =
      (e.tokens_input    ?? 0) +
      (e.tokens_output   ?? 0) +
      (e.tokens_reasoning ?? 0);
    const mc = resolveMillicents(e, ts, subscriptionSources);

    totalTokens      += billable;
    totalMillicents  += mc ?? 0;

    if (dailyTokens.has(day)) {
      dailyTokens.set(day, (dailyTokens.get(day) ?? 0) + billable);
      dailyMillicents.set(day, (dailyMillicents.get(day) ?? 0) + (mc ?? 0));
    }

    if (e.model && billable > 0) {
      modelTokenMap.set(e.model, (modelTokenMap.get(e.model) ?? 0) + billable);
    }

    hourBuckets[ts.getUTCHours()] += 1;

    if (e.repo_name && billable > 0) {
      repoTokenMap.set(e.repo_name, (repoTokenMap.get(e.repo_name) ?? 0) + billable);
    }

    if (e.duration_ms != null) latencies.push(e.duration_ms);

    if (e.tool_calls_types) {
      for (const t of e.tool_calls_types) {
        toolCountMap.set(t, (toolCountMap.get(t) ?? 0) + 1);
      }
    } else if (e.tool_calls_count != null && e.tool_calls_count > 0) {
      toolCountMap.set("(unspecified)", (toolCountMap.get("(unspecified)") ?? 0) + e.tool_calls_count);
    }
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : 0;
  const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : 0;

  return {
    source,
    totalCostCents:  millicentsToCents(totalMillicents),
    totalTokens,
    daily: days.map((d) => ({
      ts:        d,
      tokens:    dailyTokens.get(d) ?? 0,
      costCents: millicentsToCents(dailyMillicents.get(d) ?? 0),
    })),
    modelMix: [...modelTokenMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, value]) => ({ name, value })),
    hourOfDay: hourBuckets,
    topRepos: [...repoTokenMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([repo, tokens]) => ({ repo, tokens })),
    latency: { p50, p95 },
    toolCalls: [...toolCountMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// loadForecast — cost history + burn-down inputs for /forecast
// ─────────────────────────────────────────────────────────────────────────────

export interface ForecastData {
  /** Daily cost in cents, oldest → newest (chartDays items). */
  history: Array<{ ts: string; value: number }>;
  /** Per-model daily cost in cents — used for scenario sliders. */
  byModel: Array<{ model: string; daily: Array<{ ts: string; value: number }> }>;
  /** From org.monthly_budget_usd. NULL = not set. */
  monthlyBudgetUsd: number | null;
  daysElapsedInMonth: number;
  daysInMonth: number;
  spentThisMonthCents: number;
  /** Top model × tool-type combos by % of spend over the window. */
  topDrivers: Array<{ label: string; pctOfSpend: number }>;
}

export async function loadForecast(
  userId: string,
  scope: ScopeFilter,
  days: number,
  monthlyBudgetUsd: number | null,
  opts?: { subscriptionSources?: Set<string> },
): Promise<ForecastData> {
  const window = clampDays(days);
  const db = sql();
  const subSources = opts?.subscriptionSources ?? new Set<string>();

  const rows = await db.unsafe<RawEvent[]>(
    `
    SELECT
      ts::text                AS ts,
      source,
      provider,
      model,
      repo_name,
      duration_ms,
      tokens_input,
      tokens_output,
      tokens_reasoning,
      tokens_cache_read,
      tokens_cache_write,
      tokens_cache_5m_write,
      tokens_cache_1h_write,
      tool_calls_count,
      tool_calls_types,
      cost_millicents
    FROM activity_event
    WHERE user_id = $1
      AND ts >= NOW() - INTERVAL '${window} days'
      ${scope.repoClauseSql}
    ORDER BY ts ASC
    `,
    [userId, ...scope.repoParams],
  );

  const allDays = lastNDays(window);
  const dailyMillicents = new Map<string, number>();
  for (const d of allDays) dailyMillicents.set(d, 0);

  // model → day → millicents
  const modelDayMillicents = new Map<string, Map<string, number>>();
  // model+tool → total millicents (for top drivers)
  const driverMillicents = new Map<string, number>();
  let totalMillicents = 0;

  // Month-to-date: sum rows where ts >= first day of current UTC month.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let monthMillicents = 0;

  for (const e of rows) {
    const ts = new Date(e.ts);
    const day = ts.toISOString().slice(0, 10);
    const mc = resolveMillicents(e, ts, subSources) ?? 0;

    if (dailyMillicents.has(day)) {
      dailyMillicents.set(day, (dailyMillicents.get(day) ?? 0) + mc);
    }

    if (ts >= monthStart) monthMillicents += mc;
    totalMillicents += mc;

    if (e.model && mc > 0) {
      const modelMap = modelDayMillicents.get(e.model) ?? new Map<string, number>();
      modelMap.set(day, (modelMap.get(day) ?? 0) + mc);
      modelDayMillicents.set(e.model, modelMap);

      // Driver = model + first tool type (or "direct" when no tools).
      const tool =
        e.tool_calls_types && e.tool_calls_types.length > 0
          ? e.tool_calls_types[0]
          : "direct";
      const driverKey = `${e.model} / ${tool}`;
      driverMillicents.set(driverKey, (driverMillicents.get(driverKey) ?? 0) + mc);
    }
  }

  const history = allDays.map((d) => ({
    ts:    d,
    value: millicentsToCents(dailyMillicents.get(d) ?? 0) ?? 0,
  }));

  // Top models by total cost — include up to 6.
  const modelOrder = [...modelDayMillicents.entries()]
    .map(([model, dayMap]) => ({
      model,
      total: [...dayMap.values()].reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);

  const byModel = modelOrder.map(({ model }) => ({
    model,
    daily: allDays.map((d) => ({
      ts:    d,
      value: millicentsToCents(modelDayMillicents.get(model)?.get(d) ?? 0) ?? 0,
    })),
  }));

  const topDrivers = [...driverMillicents.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([label, mc]) => ({
      label,
      pctOfSpend: totalMillicents > 0 ? Math.round((mc / totalMillicents) * 1000) / 10 : 0,
    }));

  // Month-in-progress metadata.
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const daysElapsedInMonth = now.getUTCDate();

  return {
    history,
    byModel,
    monthlyBudgetUsd,
    daysElapsedInMonth,
    daysInMonth,
    spentThisMonthCents: millicentsToCents(monthMillicents) ?? 0,
    topDrivers,
  };
}

function clampDays(d: number): number {
  if (!Number.isFinite(d) || d < 1) return 14;
  if (d > 90) return 90;
  return Math.floor(d);
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function shortDay(yyyymmdd: string): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function shortModel(m: string): string {
  // claude-opus-4-7 → opus 4.7, claude-sonnet-4-6 → sonnet 4.6
  const t = m.replace(/^claude-/, "");
  return t.replace(/-(\d+)-(\d+)$/, " $1.$2");
}
