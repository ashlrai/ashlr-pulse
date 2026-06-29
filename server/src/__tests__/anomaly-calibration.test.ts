/**
 * anomaly-calibration.test.ts
 *
 * Unit tests for anomaly severity calibration settings:
 *   1. sensitivityMultiplier() — maps levels to expected multipliers
 *   2. activeDetectorKinds()   — empty list means all six; subset works
 *   3. deriveAnomaliesWithSettings() — sensitivity levels produce different alert counts
 *   4. deriveAnomaliesWithSettings() — enabled_detector_types gates detectors
 *   5. deriveAnomaliesWithSettings() — threshold_overrides for cost_spike work
 *   6. deriveAnomaliesWithSettings() — conservative fires fewer than aggressive
 *   7. filterAnomaliesByPreferences() — disabled kind drops anomaly
 *   8. filterAnomaliesByPreferences() — custom severity thresholds adjust severity
 *   9. deriveAnomaliesWithSettings() — empty batch returns []
 *  10. Backward-compat: deriveAnomalies() still works (delegates to settings variant)
 *
 * No DB, no network — all pure functions.
 */

import { describe, expect, test } from "bun:test";
import {
  sensitivityMultiplier,
  activeDetectorKinds,
  deriveAnomalies,
  deriveAnomaliesWithSettings,
  DEFAULT_ANOMALY_SETTINGS,
  ANOMALY_KIND_VALUES,
  type AnomalyContext,
  type AnomalySettings,
  type AnomalyKind,
} from "../lib/realtime-anomaly";
import {
  filterAnomaliesByPreferences,
  type AnomalyPreferenceMap,
} from "../lib/anomaly-preference-db";
import type { FleetRealtimeEvent } from "../lib/fleet-realtime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal FleetRealtimeEvent with the given cost. */
function costEvent(cost_millicents: number, fleet_owner = "alice"): FleetRealtimeEvent {
  return {
    ts:              new Date().toISOString(),
    source:          "ashlr-fleet",
    fleet_event:     "session_end",
    fleet_outcome:   "success",
    fleet_owner,
    repo_name:       "test-repo",
    provider:        "anthropic",
    model:           "claude-sonnet-4-5",
    duration_ms:     1000,
    tokens_input:    100,
    tokens_output:   20,
    cost_millicents,
  };
}

/** Build a fleet event with a given outcome. */
function outcomeEvent(outcome: "success" | "fail"): FleetRealtimeEvent {
  return { ...costEvent(10), fleet_outcome: outcome };
}

/** Build a batch of N cost events all at the given cost. */
function costBatch(n: number, cost: number, owner = "alice"): FleetRealtimeEvent[] {
  return Array.from({ length: n }, () => costEvent(cost, owner));
}

/** Build a context with a rolling daily cost avg of `avg` over 7 days. */
function rollingContext(avg: number): AnomalyContext {
  return { rollingDailyCosts: Array(7).fill(avg) };
}

/** Default settings shorthand. */
const defaultSettings: AnomalySettings = { ...DEFAULT_ANOMALY_SETTINGS };

// ---------------------------------------------------------------------------
// 1. sensitivityMultiplier
// ---------------------------------------------------------------------------

describe("sensitivityMultiplier", () => {
  test("conservative returns 2.0", () => {
    expect(sensitivityMultiplier("conservative")).toBe(2.0);
  });

  test("moderate returns 1.0", () => {
    expect(sensitivityMultiplier("moderate")).toBe(1.0);
  });

  test("aggressive returns 0.5", () => {
    expect(sensitivityMultiplier("aggressive")).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// 2. activeDetectorKinds
// ---------------------------------------------------------------------------

describe("activeDetectorKinds", () => {
  test("empty enabled_detector_types returns all 6 kinds", () => {
    const active = activeDetectorKinds(defaultSettings);
    expect(active.size).toBe(6);
    for (const k of ANOMALY_KIND_VALUES) {
      expect(active.has(k)).toBe(true);
    }
  });

  test("non-empty enabled_detector_types returns only listed kinds", () => {
    const settings: AnomalySettings = {
      ...defaultSettings,
      enabled_detector_types: ["cost_spike", "model_thrash"],
    };
    const active = activeDetectorKinds(settings);
    expect(active.size).toBe(2);
    expect(active.has("cost_spike")).toBe(true);
    expect(active.has("model_thrash")).toBe(true);
    expect(active.has("token_explosion")).toBe(false);
  });

  test("single kind enabled returns size 1", () => {
    const settings: AnomalySettings = {
      ...defaultSettings,
      enabled_detector_types: ["peer_divergence"],
    };
    expect(activeDetectorKinds(settings).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. deriveAnomaliesWithSettings — sensitivity affects cost_spike firing
// ---------------------------------------------------------------------------

describe("deriveAnomaliesWithSettings — sensitivity levels", () => {
  // Batch cost = 200% above 7d avg (ratio 3.0). With moderate threshold 30%,
  // this fires. With conservative (threshold 60%), this fires. With aggressive
  // (threshold 15%), this also fires — so let's use a borderline ratio.
  //
  // We use ratio ≈ 1.35× avg which is:
  //   - above 1.0 + (0.30 * 1.0) = 1.30  → fires on moderate
  //   - above 1.0 + (0.30 * 0.5) = 1.15  → fires on aggressive
  //   - NOT above 1.0 + (0.30 * 2.0) = 1.60 → silent on conservative

  test("moderate fires cost_spike at 1.35× avg", () => {
    const avg = 1000;
    const batch = costBatch(1, Math.round(avg * 1.35));
    const ctx = rollingContext(avg);
    const anomalies = deriveAnomaliesWithSettings(batch, ctx, {
      ...defaultSettings,
      sensitivity_level: "moderate",
    });
    const kinds = anomalies.map((a) => a.kind);
    expect(kinds).toContain("cost_spike");
  });

  test("aggressive fires cost_spike at 1.35× avg", () => {
    const avg = 1000;
    const batch = costBatch(1, Math.round(avg * 1.35));
    const ctx = rollingContext(avg);
    const anomalies = deriveAnomaliesWithSettings(batch, ctx, {
      ...defaultSettings,
      sensitivity_level: "aggressive",
    });
    expect(anomalies.map((a) => a.kind)).toContain("cost_spike");
  });

  test("conservative is silent at 1.35× avg (threshold 60%)", () => {
    const avg = 1000;
    const batch = costBatch(1, Math.round(avg * 1.35));
    const ctx = rollingContext(avg);
    const anomalies = deriveAnomaliesWithSettings(batch, ctx, {
      ...defaultSettings,
      sensitivity_level: "conservative",
    });
    const costSpikeAnoms = anomalies.filter((a) => a.kind === "cost_spike");
    expect(costSpikeAnoms).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. enabled_detector_types gates detectors
// ---------------------------------------------------------------------------

describe("deriveAnomaliesWithSettings — enabled_detector_types", () => {
  // Use a high-cost batch that would normally trigger cost_spike.
  const avg = 1000;
  const batch = costBatch(1, avg * 5); // 5× avg → well above any threshold
  const ctx = rollingContext(avg);

  test("cost_spike fires when enabled", () => {
    const settings: AnomalySettings = {
      ...defaultSettings,
      enabled_detector_types: ["cost_spike"],
    };
    const anomalies = deriveAnomaliesWithSettings(batch, ctx, settings);
    expect(anomalies.map((a) => a.kind)).toContain("cost_spike");
  });

  test("cost_spike does NOT fire when excluded from enabled list", () => {
    const settings: AnomalySettings = {
      ...defaultSettings,
      enabled_detector_types: ["token_explosion", "model_thrash"],
    };
    const anomalies = deriveAnomaliesWithSettings(batch, ctx, settings);
    expect(anomalies.map((a) => a.kind)).not.toContain("cost_spike");
  });

  test("empty enabled list enables all detectors", () => {
    // High cost batch should trigger cost_spike with default settings.
    const anomalies = deriveAnomaliesWithSettings(batch, ctx, defaultSettings);
    expect(anomalies.map((a) => a.kind)).toContain("cost_spike");
  });
});

// ---------------------------------------------------------------------------
// 5. threshold_overrides for cost_spike
// ---------------------------------------------------------------------------

describe("deriveAnomaliesWithSettings — threshold_overrides", () => {
  test("cost_spike fires when batch cost exceeds absolute override", () => {
    const batch = costBatch(1, 500); // 500 mc batch cost
    const ctx: AnomalyContext = {}; // no rolling data needed for absolute override
    const settings: AnomalySettings = {
      ...defaultSettings,
      threshold_overrides: { cost_spike: 300 }, // override at 300 mc
    };
    const anomalies = deriveAnomaliesWithSettings(batch, ctx, settings);
    expect(anomalies.map((a) => a.kind)).toContain("cost_spike");
  });

  test("cost_spike is silent when batch cost is below absolute override", () => {
    const batch = costBatch(1, 100); // 100 mc batch cost
    const ctx: AnomalyContext = {};
    const settings: AnomalySettings = {
      ...defaultSettings,
      threshold_overrides: { cost_spike: 300 }, // override at 300 mc
    };
    const anomalies = deriveAnomaliesWithSettings(batch, ctx, settings);
    expect(anomalies.map((a) => a.kind)).not.toContain("cost_spike");
  });
});

// ---------------------------------------------------------------------------
// 6. conservative fires fewer alerts than aggressive on the same data
// ---------------------------------------------------------------------------

describe("deriveAnomaliesWithSettings — conservative vs aggressive", () => {
  // Use a borderline batch: 1.35× rolling avg — fires on aggressive/moderate, not conservative.
  test("aggressive produces >= conservative alert count on borderline data", () => {
    const avg = 1000;
    const batch = costBatch(1, Math.round(avg * 1.35));
    const ctx = rollingContext(avg);

    const conservative = deriveAnomaliesWithSettings(batch, ctx, {
      ...defaultSettings, sensitivity_level: "conservative",
    });
    const aggressive = deriveAnomaliesWithSettings(batch, ctx, {
      ...defaultSettings, sensitivity_level: "aggressive",
    });

    expect(aggressive.length).toBeGreaterThanOrEqual(conservative.length);
  });
});

// ---------------------------------------------------------------------------
// 7. filterAnomaliesByPreferences — disabled kind drops anomaly
// ---------------------------------------------------------------------------

describe("filterAnomaliesByPreferences — kind toggle", () => {
  const allDefaultPrefs: AnomalyPreferenceMap = Object.fromEntries(
    ANOMALY_KIND_VALUES.map((k) => [k, {
      kind: k,
      enabled: true,
      severity_low_threshold: 1.0,
      severity_high_threshold: 1.0,
    }]),
  ) as AnomalyPreferenceMap;

  test("disabled kind is removed from results", () => {
    const prefs: AnomalyPreferenceMap = {
      ...allDefaultPrefs,
      cost_spike: { ...allDefaultPrefs.cost_spike, enabled: false },
    };
    const anomalies = [
      { kind: "cost_spike" as AnomalyKind, severity: "high" as const, message: "test", repo_name: null, user_id: null, context: {} },
      { kind: "model_thrash" as AnomalyKind, severity: "low" as const, message: "test2", repo_name: null, user_id: null, context: {} },
    ];
    const filtered = filterAnomaliesByPreferences(anomalies, prefs);
    expect(filtered.map((a) => a.kind)).not.toContain("cost_spike");
    expect(filtered.map((a) => a.kind)).toContain("model_thrash");
  });

  test("enabled kind passes through", () => {
    const anomalies = [
      { kind: "peer_divergence" as AnomalyKind, severity: "medium" as const, message: "test", repo_name: null, user_id: null, context: { ratio: 3.5 } },
    ];
    const filtered = filterAnomaliesByPreferences(anomalies, allDefaultPrefs);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].kind).toBe("peer_divergence");
  });
});

// ---------------------------------------------------------------------------
// 8. filterAnomaliesByPreferences — custom severity thresholds adjust severity
// ---------------------------------------------------------------------------

describe("filterAnomaliesByPreferences — severity threshold adjustment", () => {
  const basePrefs: AnomalyPreferenceMap = Object.fromEntries(
    ANOMALY_KIND_VALUES.map((k) => [k, {
      kind: k,
      enabled: true,
      severity_low_threshold: 1.0,
      severity_high_threshold: 1.0,
    }]),
  ) as AnomalyPreferenceMap;

  test("raising high threshold demotes high → medium for cost_spike", () => {
    // cost_spike high boundary is ratio >= 3.0. With high_threshold = 2.0, boundary
    // becomes 3.0 * 2.0 = 6.0. A ratio of 3.5 should become medium (not high).
    const prefs: AnomalyPreferenceMap = {
      ...basePrefs,
      cost_spike: {
        ...basePrefs.cost_spike,
        severity_high_threshold: 2.0, // must reach 6.0× to be high
      },
    };
    const anomalies = [
      {
        kind: "cost_spike" as AnomalyKind,
        severity: "high" as const,
        message: "test",
        repo_name: null,
        user_id: null,
        context: { ratio: 3.5, rolling_avg_millicents: 1000, batch_cost_millicents: 3500 },
      },
    ];
    const filtered = filterAnomaliesByPreferences(anomalies, prefs);
    expect(filtered).toHaveLength(1);
    // ratio 3.5 < adjusted high boundary 6.0 → should be demoted to medium
    expect(filtered[0].severity).not.toBe("high");
  });

  test("default thresholds leave severity unchanged", () => {
    const anomalies = [
      {
        kind: "cost_spike" as AnomalyKind,
        severity: "high" as const,
        message: "test",
        repo_name: null,
        user_id: null,
        context: { ratio: 4.0 },
      },
    ];
    const filtered = filterAnomaliesByPreferences(anomalies, basePrefs);
    expect(filtered[0].severity).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// 9. Empty batch returns []
// ---------------------------------------------------------------------------

describe("deriveAnomaliesWithSettings — empty batch", () => {
  test("returns empty array for empty batch", () => {
    const result = deriveAnomaliesWithSettings([], rollingContext(1000), defaultSettings);
    expect(result).toHaveLength(0);
  });

  test("returns empty array with no context", () => {
    const result = deriveAnomaliesWithSettings([], {}, defaultSettings);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Backward-compat: deriveAnomalies delegates to settings variant
// ---------------------------------------------------------------------------

describe("deriveAnomalies — backward compatibility", () => {
  test("still detects cost_spike with default settings (same as before)", () => {
    const avg = 1000;
    const batch = costBatch(1, avg * 5); // 5× avg — well above threshold
    const ctx = rollingContext(avg);
    const result = deriveAnomalies(batch, ctx);
    expect(result.map((a) => a.kind)).toContain("cost_spike");
  });

  test("returns severity-sorted results (high before low)", () => {
    // Craft a batch that triggers both a high-severity cost spike and lower-severity anomalies.
    const avg = 1000;
    const batch = costBatch(1, avg * 5);
    const ctx = rollingContext(avg);
    const result = deriveAnomalies(batch, ctx);
    if (result.length >= 2) {
      const RANK = { high: 0, medium: 1, low: 2 };
      for (let i = 1; i < result.length; i++) {
        expect(RANK[result[i - 1].severity]).toBeLessThanOrEqual(RANK[result[i].severity]);
      }
    }
  });

  test("returns [] for empty batch", () => {
    expect(deriveAnomalies([], {})).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 11. tool_failure_rate respects sensitivity
// ---------------------------------------------------------------------------

describe("deriveAnomaliesWithSettings — tool_failure_rate sensitivity", () => {
  function failureBatch(failCount: number, total: number): FleetRealtimeEvent[] {
    return [
      ...Array.from({ length: failCount }, () => outcomeEvent("fail")),
      ...Array.from({ length: total - failCount }, () => outcomeEvent("success")),
    ];
  }

  test("25% failure rate fires on moderate (threshold 20%)", () => {
    // moderate threshold = 0.20 * 1.0 = 20% → 25% fires
    const recentEvents = failureBatch(5, 20); // 25% in 20 events
    const batch = failureBatch(3, 12);        // more context
    const ctx: AnomalyContext = { recentEvents };
    const settings: AnomalySettings = { ...defaultSettings, sensitivity_level: "moderate" };
    const result = deriveAnomaliesWithSettings(batch, ctx, settings);
    const kinds = result.map((a) => a.kind);
    expect(kinds).toContain("tool_failure_rate");
  });

  test("25% failure rate is silent on conservative (threshold 40%)", () => {
    const recentEvents = failureBatch(5, 20);
    const batch = failureBatch(3, 12);
    const ctx: AnomalyContext = { recentEvents };
    const settings: AnomalySettings = { ...defaultSettings, sensitivity_level: "conservative" };
    const result = deriveAnomaliesWithSettings(batch, ctx, settings);
    expect(result.map((a) => a.kind)).not.toContain("tool_failure_rate");
  });
});
