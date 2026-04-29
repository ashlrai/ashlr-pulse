import { describe, expect, test } from "bun:test";
import { detectAnomaly } from "../src/lib/anomalies";

describe("detectAnomaly", () => {
  test("returns null when baseline mean is zero", () => {
    expect(detectAnomaly({
      current: 100, baseline: [0, 0, 0], metric: "events", noun: "events",
    })).toBeNull();
  });

  test("returns null when current is within 1σ of baseline", () => {
    // baseline mean = 100, stdev ~ 10. 105 is well within 1σ.
    expect(detectAnomaly({
      current: 105, baseline: [90, 95, 100, 105, 110], metric: "events", noun: "events",
    })).toBeNull();
  });

  test("returns medium severity when current is 2-3σ above mean", () => {
    // baseline mean = 100, stdev ~ 10 (using values 90,95,100,105,110)
    // current = 130 → z ≈ 4 σ → high
    const a = detectAnomaly({
      current: 130, baseline: [90, 95, 100, 105, 110], metric: "events", noun: "events",
    });
    expect(a).not.toBeNull();
    expect(a?.severity).toBe("high");
    expect(a?.delta).toBeGreaterThan(0);
    expect(a?.message).toMatch(/up/);
  });

  test("returns medium severity for ~2σ spike", () => {
    // mean = 100, stdev ~ 7.07, current = 115 → z ≈ 2.12 → medium
    const a = detectAnomaly({
      current: 115, baseline: [90, 95, 100, 105, 110], metric: "events", noun: "events",
    });
    expect(a).not.toBeNull();
    expect(a?.severity).toBe("medium");
  });

  test("returns low severity for ~1.2σ spike", () => {
    // mean = 100, stdev = sqrt(50) ≈ 7.07, current = 109 → z ≈ 1.27 → low
    const a = detectAnomaly({
      current: 109, baseline: [90, 95, 100, 105, 110], metric: "events", noun: "events",
    });
    expect(a).not.toBeNull();
    expect(a?.severity).toBe("low");
  });

  test("flags downward anomaly with appropriate message", () => {
    // mean = 100, current = 50 → z way negative
    const a = detectAnomaly({
      current: 50, baseline: [95, 100, 105, 100, 100], metric: "tokens", noun: "tokens",
    });
    expect(a).not.toBeNull();
    expect(a?.delta).toBeLessThan(0);
    expect(a?.message).toMatch(/lower/);
  });

  test("works with empty baseline", () => {
    // mean=0 path returns null, but empty array also handled
    expect(detectAnomaly({
      current: 1, baseline: [], metric: "events", noun: "events",
    })).toBeNull();
  });
});
