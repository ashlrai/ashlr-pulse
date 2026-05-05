/**
 * cost-insights.ts — LLM-driven cost optimizer.
 *
 * Inputs are pure aggregates from the dashboard data layer (no
 * prompts, completions, or code content). Output is a small array of
 * dollar-quantified recommendations rendered as cards on /app.
 *
 * Recommendation kinds (constrained enum so the LLM can't invent
 * dangerous suggestions):
 *
 *   model_swap            — Opus → Sonnet on repos with low complexity
 *   enable_plugin_feature — turn on ashlr-plugin features the user
 *                           doesn't have (genome / snipcompact / route)
 *   cache_strategy        — adjust 5m vs 1h cache TTL
 *   parallelism_warning   — cmux N-instance running same session
 *
 * Caching: results are stored in `cost_insight` (migration 0017) keyed
 * by (user_id, day) and reused for ~6h. Re-computed when the user hits
 * the refresh affordance.
 *
 * Plan-gating: Pro/Team only. Free renders an upsell card.
 */

import { complete, llmStatus } from "@/lib/llm";

export type RecommendationKind =
  | "model_swap"
  | "enable_plugin_feature"
  | "cache_strategy"
  | "parallelism_warning";

export interface Recommendation {
  kind: RecommendationKind;
  /** Single-line headline, ≤80 chars. */
  title: string;
  /** 1–2 sentence explanation citing specific repo/model/pattern. */
  detail: string;
  /** Estimated $/month savings if the user acts. Shown next to title. */
  est_savings_usd_month: number;
  /** Short call-to-action, e.g. "Try genome", "Switch to Sonnet". */
  cta: string;
}

export interface InsightInputs {
  /** Per-model 14d aggregates: model, billable_tokens, cache_tokens, events, cost_cents. */
  byModel: { model: string; billable: number; cache: number; events: number; cost_cents: number }[];
  /** Per-repo 14d: repo, billable_tokens, events, cost_cents, dominant_model. */
  byRepo: { repo: string; billable: number; events: number; cost_cents: number; model: string | null }[];
  /** Plugin feature flags observed across the user's spans. Empty list
   *  means plugin not in use, which is itself a recommendation signal. */
  pluginFeatures: string[];
  /** 14d total cost in cents, for sizing recommendations. */
  totalCostCents: number;
  /** 14d cache hit rate (0..1). */
  cacheHitRate: number;
}

const SYSTEM_PROMPT = `You are a cost optimization analyst for an AI engineering dashboard.

You receive aggregated usage data (no prompts, no code, no completions — just numbers).
Suggest 1-3 concrete cost optimizations. Be specific: cite the model, repo,
or pattern. Quantify estimated $/month savings using the totals provided.

OUTPUT FORMAT — JSON ONLY, NO PROSE. An array of recommendation objects:

[
  {
    "kind": "model_swap" | "enable_plugin_feature" | "cache_strategy" | "parallelism_warning",
    "title": string (<= 80 chars),
    "detail": string (1-2 sentences citing the specific signal),
    "est_savings_usd_month": number (>= 0),
    "cta": string (<= 24 chars, e.g. "Try genome", "Switch to Sonnet")
  }
]

RULES:
- Return [] if nothing meaningful stands out.
- Never recommend something the data doesn't support.
- Do not include any text outside the JSON array.
- est_savings_usd_month must be a plausible round number, not a precise digit.
- Plugin features available: genome (context compression), snipcompact (file-read
  truncation), route (model auto-selection). Recommend enabling whichever ARE NOT
  in the user's pluginFeatures list when the data suggests the feature would help.`;

/** Heuristic recommendations as a fallback when no LLM is configured. */
function fallbackRecommendations(inp: InsightInputs): Recommendation[] {
  const out: Recommendation[] = [];

  // Plugin not in use → strongest signal.
  if (inp.pluginFeatures.length === 0 && inp.totalCostCents > 1000_00) {
    out.push({
      kind: "enable_plugin_feature",
      title: "Enable ashlr-plugin to compress context with genome",
      detail: `You spent $${(inp.totalCostCents / 100).toFixed(0)} in 14 days without the ashlr-plugin running. Genome typically reduces input tokens 30–60% on cmux workloads.`,
      est_savings_usd_month: Math.round((inp.totalCostCents / 100) * 0.35 * (30 / 14)),
      cta: "Install plugin",
    });
  }

  // Opus-heavy spend on small-repo work.
  const opus = inp.byModel.find((m) => m.model.includes("opus"));
  if (opus && opus.cost_cents > inp.totalCostCents * 0.6) {
    out.push({
      kind: "model_swap",
      title: "Most spend is on Opus — Sonnet may be enough for routine edits",
      detail: `Opus accounts for $${(opus.cost_cents / 100).toFixed(0)} of your $${(inp.totalCostCents / 100).toFixed(0)} 14d spend. Sonnet 4.6 runs most tool-using flows at ~⅙ the rate.`,
      est_savings_usd_month: Math.round((opus.cost_cents / 100) * 0.5 * (30 / 14)),
      cta: "Try Sonnet",
    });
  }

  // Cache hit rate is the leading indicator that 5m vs 1h is wrong.
  if (inp.cacheHitRate < 0.3 && inp.totalCostCents > 500_00) {
    out.push({
      kind: "cache_strategy",
      title: "Low cache reuse — consider longer (1h) cache TTL",
      detail: `Cache hit rate is ${Math.round(inp.cacheHitRate * 100)}% over 14 days. Long-running cmux sessions benefit from 1h cache; 5m TTL is wasted spend on writes never reused.`,
      est_savings_usd_month: Math.round((inp.totalCostCents / 100) * 0.15 * (30 / 14)),
      cta: "See guide",
    });
  }

  return out;
}

/**
 * Generate cost-optimization recommendations. Returns at most 3.
 *
 * On any LLM error, falls back to the heuristic recommendations so
 * the cards always render.
 */
export async function generateInsights(inp: InsightInputs): Promise<Recommendation[]> {
  // Skip the LLM entirely when nothing's configured — heuristic is fine.
  if (!llmStatus().configured) {
    return fallbackRecommendations(inp).slice(0, 3);
  }

  const userMsg = JSON.stringify({
    summary: {
      total_cost_cents_14d: inp.totalCostCents,
      cache_hit_rate: Number(inp.cacheHitRate.toFixed(3)),
      plugin_features_enabled: inp.pluginFeatures,
    },
    by_model: inp.byModel,
    by_repo: inp.byRepo,
  });

  const raw = await complete(SYSTEM_PROMPT, userMsg, {
    maxTokens: 600,
    temperature: 0.2,
    expectJson: true,
  });

  if (!raw) return fallbackRecommendations(inp).slice(0, 3);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallbackRecommendations(inp).slice(0, 3);
  }

  if (!Array.isArray(parsed)) return fallbackRecommendations(inp).slice(0, 3);

  const validKinds = new Set<RecommendationKind>([
    "model_swap", "enable_plugin_feature", "cache_strategy", "parallelism_warning",
  ]);
  const cleaned: Recommendation[] = [];
  for (const r of parsed) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.kind !== "string" || !validKinds.has(rec.kind as RecommendationKind)) continue;
    if (typeof rec.title !== "string" || rec.title.length === 0) continue;
    if (typeof rec.detail !== "string") continue;
    const est = typeof rec.est_savings_usd_month === "number" && Number.isFinite(rec.est_savings_usd_month)
      ? Math.max(0, Math.round(rec.est_savings_usd_month))
      : 0;
    const cta = typeof rec.cta === "string" && rec.cta.length > 0 ? rec.cta.slice(0, 24) : "Learn more";
    cleaned.push({
      kind: rec.kind as RecommendationKind,
      title: rec.title.slice(0, 80),
      detail: rec.detail.slice(0, 280),
      est_savings_usd_month: est,
      cta,
    });
    if (cleaned.length >= 3) break;
  }

  return cleaned.length > 0 ? cleaned : fallbackRecommendations(inp).slice(0, 3);
}
