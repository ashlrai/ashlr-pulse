/**
 * anomaly-explain.ts — LLM-generated 1-liner explaining *why* a metric
 * spiked or dropped. Fed by the same data the dashboard already loaded;
 * no fresh DB queries beyond the cache lookup.
 *
 * Cached per (user, metric, hour-bucket) in ai_cache so dashboard
 * reloads don't re-bill the LLM.
 */

import { sql } from "./db";
import { complete, llmStatus } from "./llm";
import type { Anomaly } from "./anomalies";

export interface AnomalyContext {
  /** Top repos contributing to the metric today. */
  top_repos: { repo: string; events: number; tokens: number; cents: number | null }[];
  /** Top tools/sources today. */
  top_tools: { tool: string; events: number; tokens: number }[];
  /** Top projects with names. */
  top_projects: { name: string; events: number; tokens: number }[];
  /** Optional GitHub commit count today — sometimes a tokens spike is "I'm
   *  doing 8 commits today, not 1." */
  github_commits_today?: number;
}

const SYSTEM_PROMPT = `
You explain a metric anomaly on a developer's coding dashboard in one
short sentence.

Inputs: an anomaly summary (metric, direction, magnitude) plus context
about what's driving the day (top repos, tools, projects, github
commits).

Output: ONE plain-prose sentence (≤ 160 chars) that names the most
likely cause. No hedging, no "perhaps", no markdown, no emoji.

If the data clearly points to one or two repos/projects, name them.
If multiple factors look balanced, say "broad-based across …".
If the spike is up, lean toward what's *new* today vs baseline.
If the spike is down, suggest what's *missing* (no commits / single
tool / quiet day).
`.trim();

function bucketKey(metric: string, asOf: Date): string {
  // Per metric, per UTC hour. The dashboard typically renders multiple
  // times within an hour; cache hits cover those.
  const hour = asOf.toISOString().slice(0, 13).replace("T", "@");
  return `anomaly:${metric}:${hour}`;
}

export async function explainAnomaly(
  userId: string,
  anomaly: Anomaly,
  ctx: AnomalyContext,
  asOf: Date = new Date(),
): Promise<string | null> {
  const status = llmStatus();
  if (!status.configured) return templated(anomaly, ctx);

  const key = bucketKey(anomaly.metric, asOf);
  const db = sql();
  const [hit] = await db<{ body: { text: string } }[]>`
    SELECT body
    FROM ai_cache
    WHERE user_id = ${userId}::uuid
      AND cache_key = ${key}
      AND generated_at > NOW() - INTERVAL '1 hour'
    LIMIT 1
  `;
  if (hit) return hit.body.text;

  const userJson = JSON.stringify({
    anomaly: {
      metric: anomaly.metric,
      delta_pct: Math.round(anomaly.delta * 100),
      severity: anomaly.severity,
      summary: anomaly.message,
    },
    context: ctx,
  });

  const raw = await complete(SYSTEM_PROMPT, userJson, {
    temperature: 0.2,
    maxTokens: 100,
  });
  const text = clamp(raw) || templated(anomaly, ctx);
  if (!text) return null;

  await db`
    INSERT INTO ai_cache (user_id, cache_key, body, source)
    VALUES (
      ${userId}::uuid,
      ${key},
      ${JSON.stringify({ text })}::jsonb,
      ${raw ? "llm" : "template"}
    )
    ON CONFLICT (user_id, cache_key) DO UPDATE
      SET body = EXCLUDED.body, source = EXCLUDED.source, generated_at = NOW()
  `;
  return text;
}

function clamp(s: string | null): string | null {
  if (!s) return null;
  const t = s.trim().replace(/^["']|["']$/g, "");
  if (!t) return null;
  return t.length > 200 ? `${t.slice(0, 197).trim()}…` : t;
}

function templated(anomaly: Anomaly, ctx: AnomalyContext): string {
  const repo = ctx.top_repos[0]?.repo;
  const tool = ctx.top_tools[0]?.tool;
  if (anomaly.delta > 0) {
    if (repo && tool) return `${anomaly.message}; mostly ${repo} via ${tool}.`;
    if (repo) return `${anomaly.message}; concentrated on ${repo}.`;
    return `${anomaly.message}.`;
  }
  // Lower than baseline.
  if (ctx.github_commits_today === 0 && (ctx.top_repos.length ?? 0) === 0) {
    return `${anomaly.message}; no commits or AI activity recorded.`;
  }
  return `${anomaly.message}.`;
}
