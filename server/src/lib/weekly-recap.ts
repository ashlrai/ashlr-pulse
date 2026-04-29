/**
 * weekly-recap.ts — Monday-morning narrative covering the prior 7 days.
 *
 * Mounted in the digest *only* on Monday in the user's TZ. The body is
 * a 3-4 sentence prose paragraph from the LLM:
 *
 *   - what shipped (top repos, github commits/PRs)
 *   - where AI time went (top tools, top projects)
 *   - intent vs. actual diff (if last week's intent_note was set)
 *   - one forward-looking sentence based on this week's intent_note
 *
 * Cached per (user, week_start) for 7 days — same payload all week.
 */

import { sql } from "./db";
import { complete, llmStatus } from "./llm";
import { weekStartUtc, getIntentForWeek } from "./intent-db";
import { costUsdCents } from "./pricing";

export interface WeeklyRecap {
  week_start: string;
  body: string;          // 3-4 sentence narrative
  source: "llm" | "template";
  generated_at: string;
}

interface WeekTotals {
  events: number;
  tokens: number;
  cents: number;
  commits: number;
  prs_opened: number;
  prs_merged: number;
}

interface ProjectShare {
  project_name: string;
  events: number;
  tokens: number;
}

interface RepoShare {
  repo: string;
  events: number;
  tokens: number;
}

interface ToolShare {
  tool: string;
  events: number;
}

interface RecapInputs {
  this_week_start: string;
  prev_week_start: string;
  totals: WeekTotals;
  prev_totals: WeekTotals;
  top_projects: ProjectShare[];
  top_repos: RepoShare[];
  top_tools: ToolShare[];
  prev_intent: string | null;
  this_intent: string | null;
}

const SYSTEM_PROMPT = `
You write Monday-morning weekly recaps for solo developers and small
engineering teams. Tone: direct, factual, no fluff, no marketing voice.

Given JSON about the prior 7 days (totals, top projects/repos/tools,
github events, optional intent notes), produce a 3-4 sentence prose
paragraph.

Rules:
- Sentence 1: "what shipped" — name top repo + commit count when
  available, else top project.
- Sentence 2: "where attention went" — top project + percentage when
  meaningful.
- Sentence 3 (optional): intent diff. If last week's intent matched
  the actual top project, say so positively. If it diverged, name
  the divergence neutrally.
- Sentence 4 (optional): one-line forward look using this week's
  intent if set.
- Active voice, second-person ("you") when needed.
- No markdown. No bullet points. No emoji.
- Total ≤ 540 characters.
`.trim();

export async function generateWeeklyRecap(
  inputs: RecapInputs,
): Promise<{ body: string; source: "llm" | "template" }> {
  const status = llmStatus();
  if (!status.configured) return { body: templated(inputs), source: "template" };

  const userJson = JSON.stringify(inputs);
  const raw = await complete(SYSTEM_PROMPT, userJson, {
    temperature: 0.3,
    maxTokens: 240,
  });
  if (!raw) return { body: templated(inputs), source: "template" };

  const body = clamp(raw);
  return { body: body || templated(inputs), source: body ? "llm" : "template" };
}

function clamp(s: string | null): string {
  if (!s) return "";
  const t = s.trim().replace(/^["']|["']$/g, "");
  return t.length > 600 ? `${t.slice(0, 597).trim()}…` : t;
}

function templated(i: RecapInputs): string {
  const top = i.top_projects[0]?.project_name ?? i.top_repos[0]?.repo ?? "no project";
  const commits = i.totals.commits;
  const tokens = formatTokens(i.totals.tokens);
  const parts: string[] = [];
  if (commits > 0) {
    parts.push(`Last week: ${commits} commit${commits === 1 ? "" : "s"} across ${i.top_repos.length} repo${i.top_repos.length === 1 ? "" : "s"}, ${tokens} tokens.`);
  } else {
    parts.push(`Last week: no commits, ${tokens} tokens.`);
  }
  if (i.top_projects.length > 0 && i.totals.events > 0) {
    const p = i.top_projects[0];
    const share = Math.round((p.events / i.totals.events) * 100);
    parts.push(`Most attention on ${p.project_name} (${share}%).`);
  }
  if (i.this_intent) {
    parts.push(`This week's intent: ${i.this_intent}`);
  }
  return parts.join(" ");
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// 7-day cache + main entry point that pulls inputs from the DB.
// ---------------------------------------------------------------------------

export async function getOrComputeWeeklyRecap(
  userId: string,
  asOf: Date = new Date(),
): Promise<WeeklyRecap | null> {
  const thisWeek = weekStartUtc(asOf);
  const cacheKey = `recap:${thisWeek}`;
  const db = sql();

  const [hit] = await db<{ body: WeeklyRecap; generated_at: string }[]>`
    SELECT body, generated_at::text AS generated_at
    FROM ai_cache
    WHERE user_id = ${userId}::uuid
      AND cache_key = ${cacheKey}
      AND generated_at > NOW() - INTERVAL '7 days'
    LIMIT 1
  `;
  if (hit) return hit.body;

  const inputs = await loadRecapInputs(userId, asOf);
  if (!inputs) return null;
  const result = await generateWeeklyRecap(inputs);

  const recap: WeeklyRecap = {
    week_start: thisWeek,
    body: result.body,
    source: result.source,
    generated_at: asOf.toISOString(),
  };

  await db`
    INSERT INTO ai_cache (user_id, cache_key, body, source)
    VALUES (
      ${userId}::uuid,
      ${cacheKey},
      ${JSON.stringify(recap)}::jsonb,
      ${result.source}
    )
    ON CONFLICT (user_id, cache_key) DO UPDATE
      SET body = EXCLUDED.body, source = EXCLUDED.source, generated_at = NOW()
  `;
  return recap;
}

async function loadRecapInputs(userId: string, asOf: Date): Promise<RecapInputs | null> {
  const db = sql();

  const thisWeekStart = new Date(weekStartUtc(asOf) + "T00:00:00Z");
  const prevWeekStart = new Date(thisWeekStart.getTime() - 7 * 24 * 3600_000);

  const [thisRows, prevRows, gh, prevGh, intentThis, intentPrev] = await Promise.all([
    db<{ source: string; repo_name: string | null; model: string | null; tokens_input: number | null; tokens_output: number | null; tokens_cache_read: number | null; tokens_cache_write: number | null; tokens_cache_5m_write: number | null; tokens_cache_1h_write: number | null; ts: string }[]>`
      SELECT source, repo_name, model,
             tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
             tokens_cache_5m_write, tokens_cache_1h_write,
             ts::text AS ts
      FROM activity_event
      WHERE user_id = ${userId}::uuid
        AND ts >= ${prevWeekStart.toISOString()}::timestamptz
        AND ts <  ${thisWeekStart.toISOString()}::timestamptz
    `,
    Promise.resolve([] as never[]),
    db<{ kind: string }[]>`
      SELECT ge.kind
      FROM github_event ge
      JOIN github_account ga ON ga.id = ge.account_id
      WHERE ga.user_id = ${userId}::uuid
        AND ge.ts >= ${prevWeekStart.toISOString()}::timestamptz
        AND ge.ts <  ${thisWeekStart.toISOString()}::timestamptz
    `,
    Promise.resolve([] as { kind: string }[]),
    getIntentForWeek(userId, weekStartUtc(asOf)),
    getIntentForWeek(userId, weekStartUtc(prevWeekStart)),
  ]);

  const totals = aggTotals(thisRows, gh);
  const prev_totals = aggTotals(prevRows, prevGh);

  // Project rollup (re-uses the user's project memberships).
  const repoCounts = new Map<string, RepoShare>();
  const toolCounts = new Map<string, ToolShare>();
  for (const r of thisRows) {
    const repo = r.repo_name ?? "(unassigned)";
    const cur = repoCounts.get(repo) ?? { repo, events: 0, tokens: 0 };
    cur.events += 1;
    cur.tokens += (r.tokens_input ?? 0) + (r.tokens_output ?? 0);
    repoCounts.set(repo, cur);

    const tool = r.source;
    const t = toolCounts.get(tool) ?? { tool, events: 0 };
    t.events += 1;
    toolCounts.set(tool, t);
  }
  const top_repos = [...repoCounts.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  const top_tools = [...toolCounts.values()].sort((a, b) => b.events - a.events).slice(0, 4);

  const repoNames = top_repos.map((r) => r.repo);
  const projectMap = repoNames.length > 0
    ? await db<{ repo_name: string; project_name: string }[]>`
        SELECT pr.repo_name, p.name AS project_name
        FROM project_repo pr
        JOIN project p    ON p.id = pr.project_id
        JOIN membership m ON m.org_id = p.org_id AND m.user_id = ${userId}::uuid
        WHERE pr.repo_name = ANY(${repoNames})
      `
    : [];
  const repoToProject = new Map<string, string>();
  for (const r of projectMap) repoToProject.set(r.repo_name, r.project_name);

  const projectAcc = new Map<string, ProjectShare>();
  for (const r of top_repos) {
    const name = repoToProject.get(r.repo) ?? "(unassigned)";
    const cur = projectAcc.get(name) ?? { project_name: name, events: 0, tokens: 0 };
    cur.events += r.events;
    cur.tokens += r.tokens;
    projectAcc.set(name, cur);
  }
  const top_projects = [...projectAcc.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 4);

  return {
    this_week_start: weekStartUtc(asOf),
    prev_week_start: weekStartUtc(prevWeekStart),
    totals,
    prev_totals,
    top_projects,
    top_repos,
    top_tools,
    prev_intent: intentPrev?.body ?? null,
    this_intent: intentThis?.body ?? null,
  };
}

function aggTotals(
  rows: { tokens_input: number | null; tokens_output: number | null; tokens_cache_read: number | null; tokens_cache_write: number | null; tokens_cache_5m_write: number | null; tokens_cache_1h_write: number | null; model: string | null; ts: string }[],
  gh: { kind: string }[],
): WeekTotals {
  let tokens = 0;
  let cents = 0;
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
  let commits = 0, prs_opened = 0, prs_merged = 0;
  for (const e of gh) {
    if (e.kind === "commit") commits++;
    else if (e.kind === "pr_opened") prs_opened++;
    else if (e.kind === "pr_merged") prs_merged++;
  }
  return { events: rows.length, tokens, cents, commits, prs_opened, prs_merged };
}
