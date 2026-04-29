/**
 * portfolio-db.ts — per-project health metrics for /portfolio.
 *
 * The portfolio page answers "which engagement is slipping?" in <10s
 * without opening GitHub. Each project gets a card with:
 *
 *   - commits_7d          — count of github_event kind='commit' in 7d
 *   - commits_per_day[]   — 7-element bar chart, oldest-first
 *   - contributors_7d     — distinct actor_login over 7d
 *   - last_deploy_at      — latest commit on default branch (proxied
 *                           as latest github_event kind='commit' whose
 *                           branch matches github_repo.default_branch)
 *   - ai_share_pct        — AI events ÷ all events on these repos, 7d
 *   - tokens_mtd          — sum tokens (input+output) MTD
 *   - cost_mtd_cents      — sum dollar cost MTD
 *
 * All queries are scoped via membership → org → project, so a peer
 * with grants but no shared org never sees portfolio cards for the
 * peer's projects (use the dashboard `?as=` view instead).
 */

import { sql } from "./db";
import { costUsdCents } from "./pricing";

export interface ProjectHealth {
  project_id: string;
  project_name: string;
  kind: string;
  repos: string[];

  commits_7d: number;
  /** 7 cells, oldest-first. */
  commits_per_day: number[];
  contributors_7d: number;

  /** ISO timestamp of latest commit on a default branch in the project. */
  last_deploy_at: string | null;

  /** Total events on these repos over 7d (any source). */
  events_7d: number;
  /** AI events (events with a model attached) over 7d. */
  ai_events_7d: number;

  tokens_mtd: number;
  cost_mtd_cents: number;
}

/**
 * Compute health metrics for every project the user is a member of.
 * Single round-trip per project group of queries — runs O(N) projects'
 * worth of fetches in parallel via Promise.all on the portfolio page.
 */
export async function loadPortfolioHealth(
  userId: string,
  asOf: Date = new Date(),
): Promise<ProjectHealth[]> {
  const db = sql();

  const projects = await db<{
    project_id: string;
    project_name: string;
    kind: string;
    repos: string[] | null;
  }[]>`
    SELECT
      p.id::text   AS project_id,
      p.name       AS project_name,
      p.kind,
      COALESCE(
        ARRAY_AGG(pr.repo_name ORDER BY pr.repo_name)
          FILTER (WHERE pr.repo_name IS NOT NULL),
        ARRAY[]::text[]
      ) AS repos
    FROM project p
    JOIN membership m ON m.org_id = p.org_id AND m.user_id = ${userId}
    LEFT JOIN project_repo pr ON pr.project_id = p.id
    GROUP BY p.id, p.name, p.kind
    ORDER BY p.name
  `;

  if (projects.length === 0) return [];

  const sevenDaysAgo = new Date(asOf.getTime() - 7 * 24 * 3600_000);
  const monthStart = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));

  // Per-project async fan-out. Each branch is a small query; running
  // them in parallel keeps the whole page < 1s on a warm DB.
  return Promise.all(
    projects.map(async (p) => {
      const repos = p.repos ?? [];
      if (repos.length === 0) {
        return {
          project_id: p.project_id,
          project_name: p.project_name,
          kind: p.kind,
          repos: [],
          commits_7d: 0,
          commits_per_day: new Array(7).fill(0),
          contributors_7d: 0,
          last_deploy_at: null,
          events_7d: 0,
          ai_events_7d: 0,
          tokens_mtd: 0,
          cost_mtd_cents: 0,
        };
      }

      const [commitsRows, contribRow, lastDeployRow, eventsRow, mtdRows] = await Promise.all([
        // commits per day, last 7d, on these repos
        db<{ day: string; n: number }[]>`
          SELECT
            DATE_TRUNC('day', ge.ts)::date::text AS day,
            COUNT(*)::int                        AS n
          FROM github_event ge
          JOIN github_repo gr ON gr.id = ge.repo_id
          WHERE ge.kind = 'commit'
            AND ge.ts >= ${sevenDaysAgo.toISOString()}::timestamptz
            AND ge.ts <  ${asOf.toISOString()}::timestamptz
            AND gr.full_name = ANY(${repos})
          GROUP BY 1
        `,
        // distinct contributors, 7d
        db<{ n: number }[]>`
          SELECT COUNT(DISTINCT ge.actor_login)::int AS n
          FROM github_event ge
          JOIN github_repo gr ON gr.id = ge.repo_id
          WHERE ge.kind = 'commit'
            AND ge.ts >= ${sevenDaysAgo.toISOString()}::timestamptz
            AND ge.ts <  ${asOf.toISOString()}::timestamptz
            AND gr.full_name = ANY(${repos})
        `,
        // last commit on a default branch
        db<{ last_at: string | null }[]>`
          SELECT MAX(ge.ts)::text AS last_at
          FROM github_event ge
          JOIN github_repo gr ON gr.id = ge.repo_id
          WHERE ge.kind = 'commit'
            AND gr.full_name = ANY(${repos})
            AND (gr.default_branch IS NULL OR ge.branch = gr.default_branch)
        `,
        // events 7d (total + AI)
        db<{ events: number; ai_events: number }[]>`
          SELECT
            COUNT(*)::int                                              AS events,
            COUNT(*) FILTER (WHERE model IS NOT NULL)::int             AS ai_events
          FROM activity_event
          WHERE user_id = ${userId}
            AND repo_name = ANY(${repos})
            AND ts >= ${sevenDaysAgo.toISOString()}::timestamptz
            AND ts <  ${asOf.toISOString()}::timestamptz
        `,
        // raw rows for MTD pricing — we compute cost in TS via the
        // shared pricing helper to keep the SQL provider-agnostic.
        db<{
          model: string | null;
          tokens_input: number | null;
          tokens_output: number | null;
          tokens_cache_read: number | null;
          tokens_cache_write: number | null;
          tokens_cache_5m_write: number | null;
          tokens_cache_1h_write: number | null;
          ts: string;
        }[]>`
          SELECT model,
            tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
            tokens_cache_5m_write, tokens_cache_1h_write,
            ts::text AS ts
          FROM activity_event
          WHERE user_id = ${userId}
            AND repo_name = ANY(${repos})
            AND ts >= ${monthStart.toISOString()}::timestamptz
        `,
      ]);

      // 7-day commits sparkline (oldest-first), zero-fill missing days.
      const perDay = new Array(7).fill(0);
      const dayKey = (d: Date) =>
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      const idxByKey = new Map<string, number>();
      for (let i = 0; i < 7; i++) {
        const d = new Date(asOf.getTime() - (6 - i) * 24 * 3600_000);
        idxByKey.set(dayKey(d), i);
      }
      let total7 = 0;
      for (const r of commitsRows) {
        // r.day comes back as YYYY-MM-DD already.
        const idx = idxByKey.get(r.day);
        if (idx != null) perDay[idx] = r.n;
        total7 += r.n;
      }

      let tokens_mtd = 0;
      let cost_mtd_cents = 0;
      for (const r of mtdRows) {
        tokens_mtd += (r.tokens_input ?? 0) + (r.tokens_output ?? 0);
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
        if (c != null) cost_mtd_cents += c;
      }

      return {
        project_id: p.project_id,
        project_name: p.project_name,
        kind: p.kind,
        repos,
        commits_7d: total7,
        commits_per_day: perDay,
        contributors_7d: contribRow[0]?.n ?? 0,
        last_deploy_at: lastDeployRow[0]?.last_at ?? null,
        events_7d: eventsRow[0]?.events ?? 0,
        ai_events_7d: eventsRow[0]?.ai_events ?? 0,
        tokens_mtd,
        cost_mtd_cents,
      };
    }),
  );
}
