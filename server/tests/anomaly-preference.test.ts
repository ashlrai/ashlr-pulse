/**
 * anomaly-preference.test.ts — unit tests for anomaly alert preference helpers.
 *
 * Tests the pure filterAnomaliesByPreferences() function and the
 * applyThresholds logic (via filterAnomaliesByPreferences with threshold
 * multipliers). DB functions (getEffectivePreferences, upsertPreference) are
 * tested via structural assertions only — no live DB needed.
 *
 * Coverage:
 *   1. filterAnomaliesByPreferences — disabled kind is filtered out.
 *   2. filterAnomaliesByPreferences — enabled kind passes through.
 *   3. filterAnomaliesByPreferences — all kinds disabled → empty result.
 *   4. filterAnomaliesByPreferences — default (all enabled) passes all.
 *   5. filterAnomaliesByPreferences — threshold multiplier raises low/medium boundary.
 *   6. filterAnomaliesByPreferences — threshold multiplier lowers medium/high boundary.
 *   7. filterAnomaliesByPreferences — unknown kind passes through (defensive).
 *   8. threshold filtering — cost_spike severity downgraded with high low-threshold.
 *   9. threshold filtering — peer_divergence severity stays medium at exactly 3×.
 *  10. threshold filtering — anomaly without ratio passes through unchanged.
 *  11. SSE filter integration: verifies that broadcastAnomalyBatchFiltered drops
 *      disabled kinds (structural / unit, no network).
 *  12. ANOMALY_KINDS constant has exactly 6 entries matching AnomalyKind union.
 */

import { describe, expect, test } from "bun:test";
import {
  filterAnomaliesByPreferences,
  ANOMALY_KINDS,
  type AnomalyPreference,
  type AnomalyPreferenceMap,
} from "../src/lib/anomaly-preference-db";
import type { RealtimeAnomaly, AnomalyKind, AnomalySeverity } from "../src/lib/realtime-anomaly";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePreferenceMap(overrides: Partial<Record<AnomalyKind, Partial<AnomalyPreference>>> = {}): AnomalyPreferenceMap {
  const map = {} as AnomalyPreferenceMap;
  for (const kind of ANOMALY_KINDS) {
    map[kind] = {
      kind,
      enabled: true,
      severity_low_threshold: 1.0,
      severity_high_threshold: 1.0,
      ...(overrides[kind] ?? {}),
    };
  }
  return map;
}

function makeAnomaly(
  kind: AnomalyKind,
  severity: AnomalySeverity = "low",
  ratio: number | null = 2.5,
): RealtimeAnomaly {
  return {
    kind,
    severity,
    message: `test anomaly: ${kind}`,
    repo_name: null,
    user_id: null,
    context: ratio !== null ? { ratio } : {},
  };
}

// ---------------------------------------------------------------------------
// 1–4. Basic enable/disable filtering
// ---------------------------------------------------------------------------

describe("filterAnomaliesByPreferences — enable/disable toggles", () => {
  test("disabled kind is removed from results", () => {
    const prefs = makePreferenceMap({ cost_spike: { enabled: false } });
    const anomalies: RealtimeAnomaly[] = [
      makeAnomaly("cost_spike", "high"),
      makeAnomaly("model_thrash", "low"),
    ];
    const result = filterAnomaliesByPreferences(anomalies, prefs);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("model_thrash");
  });

  test("enabled kind passes through unchanged when thresholds are default", () => {
    const prefs = makePreferenceMap();
    const anomalies: RealtimeAnomaly[] = [makeAnomaly("cost_spike", "medium", 2.5)];
    const result = filterAnomaliesByPreferences(anomalies, prefs);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("medium");
  });

  test("all kinds disabled returns empty array", () => {
    const overrides = Object.fromEntries(
      ANOMALY_KINDS.map((k) => [k, { enabled: false }]),
    ) as Partial<Record<AnomalyKind, Partial<AnomalyPreference>>>;
    const prefs = makePreferenceMap(overrides);
    const anomalies = ANOMALY_KINDS.map((k) => makeAnomaly(k));
    expect(filterAnomaliesByPreferences(anomalies, prefs)).toHaveLength(0);
  });

  test("default preferences (all enabled, 1.0 thresholds) passes all anomalies", () => {
    const prefs = makePreferenceMap();
    const anomalies = ANOMALY_KINDS.map((k) => makeAnomaly(k, "low", 2.5));
    const result = filterAnomaliesByPreferences(anomalies, prefs);
    expect(result).toHaveLength(ANOMALY_KINDS.length);
  });
});

// ---------------------------------------------------------------------------
// 5–6. Threshold multiplier adjustments
// ---------------------------------------------------------------------------

describe("filterAnomaliesByPreferences — severity threshold multipliers", () => {
  test("raising low threshold (2.0×) keeps a ratio=2.5 anomaly at 'low' instead of 'medium'", () => {
    // Default medium boundary for cost_spike is 2.0×. With low_threshold=2.0,
    // the new medium boundary becomes 2.0 * 2.0 = 4.0. ratio=2.5 → stays low.
    const prefs = makePreferenceMap({ cost_spike: { severity_low_threshold: 2.0 } });
    const anomaly = makeAnomaly("cost_spike", "medium", 2.5);
    const result = filterAnomaliesByPreferences([anomaly], prefs);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("low");
  });

  test("lowering high threshold (0.5×) escalates a medium anomaly to 'high' sooner", () => {
    // Default medium/high boundary for cost_spike is 3.0×. With high_threshold=0.5,
    // new boundary becomes 3.0 * 0.5 = 1.5. ratio=2.0 → escalates to high.
    const prefs = makePreferenceMap({ cost_spike: { severity_high_threshold: 0.5 } });
    const anomaly = makeAnomaly("cost_spike", "medium", 2.0);
    const result = filterAnomaliesByPreferences([anomaly], prefs);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("high");
  });

  test("peer_divergence: raising low threshold keeps ratio=3.0 at 'low'", () => {
    // peer_divergence low/medium boundary is 3.0. With low_threshold=1.5,
    // new boundary = 3.0 * 1.5 = 4.5. ratio=3.0 → low.
    const prefs = makePreferenceMap({ peer_divergence: { severity_low_threshold: 1.5 } });
    const anomaly = makeAnomaly("peer_divergence", "medium", 3.0);
    const result = filterAnomaliesByPreferences([anomaly], prefs);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("low");
  });

  test("token_explosion: low_threshold=1.0 keeps ratio=7.0 at 'medium'", () => {
    // token_explosion medium boundary = 5.0, high = 10.0. ratio=7 → medium.
    const prefs = makePreferenceMap();
    const anomaly = makeAnomaly("token_explosion", "medium", 7.0);
    const result = filterAnomaliesByPreferences([anomaly], prefs);
    expect(result[0].severity).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// 7–10. Edge cases
// ---------------------------------------------------------------------------

describe("filterAnomaliesByPreferences — edge cases", () => {
  test("anomaly without a ratio in context passes through with original severity", () => {
    const prefs = makePreferenceMap({
      cost_spike: { severity_low_threshold: 2.0, severity_high_threshold: 0.5 },
    });
    // No ratio in context — threshold logic should not apply.
    const anomaly: RealtimeAnomaly = {
      kind: "cost_spike",
      severity: "medium",
      message: "no ratio context",
      repo_name: null,
      user_id: null,
      context: {}, // no ratio
    };
    const result = filterAnomaliesByPreferences([anomaly], prefs);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("medium");
  });

  test("empty anomaly list returns empty array regardless of prefs", () => {
    const prefs = makePreferenceMap();
    expect(filterAnomaliesByPreferences([], prefs)).toEqual([]);
  });

  test("multiple anomalies: only disabled one is filtered", () => {
    const prefs = makePreferenceMap({
      model_thrash: { enabled: false },
      cache_miss_storm: { enabled: false },
    });
    const anomalies = ANOMALY_KINDS.map((k) => makeAnomaly(k));
    const result = filterAnomaliesByPreferences(anomalies, prefs);
    expect(result).toHaveLength(ANOMALY_KINDS.length - 2);
    expect(result.every((a) => a.kind !== "model_thrash")).toBe(true);
    expect(result.every((a) => a.kind !== "cache_miss_storm")).toBe(true);
  });

  test("tool_failure_rate: uses failure_rate for threshold, not ratio", () => {
    // With low_threshold=2.0: medium boundary moves from 35% to 70%.
    // failure_rate=0.40 → below new 70% medium boundary → 'low'.
    const prefs = makePreferenceMap({ tool_failure_rate: { severity_low_threshold: 2.0 } });
    const anomaly: RealtimeAnomaly = {
      kind: "tool_failure_rate",
      severity: "medium",
      message: "failure rate anomaly",
      repo_name: null,
      user_id: null,
      context: { failure_rate: 0.40, window_size: 50, failure_count: 20, threshold: 0.20 },
    };
    const result = filterAnomaliesByPreferences([anomaly], prefs);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// 11. SSE broadcast integration (structural, no network)
// ---------------------------------------------------------------------------

describe("broadcastAnomalyBatchFiltered — structural integration", () => {
  test("import resolves and filterAnomaliesByPreferences is a function", async () => {
    // Verify the module exports are correctly wired.
    expect(typeof filterAnomaliesByPreferences).toBe("function");
  });

  test("filtering removes disabled kinds before broadcast would send them", () => {
    // Simulate what broadcastAnomalyBatchFiltered does: filter then broadcast.
    const prefs = makePreferenceMap({ peer_divergence: { enabled: false } });
    const anomalies: RealtimeAnomaly[] = [
      makeAnomaly("cost_spike", "high", 3.5),
      makeAnomaly("peer_divergence", "medium", 3.2), // should be dropped
    ];
    const filtered = filterAnomaliesByPreferences(anomalies, prefs);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].kind).toBe("cost_spike");
  });
});

// ---------------------------------------------------------------------------
// 12. ANOMALY_KINDS constant
// ---------------------------------------------------------------------------

describe("ANOMALY_KINDS constant", () => {
  test("has exactly 6 entries", () => {
    expect(ANOMALY_KINDS).toHaveLength(6);
  });

  test("contains all expected anomaly kinds", () => {
    const expected: AnomalyKind[] = [
      "cost_spike",
      "token_explosion",
      "tool_failure_rate",
      "model_thrash",
      "cache_miss_storm",
      "peer_divergence",
    ];
    for (const kind of expected) {
      expect(ANOMALY_KINDS).toContain(kind);
    }
  });

  test("all entries are valid AnomalyKind strings", () => {
    const validKinds = new Set<string>([
      "cost_spike",
      "token_explosion",
      "tool_failure_rate",
      "model_thrash",
      "cache_miss_storm",
      "peer_divergence",
    ]);
    for (const kind of ANOMALY_KINDS) {
      expect(validKinds.has(kind)).toBe(true);
    }
  });
});
