/**
 * forecast.test.ts — pure-stats projection used by /app's cost
 * trajectory chart. No LLM calls, no DB.
 */

import { describe, expect, test } from "bun:test";
import { forecast, sumForecast } from "../src/lib/forecast";

describe("forecast", () => {
  test("empty history returns empty projection", () => {
    expect(forecast({ history: [] })).toEqual([]);
  });

  test("short history (<2 weeks) uses flat-mean fallback", () => {
    const out = forecast({ history: [100, 200, 300, 400, 500], horizon: 7 });
    expect(out.length).toBe(7);
    // Mean of inputs is 300 — every projected p50 should round to 300.
    for (const p of out) {
      expect(p.p50).toBe(300);
      expect(p.p10).toBeLessThan(p.p50);
      expect(p.p90).toBeGreaterThan(p.p50);
    }
  });

  test("flat 14d history projects flat going forward", () => {
    const flat = Array(14).fill(1000);
    const out = forecast({ history: flat, horizon: 14 });
    expect(out.length).toBe(14);
    // No noise → residuals near zero → bands collapse to point.
    // Allow modest drift from numerical artifacts.
    for (const p of out) {
      expect(Math.abs(p.p50 - 1000)).toBeLessThan(50);
    }
  });

  test("rising trend projects forward (Holt-Winters captures slope)", () => {
    // Three weeks of linearly rising data: 100, 200, 300, ..., 2100
    const rising = Array.from({ length: 21 }, (_, i) => (i + 1) * 100);
    const out = forecast({ history: rising, horizon: 7 });
    // With a clear positive trend, day-30 should exceed the last input.
    expect(out[6].p50).toBeGreaterThan(rising[rising.length - 1]);
  });

  test("p90 >= p50 >= p10 always", () => {
    const noisy = Array.from({ length: 21 }, () => Math.random() * 1000);
    const out = forecast({ history: noisy, horizon: 14 });
    for (const p of out) {
      expect(p.p10).toBeLessThanOrEqual(p.p50);
      expect(p.p50).toBeLessThanOrEqual(p.p90);
      expect(p.p10).toBeGreaterThanOrEqual(0);
    }
  });

  test("sumForecast aggregates each percentile", () => {
    const out = forecast({ history: Array(14).fill(500), horizon: 30 });
    const sum = sumForecast(out);
    expect(sum.p50).toBeGreaterThan(0);
    expect(sum.p10).toBeLessThanOrEqual(sum.p50);
    expect(sum.p50).toBeLessThanOrEqual(sum.p90);
  });
});
