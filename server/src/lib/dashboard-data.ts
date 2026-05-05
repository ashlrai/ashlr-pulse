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
import { costMillicents, millicentsToCents } from "@/lib/pricing";
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
  /** Effective window in days that the charts cover. */
  chartDays: number;
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
   *  — we fall back to recomputing via costMillicents() per row. */
  cost_millicents: number | null;
}

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
  // If a retention cutoff is active, cap the window to the smaller range.
  const retCutoffClause = retCutoff
    ? `AND ts >= '${retCutoff.toISOString()}'`
    : "";
  const events = await db.unsafe<RawEvent[]>(
    `
    SELECT
      ts::text                AS ts,
      source,
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
      AND ts >= NOW() - INTERVAL '${sqlWindowDays} days'
      ${retCutoffClause}
      ${scope.repoClauseSql}
    ORDER BY ts DESC
    `,
    [userId, ...scope.repoParams],
  );

  // Pull last chartDays of github commits (subjects only — public info).
  // github_event ⨝ github_account (account_id) ⨝ github_repo (repo_id).
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
      ${retCutoffClause}
    ORDER BY ge.ts DESC
    LIMIT 50
    `,
    [userId],
  ).catch(() => [] as { subject: string; repo: string; sha: string; ts: string }[]);

  // Pull GitHub events for daily PR throughput aggregation.
  const ghEvents = await db.unsafe<{ kind: string; ts: string }[]>(
    `
    SELECT ge.kind, ge.ts::text AS ts
    FROM github_event ge
    JOIN github_account ga ON ga.id = ge.account_id
    WHERE ga.user_id = $1::uuid
      AND ge.ts >= NOW() - INTERVAL '${chartDays} days'
      ${retCutoffClause}
    `,
    [userId],
  ).catch(() => [] as { kind: string; ts: string }[]);

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
    tokens: number;
    millicents: string | number | null;
  }[]>(
    `
    SELECT
      p.id::text          AS project_id,
      p.name              AS project_name,
      p.kind              AS kind,
      COUNT(DISTINCT pr.repo_name)::int AS repos,
      COUNT(ae.*)::int    AS events,
      COALESCE(SUM(COALESCE(ae.tokens_input, 0) + COALESCE(ae.tokens_output, 0) + COALESCE(ae.tokens_reasoning, 0)), 0)::bigint::int AS tokens,
      COALESCE(SUM(ae.cost_millicents), 0)::bigint AS millicents
    FROM project p
    JOIN membership m  ON m.org_id    = p.org_id AND m.user_id = $1::uuid
    JOIN project_repo pr ON pr.project_id = p.id
    LEFT JOIN activity_event ae
      ON ae.repo_name = pr.repo_name
     AND ae.user_id   = $1::uuid
     AND ae.ts >= NOW() - INTERVAL '${chartDays} days'
    GROUP BY p.id, p.name, p.kind
    HAVING COUNT(ae.*) > 0
    ORDER BY tokens DESC, events DESC
    LIMIT 20
    `,
    [userId],
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
      tokens: r.tokens,
      cents: m == null || m === 0 ? null : millicentsToCents(m),
    };
  });

  return computeAggregates(events, commits, ghEvents, projectRollups, chartDays);
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
  ghEvents: { kind: string; ts: string }[],
  byProject: ProjectRollup[],
  chartDays: number,
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
  const heatmapMap = new Map<string, number>(); // "dow:hour" → events
  const cacheReadsByDay = new Map<string, number>();
  const cacheWritesByDay = new Map<string, number>();
  const breakdownByDay = new Map<string, BreakdownRow>();

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

    // Cost: trust the cached millicents from migration 0015 first.
    // Falls back to live computation for legacy rows where the column
    // is still NULL (will be populated by a later backfill).
    const millicents = e.cost_millicents != null
      ? e.cost_millicents
      : costMillicents({
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

    // Billable tokens: what the user pays the model to *do*. Cache reads
    // & writes are billable too but they're a cost-mechanism artefact —
    // showing them in the displayed denominator made $/token look 60×
    // higher than the model rate sheet (the visible bug at /app today).
    const billable =
      (e.tokens_input ?? 0) +
      (e.tokens_output ?? 0) +
      (e.tokens_reasoning ?? 0);
    const cacheTokens =
      (e.tokens_cache_read ?? 0) +
      (e.tokens_cache_5m_write ?? 0) +
      (e.tokens_cache_1h_write ?? 0) +
      (e.tokens_cache_5m_write == null && e.tokens_cache_1h_write == null
        ? (e.tokens_cache_write ?? 0)
        : 0);
    const total = billable + cacheTokens;
    const day = ts.toISOString().slice(0, 10);

    addTo(today,     ageMs <= D_MS,                        billable, total, millicents);
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
    if (ageMs <= chartDays * D_MS) {
      sourceTotals.set(e.source, (sourceTotals.get(e.source) ?? 0) + total);
    }

    // 7-day model mix: BILLABLE tokens, so the donut reflects "what
    // model did real work" not "what model wrote a lot of cache".
    if (ageMs <= 7 * D_MS && e.model && billable > 0) {
      modelTokens.set(e.model, (modelTokens.get(e.model) ?? 0) + billable);
    }

    // Per-model cost over chart window (millicents) for byModel chart.
    if (ageMs <= chartDays * D_MS && e.model && millicents != null && millicents > 0) {
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
      const writes =
        (e.tokens_cache_5m_write ?? 0) +
        (e.tokens_cache_1h_write ?? 0) +
        (e.tokens_cache_5m_write == null && e.tokens_cache_1h_write == null
          ? (e.tokens_cache_write ?? 0)
          : 0);
      cacheWritesByDay.set(day, (cacheWritesByDay.get(day) ?? 0) + writes);
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

  // Commits per day (chart window).
  const commitsByDay = new Map<string, number>();
  for (const c of commits) {
    const day = c.ts.slice(0, 10);
    commitsByDay.set(day, (commitsByDay.get(day) ?? 0) + 1);
  }

  // GitHub PRs / reviews per day (chart window).
  const githubByDay = new Map<string, { commits: number; prs_opened: number; prs_merged: number; reviews: number }>();
  const ghTotals = { commits: 0, prs_opened: 0, prs_merged: 0, reviews: 0 };
  for (const ev of ghEvents) {
    const day = ev.ts.slice(0, 10);
    const cur = githubByDay.get(day) ?? { commits: 0, prs_opened: 0, prs_merged: 0, reviews: 0 };
    if (ev.kind === "commit") {
      cur.commits += 1;
      ghTotals.commits += 1;
    } else if (ev.kind === "pr_opened") {
      cur.prs_opened += 1;
      ghTotals.prs_opened += 1;
    } else if (ev.kind === "pr_merged") {
      cur.prs_merged += 1;
      ghTotals.prs_merged += 1;
    } else if (ev.kind === "review" || ev.kind === "pr_reviewed") {
      cur.reviews += 1;
      ghTotals.reviews += 1;
    }
    githubByDay.set(day, cur);
  }

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
      commits:     commitsByDay.get(d) ?? 0,
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
    const m = e.cost_millicents != null
      ? e.cost_millicents
      : costMillicents({
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
    const cacheTokens =
      (e.tokens_cache_read ?? 0) +
      (e.tokens_cache_5m_write ?? 0) +
      (e.tokens_cache_1h_write ?? 0) +
      (e.tokens_cache_5m_write == null && e.tokens_cache_1h_write == null
        ? (e.tokens_cache_write ?? 0)
        : 0);
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

  return {
    today:     statCard(today),
    yesterday: statCard(yesterday),
    week:      statCard(week),
    daily,
    tokenBreakdown,
    byModel,
    models,
    stackedArea,
    sources,
    modelMix,
    topRepos,
    topTools,
    heatmap,
    costTrajectory,
    cacheEfficiency,
    byProject,
    chartDays,
    github: daysBack.map<GithubDaily>((d) => {
      const slot = githubByDay.get(d) ?? { commits: 0, prs_opened: 0, prs_merged: 0, reviews: 0 };
      return { bucket: shortDay(d), ...slot };
    }),
    githubTotals: ghTotals,
    recentCommits: commits.slice(0, 8),
    feed,
    sparklines,
  };
}

// ---------- helpers ----------

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
