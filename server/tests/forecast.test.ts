import { describe, test, expect } from "bun:test";
import { forecast } from "../src/lib/forecast";

describe("forecast", () => {
  test("flat series projects flat", () => {
    const r = forecast([100, 100, 100, 100, 100], null, new Date("2026-04-15T00:00:00Z"));
    expect(Math.round(r.perDay)).toBe(100);
    // April has 30 days, asOf is the 15th → 15 days left.
    expect(r.remainingMonth).toBeCloseTo(100 * 15, 0);
  });

  test("rising series projects above current rate", () => {
    const r = forecast([10, 20, 30, 40, 50], null, new Date("2026-04-15T00:00:00Z"));
    // perDay should be > 50 because the trend extrapolates beyond the last point.
    expect(r.perDay).toBeGreaterThan(50);
  });

  test("crosses target within 60d when slope is positive", () => {
    const r = forecast([100, 100, 100], 1000, new Date("2026-04-15T00:00:00Z"));
    expect(r.hitsTargetOn).not.toBeNull();
    // 1000 / 100 = 10 days roughly (after the 300 already in monthSoFar).
    if (r.hitsTargetOn) {
      const d = new Date(r.hitsTargetOn);
      const days = Math.round((d.getTime() - new Date("2026-04-15T00:00:00Z").getTime()) / 86_400_000);
      expect(days).toBeGreaterThan(0);
      expect(days).toBeLessThan(20);
    }
  });

  test("never hits unreachable target → null", () => {
    const r = forecast([1, 1, 1], 1_000_000, new Date("2026-04-15T00:00:00Z"));
    expect(r.hitsTargetOn).toBeNull();
  });

  test("empty input returns zeros (no NaN)", () => {
    const r = forecast([], null);
    expect(Number.isFinite(r.perDay)).toBe(true);
    expect(Number.isFinite(r.projectedMonthTotal)).toBe(true);
  });
});
