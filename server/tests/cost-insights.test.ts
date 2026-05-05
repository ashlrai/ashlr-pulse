/**
 * cost-insights.test.ts — fallback heuristics for the LLM cost
 * optimizer. The LLM path is tested via integration; the fallback
 * is what runs when no API key is configured (free-tier without LLM,
 * or the LLM returns malformed JSON).
 */

import { describe, expect, test } from "bun:test";

// We only exercise the heuristic fallback here. The exported function
// is `generateInsights` which calls the LLM when configured. To force
// the fallback, we ensure no LLM env vars are set in test mode.
// (In CI, no provider env vars are set, so this naturally exercises
// the fallback path.)
import { generateInsights } from "../src/lib/cost-insights";

describe("generateInsights — heuristic fallback", () => {
  test("returns plugin recommendation when plugin not in use and spend is large", async () => {
    const recs = await generateInsights({
      byModel: [],
      byRepo: [],
      pluginFeatures: [],
      totalCostCents: 200_000, // $2,000
      cacheHitRate: 0.5,
    });
    // Should contain at least the plugin enable recommendation.
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.some((r) => r.kind === "enable_plugin_feature")).toBe(true);
  });

  test("returns model_swap when Opus dominates spend", async () => {
    const recs = await generateInsights({
      byModel: [
        { model: "claude-opus-4-7", billable: 1_000_000, cache: 0, events: 100, cost_cents: 80_000 },
        { model: "sonnet 4.6",      billable:   100_000, cache: 0, events: 100, cost_cents: 10_000 },
      ],
      byRepo: [],
      pluginFeatures: ["genome"],
      totalCostCents: 100_000,
      cacheHitRate: 0.7,
    });
    expect(recs.some((r) => r.kind === "model_swap")).toBe(true);
  });

  test("recommends cache_strategy when hit rate is low and spend non-trivial", async () => {
    const recs = await generateInsights({
      byModel: [],
      byRepo: [],
      pluginFeatures: ["genome"],
      totalCostCents: 100_000,
      cacheHitRate: 0.05,
    });
    expect(recs.some((r) => r.kind === "cache_strategy")).toBe(true);
  });

  test("returns at most 3 recommendations", async () => {
    const recs = await generateInsights({
      byModel: [
        { model: "claude-opus-4-7", billable: 1_000_000, cache: 0, events: 100, cost_cents: 800_000 },
      ],
      byRepo: [],
      pluginFeatures: [],
      totalCostCents: 1_000_000,
      cacheHitRate: 0.05,
    });
    expect(recs.length).toBeLessThanOrEqual(3);
  });

  test("est_savings_usd_month is a non-negative integer", async () => {
    const recs = await generateInsights({
      byModel: [],
      byRepo: [],
      pluginFeatures: [],
      totalCostCents: 200_000,
      cacheHitRate: 0.5,
    });
    for (const r of recs) {
      expect(r.est_savings_usd_month).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.est_savings_usd_month)).toBe(true);
    }
  });
});
