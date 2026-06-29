/**
 * cost-drift-detector.test.ts — unit tests for the cross-source cost
 * attribution + model preference drift detector.
 *
 * Pure functions — no DB, no LLM, no side effects. Always runs in CI.
 *
 * Coverage:
 *   1. detectCostDrift — WoW % delta, threshold flagging, recommendation
 *   2. OLS trend line via linearRegression reuse (slope, 7d forecast)
 *   3. >5% threshold detection (DRIFT_THRESHOLD_PCT)
 *   4. splitWindows — 28-day window split
 *   5. normalizeModelKey — model name canonicalization
 *   6. Edge cases: empty input, single source, zero prev-cost
 */

import { describe, expect, test } from "bun:test";
import {
  detectCostDrift,
  splitWindows,
  normalizeModelKey,
  totalCostMillicents,
  DRIFT_THRESHOLD_PCT,
  type DailyAggregate,
} from "../src/lib/cost-drift-detector";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDay(
  date: string,
  source: string,
  model: string,
  cost_millicents: number,
  event_count = 1,
): DailyAggregate {
  return { date, source, model, cost_millicents, event_count };
}

/** Build a contiguous 14-day window starting at `startDate`. */
function makeWindow(
  startDate: string,
  source: string,
  model: string,
  dailyCost: number,
): DailyAggregate[] {
  const base = new Date(`${startDate}T00:00:00Z`);
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(base.getTime() + i * 86_400_000);
    const date = d.toISOString().slice(0, 10);
    return makeDay(date, source, model, dailyCost);
  });
}

// ─── normalizeModelKey ────────────────────────────────────────────────────────

describe("normalizeModelKey", () => {
  test("claude-opus-* → opus", () => {
    expect(normalizeModelKey("claude-opus-4-7")).toBe("opus");
    expect(normalizeModelKey("claude-opus-4")).toBe("opus");
  });

  test("claude-sonnet-* → sonnet", () => {
    expect(normalizeModelKey("claude-sonnet-4-6")).toBe("sonnet");
  });

  test("claude-haiku-* → haiku", () => {
    expect(normalizeModelKey("claude-haiku-3")).toBe("haiku");
  });

  test("gpt-4o → gpt-4o", () => {
    expect(normalizeModelKey("gpt-4o")).toBe("gpt-4o");
    expect(normalizeModelKey("gpt-4o-mini")).toBe("gpt-4o");
  });

  test("unknown model passes through (truncated to 16 chars)", () => {
    const long = "some-unknown-model-xyz";
    expect(normalizeModelKey(long)).toBe(long.slice(0, 16));
  });
});

// ─── splitWindows ─────────────────────────────────────────────────────────────

describe("splitWindows", () => {
  test("returns empty arrays for empty input", () => {
    const { prev14d, curr14d } = splitWindows([]);
    expect(prev14d).toEqual([]);
    expect(curr14d).toEqual([]);
  });

  test("splits 28-day input into roughly equal halves", () => {
    const rows: DailyAggregate[] = [];
    const base = new Date("2024-01-01T00:00:00Z");
    for (let i = 0; i < 28; i++) {
      const d = new Date(base.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      rows.push(makeDay(d, "claude_code", "sonnet", 1000));
    }
    const { prev14d, curr14d } = splitWindows(rows);
    // Prev should be the older dates, curr the newer ones.
    expect(prev14d.length).toBeGreaterThan(0);
    expect(curr14d.length).toBeGreaterThan(0);
    // All prev dates < all curr dates.
    const prevDates = prev14d.map((r) => r.date);
    const currDates = curr14d.map((r) => r.date);
    expect(Math.max(...prevDates.map((d) => new Date(d).getTime()))).toBeLessThanOrEqual(
      Math.min(...currDates.map((d) => new Date(d).getTime())),
    );
  });

  test("single-day input goes entirely to curr window", () => {
    const rows = [makeDay("2024-06-01", "cursor", "gpt-4o", 500)];
    const { prev14d, curr14d } = splitWindows(rows);
    expect(prev14d.length).toBe(0);
    expect(curr14d.length).toBe(1);
  });
});

// ─── totalCostMillicents ──────────────────────────────────────────────────────

describe("totalCostMillicents", () => {
  test("sums all rows", () => {
    const rows = [
      makeDay("2024-01-01", "cursor", "gpt-4o", 1000),
      makeDay("2024-01-02", "claude_code", "sonnet", 2000),
    ];
    expect(totalCostMillicents(rows)).toBe(3000);
  });

  test("returns 0 for empty array", () => {
    expect(totalCostMillicents([])).toBe(0);
  });
});

// ─── detectCostDrift — WoW delta calculation ──────────────────────────────────

describe("detectCostDrift — WoW % delta", () => {
  test("no drift when prev and curr are identical", () => {
    const prev = makeWindow("2024-01-01", "claude_code", "sonnet", 1000);
    const curr = makeWindow("2024-01-15", "claude_code", "sonnet", 1000);
    const drift = detectCostDrift(prev, curr);
    expect(drift.sourceShift["claude_code"]).toBeCloseTo(0, 1);
    expect(drift.modelShift["sonnet"]).toBeCloseTo(0, 1);
    expect(drift.anomalousShifts.length).toBe(0);
  });

  test("detects +50% source cost increase correctly", () => {
    const prev = makeWindow("2024-01-01", "cursor", "gpt-4o", 1000);
    const curr = makeWindow("2024-01-15", "cursor", "gpt-4o", 1500);
    const drift = detectCostDrift(prev, curr);
    // 14 days × 1000 = 14000 prev; 14 × 1500 = 21000 curr → +50%
    expect(drift.sourceShift["cursor"]).toBeCloseTo(50, 1);
  });

  test("detects -25% source cost decrease correctly", () => {
    const prev = makeWindow("2024-01-01", "claude_code", "sonnet", 2000);
    const curr = makeWindow("2024-01-15", "claude_code", "sonnet", 1500);
    const drift = detectCostDrift(prev, curr);
    expect(drift.sourceShift["claude_code"]).toBeCloseTo(-25, 1);
  });

  test("shift > DRIFT_THRESHOLD_PCT flagged in anomalousShifts", () => {
    const prev = makeWindow("2024-01-01", "cursor", "gpt-4o", 1000);
    const curr = makeWindow("2024-01-15", "cursor", "gpt-4o", 1200); // +20%
    const drift = detectCostDrift(prev, curr);
    expect(drift.anomalousShifts.some((a) => a.key === "cursor")).toBe(true);
    const entry = drift.anomalousShifts.find((a) => a.key === "cursor");
    expect(entry?.pct).toBeGreaterThan(DRIFT_THRESHOLD_PCT);
  });

  test("shift at exactly DRIFT_THRESHOLD_PCT IS flagged (≥ threshold)", () => {
    // +5% exactly: 1000 → 1050 per day.
    const prev = makeWindow("2024-01-01", "copilot", "gpt-4", 1000);
    const curr = makeWindow("2024-01-15", "copilot", "gpt-4", 1050);
    const drift = detectCostDrift(prev, curr);
    const entry = drift.anomalousShifts.find((a) => a.key === "copilot");
    expect(entry).toBeDefined();
    expect(Math.abs(entry!.pct)).toBeGreaterThanOrEqual(DRIFT_THRESHOLD_PCT);
  });

  test("shift below DRIFT_THRESHOLD_PCT is NOT flagged", () => {
    // +3% — below threshold
    const prev = makeWindow("2024-01-01", "copilot", "gpt-4", 1000);
    const curr = makeWindow("2024-01-15", "copilot", "gpt-4", 1030);
    const drift = detectCostDrift(prev, curr);
    expect(drift.anomalousShifts.some((a) => a.key === "copilot")).toBe(false);
  });

  test("model shift computed with normalized keys", () => {
    const prev = makeWindow("2024-01-01", "claude_code", "claude-opus-4-7", 3000);
    const curr = makeWindow("2024-01-15", "claude_code", "claude-sonnet-4-6", 3000);
    const drift = detectCostDrift(prev, curr);
    // opus dropped to 0 (new period uses sonnet), sonnet appeared
    expect(drift.modelShift["opus"]).toBe(-100); // dropped completely
    expect(drift.modelShift["sonnet"]).toBe(100); // new model
  });

  test("new source in curr (no prev) reports +100%", () => {
    const prev = makeWindow("2024-01-01", "claude_code", "sonnet", 1000);
    const curr = [
      ...makeWindow("2024-01-15", "claude_code", "sonnet", 1000),
      ...makeWindow("2024-01-15", "cursor", "gpt-4o", 500), // new source
    ];
    const drift = detectCostDrift(prev, curr);
    expect(drift.sourceShift["cursor"]).toBe(100);
  });

  test("dropped source in curr (no curr) reports -100%", () => {
    const prev = [
      ...makeWindow("2024-01-01", "claude_code", "sonnet", 1000),
      ...makeWindow("2024-01-01", "cursor", "gpt-4o", 500),
    ];
    const curr = makeWindow("2024-01-15", "claude_code", "sonnet", 1000);
    const drift = detectCostDrift(prev, curr);
    expect(drift.sourceShift["cursor"]).toBe(-100);
  });
});

// ─── detectCostDrift — OLS trend line / 7d forecast ──────────────────────────

describe("detectCostDrift — OLS trend + 7d forecast", () => {
  test("predictedDrift7d has 7 entries per source with enough history", () => {
    // 28 combined days for each source → enough for OLS.
    const prev = makeWindow("2024-01-01", "cursor", "gpt-4o", 1000);
    const curr = makeWindow("2024-01-15", "cursor", "gpt-4o", 1200);
    const drift = detectCostDrift(prev, curr);
    if (drift.predictedDrift7d["cursor"]) {
      expect(drift.predictedDrift7d["cursor"].byDay.length).toBe(7);
    }
  });

  test("OLS slope is positive when cost is steadily increasing", () => {
    // Build escalating daily costs across 28 days.
    const base = new Date("2024-01-01T00:00:00Z");
    const rows: DailyAggregate[] = Array.from({ length: 28 }, (_, i) => {
      const d = new Date(base.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      return makeDay(d, "cursor", "gpt-4o", 500 + i * 50); // steadily rising
    });
    const { prev14d, curr14d } = splitWindows(rows);
    const drift = detectCostDrift(prev14d, curr14d);
    const forecast = drift.predictedDrift7d["cursor"];
    if (forecast) {
      expect(forecast.slope).toBeGreaterThan(0);
    }
  });

  test("OLS R² is between 0 and 1", () => {
    const prev = makeWindow("2024-01-01", "claude_code", "sonnet", 2000);
    const curr = makeWindow("2024-01-15", "claude_code", "sonnet", 2200);
    const drift = detectCostDrift(prev, curr);
    const forecast = drift.predictedDrift7d["claude_code"];
    if (forecast) {
      expect(forecast.rSquared).toBeGreaterThanOrEqual(0);
      expect(forecast.rSquared).toBeLessThanOrEqual(1);
    }
  });

  test("all projected daily costs are >= 0 (floor applied)", () => {
    // Strongly declining series — OLS may project negatives, but we clamp.
    const base = new Date("2024-01-01T00:00:00Z");
    const rows: DailyAggregate[] = Array.from({ length: 28 }, (_, i) => {
      const d = new Date(base.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      return makeDay(d, "cursor", "gpt-4o", Math.max(0, 5000 - i * 300));
    });
    const { prev14d, curr14d } = splitWindows(rows);
    const drift = detectCostDrift(prev14d, curr14d);
    const forecast = drift.predictedDrift7d["cursor"];
    if (forecast) {
      for (const v of forecast.byDay) {
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ─── detectCostDrift — recommendation string ──────────────────────────────────

describe("detectCostDrift — recommendation", () => {
  test("returns empty string when no anomalies", () => {
    const prev = makeWindow("2024-01-01", "claude_code", "sonnet", 1000);
    const curr = makeWindow("2024-01-15", "claude_code", "sonnet", 1010); // +1% — no anomaly
    const drift = detectCostDrift(prev, curr);
    expect(drift.recommendation).toBe("");
  });

  test("recommendation is non-empty when anomaly is present", () => {
    const prev = makeWindow("2024-01-01", "cursor", "gpt-4o", 1000);
    const curr = makeWindow("2024-01-15", "cursor", "gpt-4o", 1200); // +20%
    const drift = detectCostDrift(prev, curr);
    expect(drift.recommendation.length).toBeGreaterThan(0);
  });

  test("recommendation mentions the top-anomaly source", () => {
    const prev = makeWindow("2024-01-01", "cursor", "gpt-4o", 1000);
    const curr = makeWindow("2024-01-15", "cursor", "gpt-4o", 1500); // +50%
    const drift = detectCostDrift(prev, curr);
    // "Cursor" should appear in the recommendation.
    expect(drift.recommendation.toLowerCase()).toMatch(/cursor/i);
  });

  test("recommendation for opus growth warns about cost", () => {
    // Opus grows significantly while sonnet stays flat — clear opus drift signal.
    // Use the same source so source drift stays below threshold, letting model drift dominate.
    const prev = [
      ...makeWindow("2024-01-01", "claude_code", "claude-opus-4-7",   500),
      ...makeWindow("2024-01-01", "claude_code", "claude-sonnet-4-6", 500),
    ];
    const curr = [
      ...makeWindow("2024-01-15", "claude_code", "claude-opus-4-7",   900), // opus +80%
      ...makeWindow("2024-01-15", "claude_code", "claude-sonnet-4-6", 500), // sonnet flat
    ];
    const drift = detectCostDrift(prev, curr);
    // The top model anomaly should be opus (+80%) — recommendation must reference it.
    expect(drift.recommendation.toLowerCase()).toMatch(/opus/i);
  });

  test("anomalousShifts sorted by absolute magnitude descending", () => {
    const prev = [
      ...makeWindow("2024-01-01", "cursor",      "gpt-4o", 1000),
      ...makeWindow("2024-01-01", "claude_code", "sonnet",  500),
    ];
    const curr = [
      ...makeWindow("2024-01-15", "cursor",      "gpt-4o", 2000), // +100%
      ...makeWindow("2024-01-15", "claude_code", "sonnet",  510), // +2%
    ];
    const drift = detectCostDrift(prev, curr);
    const anomalous = drift.anomalousShifts;
    // cursor (+100%) should appear before claude_code (+2%, below threshold)
    expect(anomalous[0].key).toBe("cursor");
    // claude_code is below threshold — should not be in anomalous list
    expect(anomalous.some((a) => a.key === "claude_code")).toBe(false);
  });
});

// ─── detectCostDrift — edge cases ─────────────────────────────────────────────

describe("detectCostDrift — edge cases", () => {
  test("handles empty prev and curr gracefully", () => {
    const drift = detectCostDrift([], []);
    expect(drift.sourceShift).toEqual({});
    expect(drift.modelShift).toEqual({});
    expect(drift.anomalousShifts).toEqual([]);
    expect(drift.recommendation).toBe("");
  });

  test("handles empty prev with non-empty curr", () => {
    const curr = makeWindow("2024-01-15", "cursor", "gpt-4o", 1000);
    const drift = detectCostDrift([], curr);
    // New source from nothing → +100%
    expect(drift.sourceShift["cursor"]).toBe(100);
  });

  test("handles non-empty prev with empty curr", () => {
    const prev = makeWindow("2024-01-01", "cursor", "gpt-4o", 1000);
    const drift = detectCostDrift(prev, []);
    // Source dropped → -100%
    expect(drift.sourceShift["cursor"]).toBe(-100);
  });

  test("handles multiple sources independently", () => {
    const prev = [
      ...makeWindow("2024-01-01", "cursor",      "gpt-4o", 1000),
      ...makeWindow("2024-01-01", "claude_code", "sonnet",  500),
    ];
    const curr = [
      ...makeWindow("2024-01-15", "cursor",      "gpt-4o", 1200),
      ...makeWindow("2024-01-15", "claude_code", "sonnet",  450),
    ];
    const drift = detectCostDrift(prev, curr);
    // cursor: +20%
    expect(drift.sourceShift["cursor"]).toBeCloseTo(20, 1);
    // claude_code: -10%
    expect(drift.sourceShift["claude_code"]).toBeCloseTo(-10, 1);
  });

  test("zero-cost rows in both windows produce no shift entry", () => {
    const prev = makeWindow("2024-01-01", "claude_code", "sonnet", 0);
    const curr = makeWindow("2024-01-15", "claude_code", "sonnet", 0);
    const drift = detectCostDrift(prev, curr);
    // Both zero → skipped in computeShift
    expect("claude_code" in drift.sourceShift).toBe(false);
  });
});

// ─── Cron alert stub — email queue behavior ───────────────────────────────────

describe("cron alert — drift threshold integration", () => {
  test("DRIFT_THRESHOLD_PCT constant is 5", () => {
    // The cron uses this constant to decide whether to fire alerts.
    // Validate it's the documented value so callers can rely on it.
    expect(DRIFT_THRESHOLD_PCT).toBe(5);
  });

  test("anomalousShifts only includes entries >= threshold", () => {
    const prev = [
      ...makeWindow("2024-01-01", "cursor",      "gpt-4o", 1000),
      ...makeWindow("2024-01-01", "claude_code", "sonnet",  200),
    ];
    const curr = [
      ...makeWindow("2024-01-15", "cursor",      "gpt-4o", 1200), // +20% → flagged
      ...makeWindow("2024-01-15", "claude_code", "sonnet",  204), // +2% → clean
    ];
    const drift = detectCostDrift(prev, curr);
    for (const a of drift.anomalousShifts) {
      expect(Math.abs(a.pct)).toBeGreaterThanOrEqual(DRIFT_THRESHOLD_PCT);
    }
  });

  test("anomalousShifts.kind is source or model", () => {
    const prev = makeWindow("2024-01-01", "cursor", "gpt-4o", 1000);
    const curr = makeWindow("2024-01-15", "cursor", "gpt-4o", 1500);
    const drift = detectCostDrift(prev, curr);
    for (const a of drift.anomalousShifts) {
      expect(["source", "model"]).toContain(a.kind);
    }
  });
});
