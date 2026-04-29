/**
 * standup.ts — AI-generated "yesterday / today / blocked" per user.
 *
 * Inputs we feed the LLM (all already authorized for the user):
 *   - Yesterday's activity rollup (tools, repos, projects, GitHub counts)
 *   - This week's intent note (hints at "today")
 *   - Anomalies vs. baseline (might be the "blocked")
 *
 * Output: a JSON object with three short strings. Strict format so we
 * can render it as cards or fall back to template-rendered copy when
 * no LLM is configured.
 *
 * Cached for 12 hours per user — standups are stable across a day, and
 * we don't want to bill the LLM on every dashboard load.
 */

import { sql } from "./db";
import { complete, llmStatus } from "./llm";
import { yesterdayWindow } from "./digest";
import { weekStartUtc, getIntentForWeek } from "./intent-db";
import type { DigestSelf } from "./digest";

export interface Standup {
  yesterday: string;  // 1-2 sentences
  today: string;      // 1-2 sentences (intent-aware)
  blocked: string;    // 1 sentence; "" if nothing blocking
  generated_at: string;
  source: "llm" | "template";
}

export interface StandupInputs {
  email: string;
  dateLabel: string;
  self: DigestSelf;
  intent: string | null;
  anomaly: string | null;
}

const SYSTEM_PROMPT = `
You write developer standups in the voice of the engineer themselves —
first-person, terse, factual. No corporate jargon, no fluff.

Given JSON about yesterday's coding activity (top tools, top repos,
GitHub commits, optional intent note), produce a JSON object:

  {
    "yesterday": "1-2 sentences naming what they actually worked on",
    "today":     "1-2 sentences inferring or restating today's plan",
    "blocked":   "1 sentence — empty string if no apparent blockers"
  }

Rules:
- "yesterday" cites the top repo and total commits when present.
- "today" leans on the intent note when provided; otherwise extrapolate
  from the most-active repos.
- "blocked" stays empty unless the input mentions an anomaly.
- No markdown. No emoji. No bullet points. Pure prose.
- ≤ 200 characters per field. Active voice.
`.trim();

/**
 * Build cache key. We bucket by UTC day so a day's standup is stable.
 */
function cacheKey(userId: string, asOf: Date): string {
  const day = asOf.toISOString().slice(0, 10);
  return `standup:${userId}:${day}`;
}

export async function generateStandup(
  userId: string,
  inputs: StandupInputs,
  asOf: Date = new Date(),
): Promise<Standup> {
  const status = llmStatus();
  if (!status.configured) {
    return { ...templated(inputs), generated_at: asOf.toISOString(), source: "template" };
  }

  const userJson = JSON.stringify({
    date: inputs.dateLabel,
    yesterday: {
      top_tools: inputs.self.bySource.slice(0, 3).map((s) => ({ tool: s.source, events: s.events, tokens: s.tokens })),
      top_repos: inputs.self.byRepo.slice(0, 4).map((r) => ({ repo: r.repo, events: r.events, tokens: r.tokens })),
      top_projects: inputs.self.byProject.slice(0, 3).map((p) => ({ name: p.project_name, events: p.events })),
      github: inputs.self.github,
      missed_repos: inputs.self.missedRepos,
    },
    intent: inputs.intent,
    anomaly: inputs.anomaly,
  });

  const raw = await complete(SYSTEM_PROMPT, userJson, {
    temperature: 0.3,
    maxTokens: 320,
    expectJson: true,
  });
  if (!raw) {
    return { ...templated(inputs), generated_at: asOf.toISOString(), source: "template" };
  }

  try {
    const parsed = JSON.parse(raw) as { yesterday?: string; today?: string; blocked?: string };
    return {
      yesterday: clamp(parsed.yesterday) || templated(inputs).yesterday,
      today:     clamp(parsed.today)     || templated(inputs).today,
      blocked:   clamp(parsed.blocked)   ?? "",
      generated_at: asOf.toISOString(),
      source: "llm",
    };
  } catch {
    return { ...templated(inputs), generated_at: asOf.toISOString(), source: "template" };
  }
}

function clamp(s: string | undefined): string {
  if (!s) return "";
  const trimmed = s.trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 237).trim()}…` : trimmed;
}

/**
 * Templated fallback when no LLM is configured. Deterministic prose
 * built from the same inputs the LLM would see.
 */
function templated(inputs: StandupInputs): Pick<Standup, "yesterday" | "today" | "blocked"> {
  const topRepo = inputs.self.byRepo[0]?.repo;
  const topTool = inputs.self.bySource[0]?.source;
  const commits = inputs.self.github.commits;

  const yParts: string[] = [];
  if (commits > 0 && topRepo) yParts.push(`${commits} commit${commits === 1 ? "" : "s"} on ${topRepo}`);
  if (topTool) yParts.push(`mostly ${topTool}`);
  const yesterday = yParts.length > 0 ? yParts.join("; ") + "." : "no recorded activity yesterday.";

  const today = inputs.intent
    ? `intent: ${inputs.intent}`
    : topRepo
      ? `continuing on ${topRepo}.`
      : "no intent set yet — write one on /attention.";

  const blocked = inputs.anomaly ?? "";

  return { yesterday, today, blocked };
}

// ---------------------------------------------------------------------------
// 12h cache via ai_cache (migration 0017).
// ---------------------------------------------------------------------------

export async function getOrComputeStandup(
  userId: string,
  inputs: StandupInputs,
  asOf: Date = new Date(),
): Promise<Standup> {
  const key = cacheKey(userId, asOf);
  const db = sql();

  const [hit] = await db<{ body: Standup; generated_at: string }[]>`
    SELECT body, generated_at::text AS generated_at
    FROM ai_cache
    WHERE user_id = ${userId}::uuid
      AND cache_key = ${key}
      AND generated_at > NOW() - INTERVAL '12 hours'
    LIMIT 1
  `;
  if (hit) {
    return hit.body;
  }

  const standup = await generateStandup(userId, inputs, asOf);
  await db`
    INSERT INTO ai_cache (user_id, cache_key, body, source)
    VALUES (
      ${userId}::uuid,
      ${key},
      ${JSON.stringify(standup)}::jsonb,
      ${standup.source}
    )
    ON CONFLICT (user_id, cache_key) DO UPDATE
      SET body = EXCLUDED.body,
          source = EXCLUDED.source,
          generated_at = NOW()
  `;

  return standup;
}

/**
 * Convenience helper: build StandupInputs from the digest payload.
 * Used by both the dashboard and the digest renderer.
 */
export function inputsFromDigest(payload: {
  email: string; dateLabel: string; self: DigestSelf;
}, intent: string | null, anomaly: string | null): StandupInputs {
  return {
    email: payload.email,
    dateLabel: payload.dateLabel,
    self: payload.self,
    intent,
    anomaly,
  };
}

// Re-exports so callers don't have to import yesterdayWindow / weekStartUtc separately.
export { yesterdayWindow, weekStartUtc, getIntentForWeek };
