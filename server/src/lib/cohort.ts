/**
 * cohort.ts — week-vs-week comparison + per-PR ROI for the dashboard.
 *
 * Two outputs that the cohort card renders:
 *
 *   1. WeekCohort — total events/tokens/cost for the trailing 7 days
 *      and the prior 7 days, plus deltas. Lightweight rollup; one query.
 *
 *   2. PrShipped — the most recent merged PRs with the activity-event
 *      tokens spent on the same repo in the 24h window before merge.
 *      A directional read on "AI tokens → PR shipping" — not a perfect
 *      attribution, but actionable for the dev: "I spent 60k tokens
 *      on this repo before this PR landed."
 */

import { sql } from "./db";
import { costUsdCents } from "./pricing";

export interface WeekCohort {
  this_week: { events: number; tokens: number; cents: number; commits: number };
  prev_week: { events: number; tokens: number; cents: number; commits: number };
  deltas: {
    events_pct: number | null;
    tokens_pct: number | null;
    cents_pct:  number | null;
    commits_pct: number | null;
  };
}

export interface PrShipped {
  repo: string;
  pr_number: string;
  actor_login: string;
  merged_at: string;
  /** Tokens of activity on this repo in the 24h before merge. */
  pre_merge_tokens: number;
  /** Cost (cents) of that activity. */
  pre_merge_cents: number;
}

/**
 * Compute week-over-week totals for a user. Boundaries are UTC for
 * simplicity — the dashboard already calls this with a TZ-anchored
 * `asOf` so the result lines up with the user's local week.
 */
export async function loadWeekCohort(
  userId: string,
  asOf: Date = new Date(),
): Promise<WeekCohort> {
  const db = sql();
  const thisWeekStart = new Date(asOf.getTime() - 7 * 24 * 3600_000);
  const prevWeekStart = new Date(asOf.getTime() - 14 * 24 * 3600_000);

  const [thisRows, prevRows, ghThis, ghPrev] = await Promise.all([
    activityRows(userId, thisWeekStart, asOf),
    activityRows(userId, prevWeekStart, thisWeekStart),
    commitCount(userId, thisWeekStart, asOf),
    commitCount(userId, prevWeekStart, thisWeekStart),
  ]);

  const thisAgg = aggregate(thisRows);
  const prevAgg = aggregate(prevRows);

  return {
    this_week: { ...thisAgg, commits: ghThis },
    prev_week: { ...prevAgg, commits: ghPrev },
    deltas: {
      events_pct:  pct(thisAgg.events, prevAgg.events),
      tokens_pct:  pct(thisAgg.tokens, prevAgg.tokens),
      cents_pct:   pct(thisAgg.cents,  prevAgg.cents),
      commits_pct: pct(ghThis, ghPrev),
    },
  };
}

interface ActivityRow {
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  tokens_cache_5m_write: number | null;
  tokens_cache_1h_write: number | null;
  ts: string;
}

async function activityRows(userId: string, fromUtc: Date, toUtc: Date): Promise<ActivityRow[]> {
  const db = sql();
  return db<ActivityRow[]>`
    SELECT model,
           tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
           tokens_cache_5m_write, tokens_cache_1h_write,
           ts::text AS ts
    FROM activity_event
    WHERE user_id = ${userId}::uuid
      AND ts >= ${fromUtc.toISOString()}::timestamptz
      AND ts <  ${toUtc.toISOString()}::timestamptz
  `;
}

async function commitCount(userId: string, fromUtc: Date, toUtc: Date): Promise<number> {
  const db = sql();
  const [row] = await db<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM github_event ge
    JOIN github_account ga ON ga.id = ge.account_id
    WHERE ga.user_id = ${userId}::uuid
      AND ge.kind = 'commit'
      AND ge.ts >= ${fromUtc.toISOString()}::timestamptz
      AND ge.ts <  ${toUtc.toISOString()}::timestamptz
  `;
  return row?.n ?? 0;
}

function aggregate(rows: ActivityRow[]): { events: number; tokens: number; cents: number } {
  let tokens = 0, cents = 0;
  for (const r of rows) {
    tokens += (r.tokens_input ?? 0) + (r.tokens_output ?? 0);
    const c = costUsdCents({
      model: r.model,
      tokens_input: r.tokens_input,
      tokens_output: r.tokens_output,
      tokens_cache_read: r.tokens_cache_read,
      tokens_cache_write: r.tokens_cache_write,
      tokens_cache_5m_write: r.tokens_cache_5m_write,
      tokens_cache_1h_write: r.tokens_cache_1h_write,
      ts: new Date(r.ts),
    });
    if (c != null) cents += c;
  }
  return { events: rows.length, tokens, cents };
}

/** Percent change `(curr - prev) / prev`. Returns null when prev is 0. */
function pct(curr: number, prev: number): number | null {
  if (prev === 0) return curr === 0 ? 0 : null;
  return (curr - prev) / prev;
}

/**
 * Pull the last `limit` merged PRs for the user and attribute the
 * tokens of activity on the same repo in the 24h before merge.
 */
export async function loadRecentShippedPRs(
  userId: string,
  limit = 5,
  asOf: Date = new Date(),
): Promise<PrShipped[]> {
  const db = sql();

  const prs = await db<{
    pr_number: string; actor_login: string; merged_at: string; full_name: string;
  }[]>`
    SELECT
      ge.external_id  AS pr_number,
      ge.actor_login,
      ge.ts::text     AS merged_at,
      gr.full_name    AS full_name
    FROM github_event ge
    JOIN github_repo    gr ON gr.id = ge.repo_id
    JOIN github_account ga ON ga.id = ge.account_id
    WHERE ga.user_id = ${userId}::uuid
      AND ge.kind = 'pr_merged'
      AND ge.ts < ${asOf.toISOString()}::timestamptz
    ORDER BY ge.ts DESC
    LIMIT ${limit}
  `;
  if (prs.length === 0) return [];

  // Per-PR window query. Cheap because limit is small.
  return Promise.all(
    prs.map(async (pr) => {
      const mergedAt = new Date(pr.merged_at);
      const windowStart = new Date(mergedAt.getTime() - 24 * 3600_000);
      const rows = await db<ActivityRow[]>`
        SELECT model,
               tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
               tokens_cache_5m_write, tokens_cache_1h_write,
               ts::text AS ts
        FROM activity_event
        WHERE user_id = ${userId}::uuid
          AND repo_name = ${pr.full_name}
          AND ts >= ${windowStart.toISOString()}::timestamptz
          AND ts <  ${pr.merged_at}::timestamptz
      `;
      const { tokens, cents } = aggregate(rows);
      return {
        repo: pr.full_name,
        pr_number: pr.pr_number,
        actor_login: pr.actor_login,
        merged_at: pr.merged_at,
        pre_merge_tokens: tokens,
        pre_merge_cents: cents,
      };
    }),
  );
}
