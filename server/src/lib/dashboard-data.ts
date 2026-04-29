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
import { costUsdCents } from "@/lib/pricing";

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
}

export interface DashboardData {
  /** Today (last 24h) summary. */
  today: { events: number; tokens: number; costCents: number | null };
  /** Yesterday (24-48h ago). */
  yesterday: { events: number; tokens: number; costCents: number | null };
  /** Last-7d totals. */
  week: { events: number; tokens: number; costCents: number | null };
  /** Daily totals over the last 14 days, with deltas baked in. */
  daily: DailyAggregate[];
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
  tokens: number;
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
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  tokens_cache_5m_write: number | null;
  tokens_cache_1h_write: number | null;
  tool_calls_count: number | null;
  tool_calls_types: string[] | null;
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

  // Pull a window of raw rows; we'll bucket in memory. The window is
  // max(chartDays, 30) so the 30d heatmap always has data even when
  // the user picks a 7d chart range. ~30k rows × in-memory bucketing
  // is well under postgres-js + Node's memory budget.
  const sqlWindowDays = Math.max(chartDays, 30);
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
      tokens_cache_read,
      tokens_cache_write,
      tokens_cache_5m_write,
      tokens_cache_1h_write,
      tool_calls_count,
      tool_calls_types
    FROM activity_event
    WHERE user_id = $1
      AND ts >= NOW() - INTERVAL '${sqlWindowDays} days'
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
    `,
    [userId],
  ).catch(() => [] as { kind: string; ts: string }[]);

  // Load project rollups in parallel — small query, joins activity_event
  // to project_repo. Bounded to chartDays.
  const projectRollups = await db.unsafe<ProjectRollup[]>(
    `
    SELECT
      p.id::text          AS project_id,
      p.name              AS project_name,
      p.kind              AS kind,
      COUNT(DISTINCT pr.repo_name)::int AS repos,
      COUNT(ae.*)::int    AS events,
      COALESCE(SUM(COALESCE(ae.tokens_input, 0) + COALESCE(ae.tokens_output, 0)), 0)::bigint::int AS tokens,
      NULL::int           AS cents
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
  ).catch(() => [] as ProjectRollup[]);

  return computeAggregates(events, commits, ghEvents, projectRollups, chartDays);
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
  const repoEvents = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  const heatmapMap = new Map<string, number>(); // "dow:hour" → events
  const cacheReadsByDay = new Map<string, number>();
  const cacheWritesByDay = new Map<string, number>();

  // Pre-fill last 14 days so charts render with empty buckets too.
  const daysBack = lastNDays(chartDays);
  for (const d of daysBack) {
    dailyMap.set(d, newSum());
    stackedMap.set(d, {});
    cacheReadsByDay.set(d, 0);
    cacheWritesByDay.set(d, 0);
  }

  for (const e of events) {
    const ts = new Date(e.ts);
    const ageMs = now - ts.getTime();
    const cents = costUsdCents({
      model:                  e.model,
      tokens_input:           e.tokens_input,
      tokens_output:          e.tokens_output,
      tokens_cache_read:      e.tokens_cache_read,
      tokens_cache_write:     e.tokens_cache_write,
      tokens_cache_5m_write:  e.tokens_cache_5m_write,
      tokens_cache_1h_write:  e.tokens_cache_1h_write,
      ts,
    });
    const tokens = (e.tokens_input ?? 0) + (e.tokens_output ?? 0);
    const day = ts.toISOString().slice(0, 10);

    addTo(today, e, cents, ageMs <= D_MS);
    addTo(yesterday, e, cents, ageMs > D_MS && ageMs <= 2 * D_MS);
    addTo(week, e, cents, ageMs <= 7 * D_MS);

    // Daily aggregate (14 days).
    const daily = dailyMap.get(day);
    if (daily) addTo(daily, e, cents, true);

    // Stacked area: tokens by source, by day (14 days).
    const stack = stackedMap.get(day);
    if (stack && tokens > 0) {
      stack[e.source] = (stack[e.source] ?? 0) + tokens;
    }

    // 14-day source totals (controls render order in the legend).
    if (ageMs <= 14 * D_MS) {
      sourceTotals.set(e.source, (sourceTotals.get(e.source) ?? 0) + tokens);
    }

    // 7-day model mix by tokens.
    if (ageMs <= 7 * D_MS && e.model && tokens > 0) {
      modelTokens.set(e.model, (modelTokens.get(e.model) ?? 0) + tokens);
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

    // 30-day heatmap (uses local-tz-ish — ts is already UTC; we accept this for now).
    if (ageMs <= 30 * D_MS) {
      const dow = ts.getUTCDay();
      const hour = ts.getUTCHours();
      const k = `${dow}:${hour}`;
      heatmapMap.set(k, (heatmapMap.get(k) ?? 0) + 1);
    }

    // Cache efficiency (14 days).
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
      bucket:   shortDay(d),
      events:   s.events,
      tokens:   s.tokens,
      costCents: s.cents == null ? null : Math.round(s.cents),
      commits:  commitsByDay.get(d) ?? 0,
    };
  });

  const sparklines = {
    events:  daily.map((d) => d.events),
    tokens:  daily.map((d) => d.tokens),
    cost:    daily.map((d) => d.costCents ?? 0),
    commits: daily.map((d) => d.commits),
  };

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

  let cum = 0;
  const costTrajectory = daily.map((d) => {
    cum += d.costCents ?? 0;
    return { bucket: d.bucket, cents: cum };
  });

  const cacheEfficiency = daysBack.map((d) => {
    const reads = cacheReadsByDay.get(d) ?? 0;
    const writes = cacheWritesByDay.get(d) ?? 0;
    const ratio = writes === 0 ? 0 : reads / writes;
    return { bucket: shortDay(d), ratio, reads, writes };
  });

  // Recent feed: 50 newest events with derived cost.
  const feed: FeedRow[] = events.slice(0, 50).map((e) => {
    const ts = new Date(e.ts);
    const cents = costUsdCents({
      model:                  e.model,
      tokens_input:           e.tokens_input,
      tokens_output:          e.tokens_output,
      tokens_cache_read:      e.tokens_cache_read,
      tokens_cache_write:     e.tokens_cache_write,
      tokens_cache_5m_write:  e.tokens_cache_5m_write,
      tokens_cache_1h_write:  e.tokens_cache_1h_write,
      ts,
    });
    return {
      ts: e.ts,
      source: e.source,
      model: e.model,
      repo: e.repo_name,
      tokens_input: e.tokens_input,
      tokens_output: e.tokens_output,
      duration_ms: e.duration_ms,
      costCents: cents,
    };
  });

  return {
    today: {
      events: today.events,
      tokens: today.tokens,
      costCents: today.cents == null ? null : Math.round(today.cents),
    },
    yesterday: {
      events: yesterday.events,
      tokens: yesterday.tokens,
      costCents: yesterday.cents == null ? null : Math.round(yesterday.cents),
    },
    week: {
      events: week.events,
      tokens: week.tokens,
      costCents: week.cents == null ? null : Math.round(week.cents),
    },
    daily,
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

interface SumBucket { events: number; tokens: number; cents: number | null }
function newSum(): SumBucket { return { events: 0, tokens: 0, cents: null }; }
function addTo(sum: SumBucket, e: RawEvent, cents: number | null, include: boolean): void {
  if (!include) return;
  sum.events += 1;
  sum.tokens += (e.tokens_input ?? 0) + (e.tokens_output ?? 0);
  if (cents != null) sum.cents = (sum.cents ?? 0) + cents;
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
