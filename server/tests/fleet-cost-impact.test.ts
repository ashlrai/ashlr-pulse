/**
 * fleet-cost-impact.test.ts
 *
 * Tests for the fleet cost-impact dashboard aggregation logic.
 *
 * Coverage:
 *   1. Unit: computeCostImpactFields — 3 test cases for delta + divergence logic.
 *   2. Unit: computeUserCostImpacts  — rolling window + daily bucketing.
 *   3. Unit: computeModelDrift       — drift percentage calculation.
 *   4. Unit: divergenceSeverity      — severity band mapping vs anomaly thresholds.
 *   5. SSE broadcast doesn't leak forbidden fields via cost-impact path.
 *   6. Privacy floor: CostImpactFields contains only numeric/enum — no strings
 *      that could carry user content.
 *
 * All tests are pure (no DB, no network).
 */

import { describe, it, expect } from "bun:test";
import {
  computeCostImpactFields,
  computeUserCostImpacts,
  computeModelDrift,
  divergenceSeverity,
} from "../src/lib/fleet-cost-impact";
import {
  redactForBroadcast,
  toFleetEventJSON,
} from "../src/lib/fleet-realtime";
import { FORBIDDEN_FIELDS } from "../src/lib/peer-share-guard";
import type { ActivityEventInsert } from "../src/lib/otel-genai";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeFleetRow(
  overrides: Partial<ActivityEventInsert> = {},
): ActivityEventInsert {
  return {
    ts:                          "2026-06-29T10:00:00.000Z",
    user_id:                     "user-abc",
    session_id:                  "session-xyz",
    source:                      "ashlr-fleet",
    provider:                    "claude",
    model:                       "claude-opus-4-7",
    duration_ms:                 1200,
    tokens_input:                800,
    tokens_output:               200,
    tokens_reasoning:            null,
    tokens_cache_read:           null,
    tokens_cache_write:          null,
    tokens_cache_5m_write:       null,
    tokens_cache_1h_write:       null,
    tool_calls_count:            null,
    tool_calls_types:            null,
    accepted_count:              null,
    rejected_count:              null,
    project_hash:                "abc123",
    repo_name:                   "acme/api",
    git_branch:                  "feat/my-branch",
    language:                    "TypeScript",
    tokens_saved:                null,
    tokens_saved_breakdown:      null,
    plugin_features:             null,
    plugin_version:              null,
    plugin_genome_hit_rate:      null,
    span_id:                     "deadbeef12345678",
    cost_millicents:             420,
    pricing_version:             3,
    dedup_key:                   "abc123dedup",
    fleet_event:                 "proposal",
    fleet_outcome:               "pending",
    fleet_owner:                 "mason",
    codex_plan_type:             null,
    codex_originator:            null,
    codex_parent_thread_id:      null,
    codex_cli_version:           null,
    codex_context_window:        null,
    codex_rate_limit_primary_pct: null,
    codex_rate_limit_secondary_pct: null,
    codex_sandbox_policy:        null,
    codex_approval_policy:       null,
    codex_effort:                null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. computeCostImpactFields — 3 core cases
// ---------------------------------------------------------------------------

describe("computeCostImpactFields — cost delta logic", () => {
  it("at-average: ratio = 1.0, severity = low", () => {
    const result = computeCostImpactFields(1000, 1000);
    expect(result.user_cost_millicents).toBe(1000);
    expect(result.team_avg_millicents).toBe(1000);
    expect(result.peer_divergence_ratio).toBeCloseTo(1.0, 3);
    expect(result.peer_divergence_severity).toBe("low");
  });

  it("medium divergence: user 3× team avg → severity = medium", () => {
    // 3000 mc user vs 1000 mc team avg → ratio = 3.0 ≥ 2.99 → medium
    const result = computeCostImpactFields(3000, 1000);
    expect(result.peer_divergence_ratio).toBeCloseTo(3.0, 2);
    expect(result.peer_divergence_severity).toBe("medium");
  });

  it("high divergence: user 6× team avg → severity = high", () => {
    // 6000 mc user vs 1000 mc team avg → ratio = 6.0 ≥ 4.99 → high
    const result = computeCostImpactFields(6000, 1000);
    expect(result.peer_divergence_ratio).toBeCloseTo(6.0, 2);
    expect(result.peer_divergence_severity).toBe("high");
  });

  it("zero team avg: ratio clamps to 99, severity = high", () => {
    const result = computeCostImpactFields(500, 0);
    expect(result.peer_divergence_ratio).toBe(99);
    expect(result.peer_divergence_severity).toBe("high");
  });

  it("zero user cost with non-zero team avg: ratio = 0, severity = low", () => {
    const result = computeCostImpactFields(0, 1000);
    expect(result.peer_divergence_ratio).toBeCloseTo(0, 3);
    expect(result.peer_divergence_severity).toBe("low");
  });

  it("negative inputs are clamped to 0", () => {
    const result = computeCostImpactFields(-100, -200);
    expect(result.user_cost_millicents).toBe(0);
    expect(result.team_avg_millicents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. computeUserCostImpacts — rolling window + daily buckets
// ---------------------------------------------------------------------------

describe("computeUserCostImpacts — rolling window aggregation", () => {
  it("aggregates per-user rows into 7d dailyCosts array", () => {
    const today = new Date();
    const rows = Array.from({ length: 7 }, (_, i) => {
      const dt = new Date(today.getTime() - (6 - i) * 86_400_000);
      return {
        ownerId:        "user-1",
        date:           dt.toISOString().slice(0, 10),
        costMillicents: 1000 * (i + 1),
        eventCount:     5,
        tokensTotal:    10_000,
      };
    });

    const impacts = computeUserCostImpacts(rows, 7);
    expect(impacts).toHaveLength(1);
    expect(impacts[0].userId).toBe("user-1");
    expect(impacts[0].dailyCosts).toHaveLength(7);
    // Total = 1000+2000+...+7000 = 28000
    expect(impacts[0].totalMillicents).toBe(28_000);
    // dailyAvg = 28000/7 = 4000
    expect(impacts[0].dailyAvgMillicents).toBeCloseTo(4000, 0);
  });

  it("handles missing days as zero", () => {
    const today = new Date();
    const rows = [{
      ownerId:        "user-2",
      date:           today.toISOString().slice(0, 10),
      costMillicents: 500,
      eventCount:     1,
      tokensTotal:    1000,
    }];

    const impacts = computeUserCostImpacts(rows, 7);
    expect(impacts).toHaveLength(1);
    // dailyCosts has 7 entries, most are 0
    expect(impacts[0].dailyCosts).toHaveLength(7);
    expect(impacts[0].dailyCosts.at(-1)).toBe(500);
    expect(impacts[0].dailyCosts.slice(0, -1).every((c) => c === 0)).toBe(true);
  });

  it("sorts users by totalMillicents descending", () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = [
      { ownerId: "cheap-user",     date: today, costMillicents: 100,   eventCount: 1, tokensTotal: 100 },
      { ownerId: "expensive-user", date: today, costMillicents: 10000, eventCount: 1, tokensTotal: 100 },
    ];
    const impacts = computeUserCostImpacts(rows, 7);
    expect(impacts[0].userId).toBe("expensive-user");
    expect(impacts[1].userId).toBe("cheap-user");
  });

  it("computes costPerEvent correctly", () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = [
      { ownerId: "u1", date: today, costMillicents: 2000, eventCount: 4, tokensTotal: 8000 },
    ];
    const impacts = computeUserCostImpacts(rows, 7);
    // costPerEvent = 2000 / 4 = 500
    expect(impacts[0].costPerEvent).toBe(500);
    // costPerToken = 2000 / 8000 = 0.25
    expect(impacts[0].costPerToken).toBeCloseTo(0.25, 4);
  });
});

// ---------------------------------------------------------------------------
// 3. computeModelDrift — share + drift calculation
// ---------------------------------------------------------------------------

describe("computeModelDrift — model preference drift", () => {
  it("computes share and drift for models present in both windows", () => {
    const thisWeek = [
      { model: "claude-opus-4-7",    eventCount: 70 },
      { model: "claude-sonnet-4-6",  eventCount: 30 },
    ];
    const lastWeek = [
      { model: "claude-opus-4-7",    eventCount: 40 },
      { model: "claude-sonnet-4-6",  eventCount: 60 },
    ];

    const drift = computeModelDrift(thisWeek, lastWeek);
    const opus  = drift.find((d) => d.model === "claude-opus-4-7")!;
    const sonnet = drift.find((d) => d.model === "claude-sonnet-4-6")!;

    // Opus: 70% this vs 40% last → +30pp
    expect(opus.shareThisWeek).toBeCloseTo(0.70, 2);
    expect(opus.shareLastWeek).toBeCloseTo(0.40, 2);
    expect(opus.driftPct).toBeCloseTo(30, 1);

    // Sonnet: 30% this vs 60% last → -30pp
    expect(sonnet.shareThisWeek).toBeCloseTo(0.30, 2);
    expect(sonnet.driftPct).toBeCloseTo(-30, 1);
  });

  it("handles model only in thisWeek (new model)", () => {
    const thisWeek = [{ model: "claude-haiku-4-0", eventCount: 100 }];
    const lastWeek: { model: string; eventCount: number }[] = [];
    const drift = computeModelDrift(thisWeek, lastWeek);
    const haiku = drift.find((d) => d.model === "claude-haiku-4-0")!;
    expect(haiku.shareThisWeek).toBe(1.0);
    expect(haiku.shareLastWeek).toBe(0);
    expect(haiku.driftPct).toBeCloseTo(100, 1);
  });

  it("sorts by this-week share descending", () => {
    const thisWeek = [
      { model: "b", eventCount: 20 },
      { model: "a", eventCount: 80 },
    ];
    const drift = computeModelDrift(thisWeek, []);
    expect(drift[0].model).toBe("a");
    expect(drift[1].model).toBe("b");
  });

  it("ignores empty model strings", () => {
    const thisWeek = [
      { model: "",              eventCount: 10 },
      { model: "claude-opus-4", eventCount: 90 },
    ];
    const drift = computeModelDrift(thisWeek, []);
    const models = drift.map((d) => d.model);
    expect(models).not.toContain("");
    expect(models).toContain("claude-opus-4");
  });
});

// ---------------------------------------------------------------------------
// 4. divergenceSeverity — threshold band mapping
// ---------------------------------------------------------------------------

describe("divergenceSeverity — severity band mapping", () => {
  it("ratio < 2.99 → low", () => {
    expect(divergenceSeverity(1.0)).toBe("low");
    expect(divergenceSeverity(2.5)).toBe("low");
    expect(divergenceSeverity(2.98)).toBe("low");
  });

  it("ratio 2.99–4.98 → medium", () => {
    expect(divergenceSeverity(2.99)).toBe("medium");
    expect(divergenceSeverity(3.5)).toBe("medium");
    expect(divergenceSeverity(4.98)).toBe("medium");
  });

  it("ratio >= 4.99 → high", () => {
    expect(divergenceSeverity(4.99)).toBe("high");
    expect(divergenceSeverity(10.0)).toBe("high");
    expect(divergenceSeverity(99.0)).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// 5. SSE broadcast: cost-impact fields don't leak FORBIDDEN_FIELDS
// ---------------------------------------------------------------------------

describe("SSE broadcast — cost-impact fields privacy floor", () => {
  it("broadcast payload with cost-impact fields does not expose FORBIDDEN_FIELDS", () => {
    const row = makeFleetRow({ cost_millicents: 3000 });
    const costImpact = computeCostImpactFields(3000, 1000);
    const payload = redactForBroadcast(row, costImpact);
    const payloadJSON = toFleetEventJSON(payload);
    const keys = new Set(Object.keys(payloadJSON));

    for (const forbidden of FORBIDDEN_FIELDS) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it("broadcast payload carries the cost-impact numeric fields correctly", () => {
    const row = makeFleetRow({ cost_millicents: 5000 });
    const costImpact = computeCostImpactFields(5000, 1000);
    const payload = redactForBroadcast(row, costImpact);

    expect(payload.user_cost_millicents).toBe(5000);
    expect(payload.team_avg_millicents).toBe(1000);
    expect(payload.peer_divergence_ratio).toBeCloseTo(5.0, 2);
    expect(payload.peer_divergence_severity).toBe("high");
  });

  it("broadcast payload without cost-impact has no divergence fields", () => {
    const row = makeFleetRow({ cost_millicents: 420 });
    const payload = toFleetEventJSON(redactForBroadcast(row));

    expect(payload.user_cost_millicents).toBeUndefined();
    expect(payload.team_avg_millicents).toBeUndefined();
    expect(payload.peer_divergence_ratio).toBeUndefined();
    expect(payload.peer_divergence_severity).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Privacy floor compliance — CostImpactFields carries only numbers/enums
// ---------------------------------------------------------------------------

describe("privacy floor — CostImpactFields is metadata-only", () => {
  it("all fields in CostImpactFields are numeric or a severity enum string", () => {
    const fields = computeCostImpactFields(1234, 567);

    // user_cost_millicents and team_avg_millicents must be numbers
    expect(typeof fields.user_cost_millicents).toBe("number");
    expect(typeof fields.team_avg_millicents).toBe("number");

    // peer_divergence_ratio must be a finite number
    expect(typeof fields.peer_divergence_ratio).toBe("number");
    expect(Number.isFinite(fields.peer_divergence_ratio)).toBe(true);

    // peer_divergence_severity must be one of the three known severity values
    const validSeverities = new Set(["low", "medium", "high"]);
    expect(validSeverities.has(fields.peer_divergence_severity)).toBe(true);

    // No string field value should be longer than 10 chars (enum, not content)
    for (const [key, val] of Object.entries(fields)) {
      if (typeof val === "string") {
        expect(val.length).toBeLessThanOrEqual(10);
        // The key itself must not be a forbidden meta key
        expect(["prompt","completion","code","diff","content"].includes(key)).toBe(false);
      }
    }
  });

  it("computeCostImpactFields never includes prompt/completion/code fields", () => {
    const fields = computeCostImpactFields(999, 333);
    const keys = Object.keys(fields);
    const forbidden = ["prompt", "completion", "code", "diff", "content", "source_code"];
    for (const f of forbidden) {
      expect(keys.includes(f)).toBe(false);
    }
  });
});
