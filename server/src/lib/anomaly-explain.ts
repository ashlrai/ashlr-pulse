/**
 * anomaly-explain.ts — LLM-driven explainer for the existing numeric
 * anomalies (lib/anomalies.ts).
 *
 * The base detector returns "tokens up 24× vs weekly baseline". This
 * module adds a 1-2 sentence explanation citing the specific
 * model/repo/session that drove the spike, so the user gets actionable
 * context instead of just a number.
 *
 * Inputs are aggregates over the spike day, not raw rows. The privacy
 * floor still applies: no prompts, completions, or code content.
 */

import { complete, llmStatus } from "@/lib/llm";

export interface AnomalyExplainInputs {
  /** What spiked: "tokens" | "cost" | "events". */
  metric: string;
  /** Date of the spike, YYYY-MM-DD. */
  day: string;
  /** Multiplier vs weekly baseline (e.g. 24.9). */
  factor: number;
  /** Top contributors by cost on the spike day. */
  topRepos: { repo: string; events: number; cost_cents: number }[];
  topModels: { model: string; tokens: number; cost_cents: number }[];
  /** Number of distinct sessions that day (cmux fingerprint). */
  sessionCount: number;
}

const SYSTEM_PROMPT = `You are an analyst explaining why an AI usage metric spiked.

You receive aggregates from one day (no prompts, completions, code). Write a
2-sentence explanation citing the specific repo, model, or session pattern that
drove the spike. End with one short, actionable suggestion (~10 words).

OUTPUT: plain text, 2-3 sentences total, no markdown, no preamble.`;

function fallbackExplanation(inp: AnomalyExplainInputs): string {
  const repo = inp.topRepos[0]?.repo ?? "your projects";
  const model = inp.topModels[0]?.model ?? "the active model";
  return [
    `${inp.metric} spiked ${inp.factor.toFixed(1)}× on ${inp.day}, driven mostly by ${repo} on ${model} across ${inp.sessionCount} session${inp.sessionCount === 1 ? "" : "s"}.`,
    `Open the ${repo} feed below to see whether this matches a planned push.`,
  ].join(" ");
}

export async function explainAnomaly(inp: AnomalyExplainInputs): Promise<string> {
  if (!llmStatus().configured) {
    return fallbackExplanation(inp);
  }

  const userMsg = JSON.stringify({
    metric: inp.metric,
    day: inp.day,
    factor_vs_baseline: inp.factor,
    top_repos: inp.topRepos.slice(0, 3),
    top_models: inp.topModels.slice(0, 3),
    session_count: inp.sessionCount,
  });

  const raw = await complete(SYSTEM_PROMPT, userMsg, {
    maxTokens: 200,
    temperature: 0.3,
  });

  if (!raw) return fallbackExplanation(inp);
  return raw.trim().slice(0, 400);
}
