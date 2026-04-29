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
): Promise<DashboardData> {
  const db = sql();

  // Pull a 30-day window of raw rows; we'll bucket in memory. 30 days ×
  // ~1k events/day on a heavy user is ~30k rows, well under what
  // postgres-js handles in one round trip. If this gets bigger later,
  // we can bucket in SQL — but for now in-memory is fine.
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
      AND ts >= NOW() - INTERVAL '30 days'
      ${scope.repoClauseSql}
    ORDER BY ts DESC
    `,
    [userId, ...scope.repoParams],
  );

  // Pull last 24h of github commits (subjects only — public info).
  // github_event ⨝ github_account (account_id) ⨝ github_repo (repo_id).
  const commits = await db<{ subject: string; repo: string; sha: string; ts: string }[]>`
    SELECT
      ge.message_first_line AS subject,
      gr.full_name          AS repo,
      ge.external_id        AS sha,
      ge.ts::text           AS ts
    FROM github_event ge
    JOIN github_account ga ON ga.id = ge.account_id
    JOIN github_repo    gr ON gr.id = ge.repo_id
    WHERE ga.user_id = ${userId}
      AND ge.kind    = 'commit'
      AND ge.ts >= NOW() - INTERVAL '14 days'
    ORDER BY ge.ts DESC
    LIMIT 50
  `.catch(() => []);

  return computeAggregates(events, commits);
}

function computeAggregates(
  events: RawEvent[],
  commits: { subject: string; repo: string; sha: string; ts: string }[],
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
  const daysBack14 = lastNDays(14);
  for (const d of daysBack14) {
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

  // Commits per day (last 14d).
  const commitsByDay = new Map<string, number>();
  for (const c of commits) {
    const day = c.ts.slice(0, 10);
    commitsByDay.set(day, (commitsByDay.get(day) ?? 0) + 1);
  }

  // -------- Build outputs --------
  const sources = [...sourceTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);

  const stackedArea: { bucket: string; [series: string]: string | number }[] = daysBack14.map((d) => {
    const out: { bucket: string; [series: string]: string | number } = { bucket: shortDay(d) };
    const slice = stackedMap.get(d) ?? {};
    for (const s of sources) out[s] = slice[s] ?? 0;
    return out;
  });

  const daily = daysBack14.map<DailyAggregate>((d) => {
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

  const cacheEfficiency = daysBack14.map((d) => {
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
