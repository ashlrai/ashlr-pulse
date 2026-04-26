/**
 * missed-repos.ts — find repos with GitHub commits but zero AI-tool
 * activity in a given window. Strong signal that the agent isn't
 * running on those repos (or that the user pushed manually).
 *
 * Used by both the dashboard's warning panel and the daily digest.
 */

import { sql } from "./db";

export async function loadMissedRepos(
  userId: string,
  startUtc: string,
  endUtc: string,
): Promise<string[]> {
  const db = sql();
  const reposWithCommits = await db<{ full_name: string }[]>`
    SELECT DISTINCT gr.full_name
    FROM github_event ge
    JOIN github_repo    gr ON gr.id = ge.repo_id
    JOIN github_account ga ON ga.id = ge.account_id
    WHERE ga.user_id = ${userId}::uuid
      AND ge.kind = 'commit'
      AND ge.ts >= ${startUtc}::timestamptz
      AND ge.ts <  ${endUtc}::timestamptz
  `;
  if (reposWithCommits.length === 0) return [];

  const reposWithTokens = await db<{ repo_name: string }[]>`
    SELECT DISTINCT repo_name
    FROM activity_event
    WHERE user_id = ${userId}
      AND repo_name IS NOT NULL
      AND ts >= ${startUtc}::timestamptz
      AND ts <  ${endUtc}::timestamptz
  `;
  const haveTokens = new Set(reposWithTokens.map((r) => r.repo_name));
  return reposWithCommits
    .map((r) => r.full_name)
    .filter((r) => !haveTokens.has(r))
    .sort();
}
